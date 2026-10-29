/**
 * Meting / GD Studio 免登录聚合音源（第 4 档兜底）。
 *
 * 支持两类接口，全部免登录：
 *  1. GD Studio 风格：`?types=search&source=netease&name=<keyword>&count=n`
 *     `?types=url&source=netease&id=<id>&br=320`、`?types=lyric&source=netease&id=<lyric_id>`
 *  2. Meting 风格：`?server=netease&type=search&id=<keyword>`、
 *     `?server=netease&type=url&id=<id>`（多个公共实例可用，逗号分隔配置）
 *
 * 均可用环境变量覆盖：
 *   DSH_MUSIC_METING_API   Meting 实例列表（逗号分隔，按顺序尝试）
 *   DSH_MUSIC_GD_API       GD Studio 接口地址（置空则跳过）
 *
 * 对外只暴露「按关键词找一条可播直链」的能力：搜索 → 选最匹配 → 解析直链。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const GD_BASE = process.env.DSH_MUSIC_GD_API ?? 'https://music-api.gdstudio.xyz/api.php'

const METING_ENDPOINTS = (process.env.DSH_MUSIC_METING_API ??
  'https://api.i-meto.com/meting/api,https://api.injahow.cn/meting/,https://api.moeyao.cn/meting/')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Meting 风格接口的 server 顺序：网易云 → 腾讯 → 酷狗 → 酷我。 */
const METING_SERVERS = ['netease', 'tencent', 'kugou', 'kuwo']

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s()（）[\]【】·・.\-_/]/g, '')

function pickBest(list, want) {
  const wt = norm(want.title)
  const wa = norm(want.artist)
  let best = null
  let bestScore = -1
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    const st = norm(s.title)
    const sa = norm(s.artist)
    let score = 0
    if (st === wt) score += 10
    else if (wt && (st.includes(wt) || wt.includes(st))) score += 6
    if (wa && (sa.includes(wa) || wa.includes(sa))) score += 4
    if (!wa && sa) score += 1
    score += Math.max(0, 2 - i * 0.2)
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }
  return bestScore >= 4 ? best : null
}

async function getJson(url, signal) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
    redirect: 'follow',
    signal: signal ?? AbortSignal.timeout(8000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回了非 JSON 内容')
  }
}

const firstArtist = (author) => {
  if (Array.isArray(author)) return author.filter(Boolean).join(' / ')
  return String(author ?? '')
    .split(/[、,&/]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
}

/* ---------------- GD Studio ---------------- */

function gdUrl(params) {
  if (!GD_BASE) return ''
  const url = new URL(GD_BASE)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  return url.toString()
}

async function gdSearch(keyword, limit, signal) {
  const url = gdUrl({ types: 'search', source: 'netease', name: keyword, count: limit })
  if (!url) return []
  const body = await getJson(url, signal)
  if (!Array.isArray(body)) return []
  return body.map((s) => ({
    backend: 'meting',
    platform: 'gd',
    source: s.source ?? 'netease',
    id: String(s.url_id ?? s.id ?? ''),
    lyricId: String(s.lyric_id ?? s.url_id ?? s.id ?? ''),
    title: String(s.name ?? ''),
    artist: firstArtist(s.artist),
    album: String(s.album ?? ''),
    cover: '',
    duration: 0,
  })).filter((s) => s.id && s.title)
}

async function gdSongUrl(track, signal) {
  const url = gdUrl({ types: 'url', source: track.source ?? 'netease', id: track.id, br: 320 })
  if (!url) return ''
  const body = await getJson(url, signal)
  return typeof body?.url === 'string' ? body.url.replace(/^http:/, 'https:') : ''
}

/* ---------------- Meting 风格实例 ---------------- */

function metingUrl(base, params) {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  return url.toString()
}

function normalizeMetingItem(item, server) {
  return {
    backend: 'meting',
    platform: 'meting',
    source: server,
    id: String(item.id ?? item.url_id ?? ''),
    title: String(item.title ?? item.name ?? ''),
    artist: firstArtist(item.author ?? item.artist),
    album: String(item.album ?? ''),
    cover: String(item.pic ?? ''),
    duration: Number(item.duration ?? 0) || 0,
    url: typeof item.url === 'string' ? item.url.replace(/^http:/, 'https:') : '',
  }
}

async function metingSearch(base, server, keyword, signal) {
  const body = await getJson(metingUrl(base, { server, type: 'search', id: keyword }), signal)
  const list = Array.isArray(body) ? body : []
  return list.map((item) => normalizeMetingItem(item, server)).filter((s) => s.title)
}

/**
 * 第 4 档：按歌名/歌手关键词向聚合平台要一条可播直链。
 * 所有候选源并发尝试，谁先给出直链用谁；全部失败返回 `{ url: '' }`。
 * @param {{title?: string, artist?: string, album?: string}} identity
 * @param {{signal?: AbortSignal, limit?: number}} [options]
 * @returns {Promise<{url: string, track?: object, br: number, source: string, title?: string, artist?: string, cover?: string}>}
 */
export async function resolveByKeyword(identity = {}, { signal, limit = 12 } = {}) {
  const keyword = [identity.title, identity.artist].filter(Boolean).join(' ').trim()
  if (!keyword) return { url: '', br: 0, source: '' }

  const attempts = []

  // GD Studio：一次搜索即拿到候选，再按候选逐个取直链（通常第一个就命中）
  if (GD_BASE) {
    attempts.push((async () => {
      const list = await gdSearch(keyword, limit, signal)
      const best = pickBest(list, { title: identity.title ?? keyword, artist: identity.artist ?? '' })
      const ordered = best ? [best, ...list.filter((x) => x !== best)] : list
      for (const track of ordered.slice(0, 3)) {
        const url = await gdSongUrl(track, signal)
        if (url) return { url, track, source: 'gd:netease', br: 320000 }
      }
      return null
    })())
  }

  // Meting 风格实例（多平台）
  for (const base of METING_ENDPOINTS) {
    for (const server of METING_SERVERS) {
      attempts.push((async () => {
        const list = await metingSearch(base, server, keyword, signal)
        if (!list.length) return null
        const best = pickBest(list, { title: identity.title ?? keyword, artist: identity.artist ?? '' })
        const ordered = best ? [best, ...list.filter((x) => x !== best)] : list
        for (const item of ordered.slice(0, 2)) {
          if (item.url) {
            const probe = await fetch(item.url, { method: 'HEAD', redirect: 'follow', signal: signal ?? AbortSignal.timeout(8000) }).catch(() => null)
            if (!probe || probe.status < 400) return { url: item.url, track: item, source: `meting:${server}`, br: 0 }
            continue
          }
          if (item.id) {
            const body = await getJson(metingUrl(base, { server, type: 'url', id: item.id }), signal).catch(() => null)
            const url = typeof body?.url === 'string' ? body.url.replace(/^http:/, 'https:') : ''
            if (url) return { url, track: item, source: `meting:${server}`, br: 0 }
          }
        }
        return null
      })())
    }
  }

  const settled = await Promise.allSettled(attempts)
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.url) return r.value
  }
  return { url: '', br: 0, source: '' }
}

/** 第 4 档命中后的歌词（GD 优先，其次按平台原生接口）。 */
export async function lyric(track, { signal } = {}) {
  if (!track || track.platform !== 'gd' || !GD_BASE) return { lrc: '' }
  try {
    const body = await getJson(gdUrl({ types: 'lyric', source: track.source ?? 'netease', id: track.lyricId ?? track.id }), signal)
    return { lrc: typeof body?.lyric === 'string' ? body.lyric : '', tlrc: typeof body?.tlyric === 'string' ? body.tlyric : '' }
  } catch {
    return { lrc: '' }
  }
}

export default { id: 'meting', label: 'Meting 聚合', resolveByKeyword, lyric }
