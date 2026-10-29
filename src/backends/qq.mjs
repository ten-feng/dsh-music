/**
 * QQ 音乐后端（公开 Web 接口，免登录）。
 * 搜索 / 歌词 / 封面（由 album mid 构造）全可用；播放直链接口
 * （vkey.GetVkeyServerBaseCgi）对无签名请求通常返回空 purl——带用户自己的
 * QQ 音乐 Cookie（环境变量 DSH_MUSIC_QQ_COOKIE）时免费歌曲有机会直链成功。
 * purl 为空时宿主返回 url:''，卡片提示并降级（默认引导跨后端到网易云播放）。
 */

const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Referer': 'https://y.qq.com/portal/player.html',
}

const cookie = () => process.env.DSH_MUSIC_QQ_COOKIE ?? ''

/** musicu.fcg：GET data=（<400B）或 POST JSON。 */
async function musicu(payload) {
  const body = JSON.stringify(payload)
  const url = body.length < 380
    ? `${MUSICU}?g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&data=${encodeURIComponent(body)}`
    : `${MUSICU}?format=json&g_tk=5381&loginUin=0`
  const res = await fetch(url, {
    method: body.length < 380 ? 'GET' : 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', Cookie: cookie() },
    ...(body.length < 380 ? {} : { body }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`qq musicu → HTTP ${res.status}`)
  return res.json()
}

const httpsify = (u) => (typeof u === 'string' ? u.replace(/^http:/, 'https:') : u)
const coverOf = (albumMid) => (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '')

/** 搜索 → 规范化曲目。 */
export async function search(q, limit = 12) {
  const data = await musicu({
    'music.search.SearchCgiService': {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: { query: q, num_per_page: Math.min(limit, 40), page_num: 1, search_type: 0 },
    },
  })
  const list = data?.['music.search.SearchCgiService']?.data?.body?.song?.list ?? []
  return list.map((s) => ({
    backend: 'qq',
    id: String(s.id ?? ''),
    mid: s.mid ?? '',
    title: s.name ?? '未知曲目',
    artist: (s.singer ?? []).map((a) => a.name).filter(Boolean).join(' / ') ?? '',
    album: s.album?.name ?? '',
    cover: coverOf(s.album?.mid),
    duration: (Number(s.interval) || 0) * 1000,
  }))
}

/** 播放直链（尽力而为）+ 封面确认。url 为空 = 不可直链。 */
export async function song(id, hint = {}) {
  const mid = hint.mid ?? ''
  let url = ''
  if (mid) {
    const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000)
    try {
      const data = await musicu({
        req: {
          module: 'vkey.GetVkeyServerBaseCgi',
          method: 'CgiGetVkey',
          param: { guid, songmid: [mid], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
        },
      })
      const info = data?.req?.data?.midurlinfo?.[0]
      url = httpsify(info?.purl) ?? ''
      if (url) url = (data?.req?.data?.sip?.[0] ?? 'https://dl.stream.qqmusic.qq.com/').replace(/^http:/, 'https:') + info.purl.replace(/^https?:\/\/[^/]+\//, '')
    } catch { /* 直链失败不阻断元数据 */ }
  }
  return {
    url,
    br: url ? 128000 : 0,
    cover: hint.cover ?? '',
    title: hint.title ?? '',
    artist: hint.artist ?? '',
    album: hint.album ?? '',
    duration: hint.duration ?? 0,
  }
}

/** LRC 歌词（base64 解码；无歌词返回空串）。 */
export async function lyric(_id, hint = {}) {
  const mid = hint.mid ?? ''
  if (!mid) return { lrc: '' }
  const res = await fetch(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${mid}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
    { headers: HEADERS, signal: AbortSignal.timeout(10000) },
  )
  if (!res.ok) return { lrc: '' }
  const data = await res.json().catch(() => null)
  let lrc = ''
  if (data?.lyric) {
    try { lrc = Buffer.from(data.lyric, 'base64').toString('utf8') } catch { lrc = '' }
  }
  return { lrc }
}

export default { id: 'qq', label: 'QQ 音乐', search, song, lyric }
