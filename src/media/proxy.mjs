/**
 * 同源音频代理。
 *
 * 第 4 档 Meting 解析出来的直链来自第三方聚合站/CDN，直接放进 <audio> 会受
 * CORS、Referer 防盗链、混合内容影响；QQ / 网易云的直链也常带时效签名。
 * 这里统一把音频流经宿主代理输出：
 *
 *   解析结果 → 宿主登记一个一次性 token → 浏览器播放
 *   `/plugins/dsh-music/api/stream/<token>` → 宿主回源拉流（支持 Range 拖动）
 *
 * token 只在本进程内有效，10 分钟过期，避免把代理做成任意 URL 转发器。
 */

import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

const TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 300

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const HOST_HEADERS = {
  netease: { Referer: 'https://music.163.com/', 'User-Agent': UA },
  qq: { Referer: 'https://y.qq.com/', 'User-Agent': UA },
  meting: { 'User-Agent': UA },
}

export function createStreamProxy({ streamPath, logger } = {}) {
  const entries = new Map()

  const sweep = () => {
    const now = Date.now()
    for (const [token, entry] of entries) {
      if (now - entry.at > TOKEN_TTL_MS) entries.delete(token)
    }
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
  }

  /** 登记一个音频地址，返回浏览器可播放的同源路径。 */
  function register(url, { backend = 'meting' } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return ''
    sweep()
    const token = randomUUID()
    entries.set(token, { url, backend, at: Date.now() })
    return `${streamPath}/${token}`
  }

  /** 处理 `/plugins/dsh-music/api/stream/<token>`。 */
  async function handle(req, res, token) {
    sweep()
    const entry = entries.get(token)
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('音频链接已失效，请重新播放')
      return
    }

    const headers = { ...(HOST_HEADERS[entry.backend] ?? HOST_HEADERS.meting) }
    const range = req.headers.range
    if (typeof range === 'string' && range) headers.Range = range

    let upstream
    // 超时只约束「回源响应头」阶段：拿到响应头后必须放行整个音频流，
    // 否则 AbortSignal.timeout 会在几十秒后把正在播放的流掐断（只响一小段就停）。
    const controller = new AbortController()
    const headerTimer = setTimeout(() => controller.abort(), 15000)
    try {
      upstream = await fetch(entry.url, { headers, redirect: 'follow', signal: controller.signal })
    } catch (error) {
      logger?.warn?.(`[dsh-music] 音频回源失败：${error instanceof Error ? error.message : String(error)}`)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('音频回源失败')
      return
    } finally {
      clearTimeout(headerTimer)
    }

    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`音频回源返回 ${upstream.status}`)
      return
    }

    const out = {
      'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
      'accept-ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
      'cache-control': 'no-store',
    }
    const len = upstream.headers.get('content-length')
    const crange = upstream.headers.get('content-range')
    if (len) out['content-length'] = len
    if (crange) out['content-range'] = crange
    res.writeHead(upstream.status, out)

    if (req.method === 'HEAD' || !upstream.body) {
      res.end()
      return
    }

    const source = Readable.fromWeb(upstream.body)
    res.on('close', () => source.destroy())
    try {
      await pipeline(source, res)
    } catch {
      res.destroy()
    }
  }

  return { register, handle }
}
