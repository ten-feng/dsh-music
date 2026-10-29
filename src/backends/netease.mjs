/**
 * 网易云音乐后端（公开 Web 接口）。
 *
 * 同一个模块服务两个音源档位，**只切换 Cookie 来源**，不复制取链逻辑：
 *   - 会员档：Cookie 来自本机扫码登录（~/.dsh/music-cookie.json）
 *   - 免费档：匿名 Cookie（appver=2.9.7，可用 DSH_MUSIC_NETEASE_COOKIE 覆盖）
 *
 * 搜索 / 歌曲详情（封面）/ 播放直链 / 歌词都接受 `{ cookie }` 选项。
 */

const BASE = 'https://music.163.com'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Referer': 'https://music.163.com/',
  'Origin': 'https://music.163.com',
}

/** 匿名 / 免费档 Cookie：无 Cookie 也能给免费歌曲 320k 直链。 */
export const FREE_COOKIE = process.env.DSH_MUSIC_NETEASE_COOKIE ?? 'appver=2.9.7'

async function api(path, { cookie = '', signal } = {}) {
  const res = await fetch(BASE + path, {
    headers: { ...HEADERS, Cookie: cookie || FREE_COOKIE },
    signal: signal ?? AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`netease ${path} → HTTP ${res.status}`)
  return res.json()
}

const httpsify = (u) => (typeof u === 'string' ? u.replace(/^http:/, 'https:') : u)

/** 搜索 → 规范化曲目（封面常为空，播放前由 song() 补齐）。 */
export async function search(q, limit = 12, { cookie = '', signal } = {}) {
  const data = await api(`/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&limit=${limit}`, { cookie, signal })
  const songs = data?.result?.songs ?? []
  return songs.map((s) => ({
    backend: 'netease',
    id: String(s.id),
    title: s.name ?? '未知曲目',
    artist: (s.artists ?? []).map((a) => a.name).filter(Boolean).join(' / ') ?? '',
    album: s.album?.name ?? '',
    cover: httpsify(s.album?.picUrl) ?? '',
    duration: Number(s.duration) || 0,
  }))
}

/**
 * 播放直链 + 封面补齐。url 为空 = 该 Cookie 档位拿不到（VIP / 版权 / 下架）。
 * @param {string} id
 * @param {object} hint
 * @param {{cookie?: string, signal?: AbortSignal, br?: number}} [options]
 */
export async function song(id, hint = {}, { cookie = '', signal, br = 320000 } = {}) {
  const [urlData, detail] = await Promise.all([
    api(`/api/song/enhance/player/url?ids=[${id}]&br=${br}`, { cookie, signal }).catch(() => null),
    api(`/api/song/detail/?id=${id}&ids=[${id}]`, { cookie, signal }).catch(() => null),
  ])
  const info = urlData?.data?.[0]
  const meta = detail?.songs?.[0]
  const cover = httpsify(meta?.album?.picUrl) ?? hint.cover ?? ''
  return {
    url: httpsify(info?.url) ?? '',
    br: info?.br ?? 0,
    fee: info?.fee ?? 0,
    cover,
    title: meta?.name ?? hint.title ?? '',
    artist: (meta?.artists ?? []).map((a) => a.name).join(' / ') || hint.artist || '',
    album: meta?.album?.name ?? hint.album ?? '',
    duration: Number(meta?.duration) || hint.duration || 0,
  }
}

/** LRC 歌词 + 翻译（无则空串）。 */
export async function lyric(id, _hint = {}, { cookie = '', signal } = {}) {
  const data = await api(`/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, { cookie, signal })
  return { lrc: data?.lrc?.lyric ?? '', tlrc: data?.tlyric?.lyric ?? '' }
}

export default { id: 'netease', label: '网易云', FREE_COOKIE, search, song, lyric }
