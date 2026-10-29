/**
 * dsh-music 宿主半区（node half）：一个 Cordis 插件。
 *
 * - 向 system prompt 注入 `dsh-music` 围栏契约（精简版，完整规范在 music skill）；
 * - 注册 `music` skill（bundled 优先级，SKILL.md 随包分发）；
 * - 通过宿主 webServer 注册 `/plugins/dsh-music/api` 路由：
 *   搜索 / 播放直链 / 歌词 / 网易云扫码登录 / 同源音频代理。
 *
 * 播放直链按「四档瀑布」解析（见 src/media/resolve.mjs）：
 *   网易云会员（登录后）→ 网易云免费（匿名）→ QQ 免费库 → Meting 聚合兜底。
 * 卡片仍通过同一个 `song` 端点取链，浏览器侧渲染/共享播放状态机制保持不变。
 * @module dsh-music
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import netease from './src/backends/netease.mjs'
import qq from './src/backends/qq.mjs'
import meting from './src/backends/meting.mjs'
import { createCookieStore, DEFAULT_COOKIE_FILE } from './src/auth/cookie-store.mjs'
import { createQrLogin, checkQrLogin, fetchAccount } from './src/auth/netease-qr.mjs'
import { createResolver, TIER_LABEL } from './src/media/resolve.mjs'
import { createStreamProxy } from './src/media/proxy.mjs'

const BACKENDS = { netease, qq }
const API_ROUTE = '/plugins/dsh-music/api'
const STREAM_PATH = `${API_ROUTE}/stream`

/* ---------------- system prompt 围栏契约（精简版） ---------------- */

export const FENCE_SECTION_TEXT = `你可以用 \`dsh-music\` 围栏把歌送进**右下角悬浮播放器窗口**——用户想听歌、找歌、要歌单、分享正在听的音乐时优先使用（对话里不再渲染卡片，围栏只负责驱动悬浮窗）：

\`\`\`dsh-music
{"theme":"glass","backend":"netease","keyword":"周杰伦 晴天","autoplay":true}
\`\`\`

字段（完整规范见 music skill）：
- \`theme\`：\`glass\` 玻璃拟态+悬浮歌词气泡（默认）｜ \`neon\` 霓虹｜ \`paper\` 纸感｜ \`vapor\` 蒸汽波；或自定义对象 \`{"accent":"#8b5cf6","bubbles":true,"coverBlur":true}\`
- \`backend\`：\`netease\` 网易云（播放能力最强）｜ \`qq\` QQ 音乐（搜索/歌词，VIP 外的歌曲常无法直链，卡片会自动跨后端降级）
- \`keyword\`：初始搜索词，通常是「歌手 歌名」或歌单主题（如「深夜 lo-fi」「粤语经典」）
- \`playlist\`：可选，直接给曲目数组；**曲目不必带 id**，卡片会自动搜索解析：\`[{"title":"晴天","artist":"周杰伦"},{"title":"红豆","artist":"王菲"}]\`
- \`autoplay\`：用户明确要"播放"才 \`true\`，默认 \`false\`
- \`lyricMode\`：\`bubble\` 悬浮歌词气泡（默认）｜ \`bar\` 内嵌歌词栏｜ \`none\`
- \`title\`：卡片标题（如「深夜电台」「你的 2025 年度歌单」）

Rules:
- 围栏 JSON 必须合法；一段回复**最多一个** \`dsh-music\` 围栏，放在回复末尾；围栏后不要再用文字描述播放器里的操作按钮。
- LOCAL-FIRST：搜索、切歌、换主题、切后端都在卡片内完成，零往返；只有用户要求"推荐歌单/找类似的歌"时，你才回一个新的 \`dsh-music\` 围栏（给 playlist 或 keyword）。
- 不索取账号、密码、Cookie；VIP/版权导致的播放失败由卡片自行提示与降级，不要向用户道歉复述。`

/* ---------------- music skill（bundled provider） ---------------- */

const BUNDLED_SKILL_RANK = 600
const BUNDLED_SKILL_PROVIDER = 'dsh-music'
const BUNDLED_SKILL_NAME = 'music'
const BUNDLED_SKILL_DESCRIPTION = '音乐播放器卡片完整规范：dsh-music 围栏字段、主题、曲目 playlist 写法与行为准则。'
const BUNDLED_SKILL_INVOCATION = { modelInvocable: true, userInvocable: true }

function skillEntry(path, content) {
  return {
    name: BUNDLED_SKILL_NAME,
    description: BUNDLED_SKILL_DESCRIPTION,
    invocation: BUNDLED_SKILL_INVOCATION,
    source: 'bundled',
    provider: BUNDLED_SKILL_PROVIDER,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    rank: BUNDLED_SKILL_RANK,
    locator: path,
    ...(content === undefined ? {} : { content }),
  }
}

function bundledSkillProvider() {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'SKILL.md')
  const raw = readFileSync(path, 'utf8')
  const end = raw.indexOf('\n---\n', 4)
  if (!raw.startsWith('---\n') || end < 0) throw new Error('dsh-music SKILL.md has invalid frontmatter')
  const body = raw.slice(end + 5)
  return {
    name: BUNDLED_SKILL_PROVIDER,
    list: () => Promise.resolve([skillEntry(path)]),
    get: () => Promise.resolve(skillEntry(path, body)),
  }
}

/* ---------------- 路由工具 ---------------- */

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/* ---------------- apply ---------------- */

export const inject = ['systemPrompt']

/**
 * 注册围栏区段、music skill、扫码登录与四档瀑布 API 路由。
 * @param ctx - cordis context。
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'music:fence',
    order: ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
    text: FENCE_SECTION_TEXT,
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.registerProvider(bundledSkillProvider)
  })

  // 登录态与音频代理是进程内单例（插件重载会重建；登录态本身在磁盘上）
  const cookieStore = createCookieStore({
    file: process.env.DSH_MUSIC_COOKIE_FILE || DEFAULT_COOKIE_FILE,
  })
  const resolver = createResolver({ cookieStore, logger: ctx.logger })
  const proxy = createStreamProxy({ streamPath: STREAM_PATH, logger: ctx.logger })

  // 同一张二维码的轮询要沿用服务端陆续下发的设备 Cookie
  const qrSessions = new Map()
  const QR_SESSION_TTL = 5 * 60 * 1000
  const sweepQr = () => {
    for (const [k, v] of qrSessions) if (Date.now() - v.at > QR_SESSION_TTL) qrSessions.delete(k)
  }
  const rememberQr = (key, cookie) => {
    if (!key) return
    sweepQr()
    qrSessions.set(key, { cookie, at: Date.now() })
  }
  const recallQr = (key) => {
    sweepQr()
    return qrSessions.get(key)?.cookie ?? ''
  }

  async function accountPayload({ signal } = {}) {
    const state = cookieStore.state()
    const base = { loggedIn: false, cookieSource: state.source, hasCookie: Boolean(state.cookie), savedAt: state.savedAt }
    if (!state.cookie) return base
    const info = await fetchAccount(state.cookie, { signal })
    if (!info) return { ...base, loggedIn: true, nickname: state.nickname || '', userId: state.userId || '', unknown: true }
    return {
      ...base,
      loggedIn: true,
      nickname: info.nickname,
      userId: info.userId != null ? String(info.userId) : '',
      avatar: info.avatar,
      vipType: info.vipType,
    }
  }

  async function handleApi(req, res) {
    let pathname
    let query
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      pathname = url.pathname
      query = url.searchParams
    } catch {
      json(res, 400, { error: 'bad url' })
      return
    }
    if (!pathname.startsWith(`${API_ROUTE}/`)) {
      json(res, 404, { error: 'not found' })
      return
    }
    const endpoint = pathname.slice(API_ROUTE.length + 1)

    try {
      /* ---- 音频代理 ---- */
      if (endpoint.startsWith('stream/')) {
        await proxy.handle(req, res, endpoint.slice('stream/'.length))
        return
      }

      switch (endpoint) {
        case 'health': {
          const state = cookieStore.state()
          json(res, 200, {
            ok: true,
            loggedIn: state.loggedIn,
            backends: Object.values(BACKENDS).map((m) => ({ id: m.id, label: m.label })),
            tiers: Object.entries(TIER_LABEL).map(([id, label]) => ({ id, label })),
          })
          return
        }

        /* ---- 账号 / 扫码登录 ---- */
        case 'account': {
          json(res, 200, await accountPayload())
          return
        }
        case 'login/qr/create': {
          const qr = await createQrLogin()
          // 设备 Cookie（NMTID 等）是本张二维码会话的一部分，后续轮询必须带上
          rememberQr(qr.key, qr.cookie ?? '')
          json(res, 200, qr)
          return
        }
        case 'login/qr/check': {
          const key = query.get('key') ?? ''
          if (!key) return json(res, 400, { error: '缺少 key' })
          const result = await checkQrLogin(key, { deviceCookie: recallQr(key) })
          if (result.code === 803) {
            qrSessions.delete(key)
            const info = result.cookie ? await fetchAccount(result.cookie) : null
            // 正常情况下 803 会带 MUSIC_U；个别账号只回其它登录票据，
            // 只要查询账号成功就认为登录有效，避免误判失败。
            if (!result.hasMusicU && !info) {
              const seen = result.cookieKeys?.length ? `（已获得 Cookie：${result.cookieKeys.join(', ')}）` : '（未获得任何 Cookie）'
              return json(res, 200, {
                code: 803,
                ok: false,
                message: `授权成功但未取到登录票据，请重新扫码${seen}`,
              })
            }
            const written = cookieStore.write(result.cookie, {
              nickname: info?.nickname ?? '',
              userId: info?.userId ?? '',
            })
            if (!written.ok) {
              return json(res, 200, { code: 803, ok: false, message: `登录态写入失败：${written.error}` })
            }
            return json(res, 200, {
              code: 803,
              ok: true,
              message: '登录成功',
              account: { nickname: info?.nickname ?? '', userId: info?.userId != null ? String(info.userId) : '' },
            })
          }
          rememberQr(key, result.cookie)
          json(res, 200, { code: result.code, ok: false, message: result.message })
          return
        }
        case 'logout': {
          const written = cookieStore.write('')
          qrSessions.clear()
          if (!written.ok) return json(res, 500, { error: `登录态清除失败：${written.error}` })
          json(res, 200, { ok: true, loggedIn: false })
          return
        }

        /* ---- 搜索 / 直链 / 歌词 ---- */
        case 'search': {
          const q = (query.get('q') ?? '').trim()
          if (!q) return json(res, 400, { error: '缺少搜索词 q' })
          const id = query.get('backend') ?? 'netease'
          // Meting 也可作为搜索源（按关键词返回候选，用于卡片内搜索）
          if (id === 'meting') {
            const hit = await meting.resolveByKeyword({ title: q, artist: '' }, { limit: Math.min(Number(query.get('limit')) || 12, 30) })
            const songs = hit.track
              ? [{
                backend: 'meting',
                id: hit.track.id,
                title: hit.track.title,
                artist: hit.track.artist,
                album: hit.track.album,
                cover: hit.track.cover,
                duration: 0,
              }]
              : []
            return json(res, 200, { songs, backend: 'meting', label: meting.label })
          }
          const mod = BACKENDS[id]
          if (!mod) return json(res, 400, { error: `未知后端，可用：${Object.keys(BACKENDS).join(' / ')}` })
          const songs = await mod.search(q, Math.min(Number(query.get('limit')) || 12, 30))
          json(res, 200, { songs, backend: mod.id, label: mod.label })
          return
        }
        case 'song': {
          const { track } = await readBody(req)
          const song = await resolver.resolve(track)
          if (!song.url) {
            json(res, 200, { song: { ...song, url: '' } })
            return
          }
          const proxied = proxy.register(song.url, {
            backend: song.backend === 'qq' ? 'qq' : song.backend === 'meting' ? 'meting' : 'netease',
          })
          json(res, 200, {
            song: {
              ...song,
              rawUrl: song.url,
              url: proxied || song.url,
            },
          })
          return
        }
        case 'lyric': {
          const { track } = await readBody(req)
          if (track?.backend === 'meting') {
            const r = await meting.lyric(track.metingTrack ?? { platform: 'gd', source: 'netease', id: track.id })
            return json(res, 200, { lrc: r?.lrc ?? '', tlrc: r?.tlrc ?? '' })
          }
          const mod = BACKENDS[track?.backend]
          if (!mod) return json(res, 400, { error: '未知后端' })
          const cookie = cookieStore.state().cookie
          const r = await mod.lyric(track.id, track, cookie ? { cookie } : {})
          json(res, 200, { lrc: r?.lrc ?? '', tlrc: r?.tlrc ?? '' })
          return
        }
        default:
          json(res, 404, { error: `unknown endpoint ${endpoint}` })
      }
    } catch (err) {
      if (!res.headersSent) json(res, 502, { error: err instanceof Error ? err.message : String(err) })
      else res.destroy()
    }
  }

  // 与 dsh-genui 一致：webServer 是可选服务，依赖 fiber 持有路由注册，
  // 跟随 webServer 的晚绑定 / 替换 / 插件重载。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.reflect.get('webServer')
    webCtx.effect(
      () => webServer.register({ kind: 'prefix', path: API_ROUTE, handler: handleApi }),
      'dsh-music: api route',
    )
  })
}
