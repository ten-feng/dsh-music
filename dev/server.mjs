// dsh-music 预览服务器：模拟宿主的 /plugins/dsh-music/api 路由。
// 优先调用真实后端（和生产同一份代码），失败或 q 带 "demo " 前缀时用 fixtures。
//   node dev/server.mjs   → http://127.0.0.1:4531/preview.html?spec=glass
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import netease from '../src/backends/netease.mjs'
import qq from '../src/backends/qq.mjs'
import { createCookieStore } from '../src/auth/cookie-store.mjs'
import { createResolver, TIER_LABEL } from '../src/media/resolve.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIX = join(ROOT, 'dev', 'fixtures')
const PORT = 4531

const cookieStore = createCookieStore()
const resolver = createResolver({ cookieStore })

const DEMO_SONGS = [
  { backend: 'netease', id: 'd1', title: '晴天（预览版）', artist: '气泡合唱团', album: '玻璃之夜', cover: '/fixtures/cover1.svg', duration: 40000 },
  { backend: 'netease', id: 'd2', title: '红豆（预览版）', artist: '悬浮灯乐队', album: '玻璃之夜', cover: '/fixtures/cover2.svg', duration: 40000 },
  { backend: 'netease', id: 'd3', title: 'Lemon（预览版）', artist: '星尘三重奏', album: '夜航西飞', cover: '/fixtures/cover3.svg', duration: 40000 },
  { backend: 'netease', id: 'd4', title: '夜曲（预览版）', artist: '气泡合唱团', album: '十一月的雨', cover: '/fixtures/cover4.svg', duration: 40000 },
  { backend: 'netease', id: 'd5', title: 'Fly Me To The Moon（预览版）', artist: '悬浮灯乐队', album: '夜航西飞', cover: '/fixtures/cover5.svg', duration: 40000 },
  { backend: 'netease', id: 'd6', title: 'City Of Stars（预览版）', artist: '星尘三重奏', album: '午夜电台', cover: '/fixtures/cover6.svg', duration: 40000 },
]

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = async (req) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

const isDemo = (q) => /^demo\b/i.test(q ?? '')

async function handleApi(req, res, url) {
  const ep = url.pathname.replace('/plugins/dsh-music/api/', '')
  try {
    if (ep === 'health') {
      return json(res, 200, {
        ok: true,
        backends: [{ id: 'netease', label: '网易云' }, { id: 'qq', label: 'QQ 音乐' }],
        tiers: Object.entries(TIER_LABEL).map(([id, label]) => ({ id, label })),
      })
    }
    if (ep === 'search') {
      const q = url.searchParams.get('q') ?? ''
      if (isDemo(q)) return json(res, 200, { songs: DEMO_SONGS, demo: true })
      const mod = url.searchParams.get('backend') === 'qq' ? qq : netease
      try {
        const songs = await mod.search(q, Math.min(Number(url.searchParams.get('limit')) || 12, 30))
        if (songs.length) return json(res, 200, { songs })
        throw new Error('空结果')
      } catch (err) {
        // 真实接口不可达 → fixtures 兜底，保证预览可看
        return json(res, 200, { songs: DEMO_SONGS, fallback: String(err.message ?? err) })
      }
    }
    if (ep === 'song') {
      const { track } = await readBody(req)
      if (String(track?.id ?? '').startsWith('d') || isDemo(track?.title)) {
        return json(res, 200, { song: { url: '/fixtures/tone.wav', br: 320000, cover: track.cover, title: track.title, artist: track.artist, album: track.album, duration: 40000 } })
      }
      // 与宿主一致的「四档瀑布」；预览服务器不做音频代理，直接返回原始直链
      try {
        const song = await resolver.resolve(track)
        if (song.url) return json(res, 200, { song })
        throw new Error('四档音源均未取到直链')
      } catch (err) {
        return json(res, 200, { song: { url: '/fixtures/tone.wav', br: 0, cover: track.cover, title: track.title, artist: track.artist, album: track.album, duration: 40000 }, fallback: String(err.message ?? err) })
      }
    }
    if (ep === 'lyric') {
      const { track } = await readBody(req)
      if (String(track?.id ?? '').startsWith('d') || isDemo(track?.title)) {
        return json(res, 200, { lrc: await readFile(join(FIX, 'demo.lrc'), 'utf8'), tlrc: '' })
      }
      const mod = track?.backend === 'qq' ? qq : netease
      try {
        const r = await mod.lyric(track.id, track)
        return json(res, 200, { lrc: r.lrc ?? '', tlrc: r.tlrc ?? '' })
      } catch {
        return json(res, 200, { lrc: '', tlrc: '' })
      }
    }
    json(res, 404, { error: `unknown ${ep}` })
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) })
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.css': 'text/css; charset=utf-8' }

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = decodeURIComponent(url.pathname)
  if (path.startsWith('/plugins/dsh-music/api/')) return handleApi(req, res, url)
  let file = path === '/' || path === '/preview.html' ? join(ROOT, 'dev', 'preview.html')
    : path === '/client.js' ? join(ROOT, 'client.js')
    : path.startsWith('/fixtures/') ? join(FIX, normalize(path.slice(10)))
    : null
  if (!file) { res.writeHead(404); return res.end('not found') }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => console.log(`preview → http://127.0.0.1:${PORT}/preview.html?spec=glass`))
