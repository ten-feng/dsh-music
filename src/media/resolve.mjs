/**
 * 音源优先级：四档瀑布。
 *
 *   1. 网易云会员直链   仅在本机扫码已登录时启用；未登录直接静默跳过
 *   2. 网易云免费直链   匿名 Cookie，始终可用
 *   3. QQ 音乐免费库    免登录尽力而为（拿不到直链是常态）
 *   4. Meting 聚合      GD Studio / Meting 实例，按歌名+歌手搜索后解析
 *
 * 前两档复用同一个 `netease.song()`，只切换 Cookie 来源。
 * 四档全失败才返回 url:''，由卡片标记「不可播」并自动跳下一曲。
 */

import neteaseBackend from '../backends/netease.mjs'
import qqBackend from '../backends/qq.mjs'
import metingBackend from '../backends/meting.mjs'

export const TIER = {
  NETEASE_VIP: 'netease-vip',
  NETEASE_FREE: 'netease-free',
  QQ: 'qq',
  METING: 'meting',
}

export const TIER_LABEL = {
  [TIER.NETEASE_VIP]: '网易云会员',
  [TIER.NETEASE_FREE]: '网易云免费',
  [TIER.QQ]: 'QQ 音乐',
  [TIER.METING]: 'Meting 兜底',
}

const ID_CACHE_MS = 10 * 60 * 1000
const RESOLVE_CACHE_MS = 60 * 1000

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')

/** 在候选列表里挑最匹配的一首（歌名优先，歌手加权）。 */
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
  return bestScore >= 5 ? best : (list[0] ?? null)
}

function createCache() {
  const map = new Map()
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return undefined
      if (Date.now() - hit.at > hit.ttl) {
        map.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key, value, ttl) {
      if (map.size > 500) map.clear()
      map.set(key, { value, at: Date.now(), ttl })
    },
  }
}

/**
 * @param {{cookieStore: {state: () => object}, logger?: any, backends?: {netease: object, qq: object, meting: object}}} options
 */
export function createResolver({ cookieStore, logger, backends } = {}) {
  const netease = backends?.netease ?? neteaseBackend
  const qq = backends?.qq ?? qqBackend
  const meting = backends?.meting ?? metingBackend
  const idCache = createCache()
  const resolveCache = createCache()

  const identityOf = (track) => ({
    title: String(track?.title ?? ''),
    artist: String(track?.artist ?? ''),
    album: String(track?.album ?? ''),
  })

  const cacheKey = (track) => [
    track?.backend ?? '',
    track?.id ?? track?.mid ?? '',
    track?.title ?? '',
    track?.artist ?? '',
  ].join('|')

  /** 拿网易云歌曲 id：本身就是网易云曲目就直接用，否则按歌名+歌手搜一次并缓存。 */
  async function neteaseIdOf(track, { signal, cookie = '' } = {}) {
    if (track?.backend === 'netease' && track.id) return String(track.id)
    const key = `netease:${track?.title ?? ''}|${track?.artist ?? ''}`
    const cached = idCache.get(key)
    if (cached) return cached
    const keyword = [track?.title, track?.artist].filter(Boolean).join(' ').trim()
    if (!keyword) return ''
    const songs = await netease.search(keyword, 8, { cookie, signal }).catch(() => [])
    const best = pickBest(songs, track)
    const id = best?.id ? String(best.id) : ''
    if (id) idCache.set(key, id, ID_CACHE_MS)
    return id
  }

  /** 拿 QQ 音乐 mid：同上。 */
  async function qqMidOf(track, { signal } = {}) {
    if (track?.backend === 'qq' && track.mid) return String(track.mid)
    const key = `qq:${track?.title ?? ''}|${track?.artist ?? ''}`
    const cached = idCache.get(key)
    if (cached) return cached
    const keyword = [track?.title, track?.artist].filter(Boolean).join(' ').trim()
    if (!keyword) return ''
    const songs = await qq.search(keyword, 8, { signal }).catch(() => [])
    const best = pickBest(songs, track)
    const mid = best?.mid ? String(best.mid) : ''
    if (mid) idCache.set(key, mid, ID_CACHE_MS)
    return mid
  }

  const shape = (tier, raw, extra = {}) => ({
    url: raw.url,
    tier,
    tierLabel: TIER_LABEL[tier],
    backend: tier === TIER.QQ ? 'qq' : 'netease',
    br: raw.br || 0,
    cover: raw.cover || extra.cover || '',
    title: raw.title || extra.title || '',
    artist: raw.artist || extra.artist || '',
    album: raw.album || extra.album || '',
    duration: raw.duration || extra.duration || 0,
    ...extra.rest,
  })

  /**
   * 解析一首曲目的播放直链（四档瀑布）。
   * @param {object} track { backend, id, mid, title, artist, ... }
   * @param {{signal?: AbortSignal, refresh?: boolean}} [options]
   */
  async function resolve(track, { signal, refresh = false } = {}) {
    if (!track) return { url: '', tier: '', reason: 'NO_TRACK' }
    const key = cacheKey(track)
    if (!refresh) {
      const cached = resolveCache.get(key)
      if (cached) return cached
    }

    const identity = identityOf(track)
    const cookie = cookieStore?.state()?.cookie ?? ''
    const attempts = []

    /* ---- 第 1 档：网易云会员（未登录静默跳过） ---- */
    if (cookie) {
      attempts.push(async () => {
        const id = await neteaseIdOf(track, { signal, cookie })
        if (!id) return null
        const raw = await netease.song(id, identity, { cookie, signal })
        return raw.url ? shape(TIER.NETEASE_VIP, raw) : null
      })
    }

    /* ---- 第 2 档：网易云免费（匿名） ---- */
    attempts.push(async () => {
      const id = await neteaseIdOf(track, { signal })
      if (!id) return null
      const raw = await netease.song(id, identity, { signal })
      return raw.url ? shape(TIER.NETEASE_FREE, raw) : null
    })

    /* ---- 第 3 档：QQ 音乐免费库 ---- */
    attempts.push(async () => {
      const mid = await qqMidOf(track, { signal })
      if (!mid) return null
      const raw = await qq.song(mid, { ...identity, mid }, { signal })
      return raw.url ? shape(TIER.QQ, raw) : null
    })

    /* ---- 第 4 档：Meting 聚合兜底 ---- */
    attempts.push(async () => {
      const hit = await meting.resolveByKeyword(identity, { signal })
      if (!hit.url) return null
      return {
        url: hit.url,
        tier: TIER.METING,
        tierLabel: TIER_LABEL[TIER.METING],
        backend: 'meting',
        br: hit.br || 0,
        cover: hit.track?.cover || '',
        title: hit.track?.title || identity.title,
        artist: hit.track?.artist || identity.artist,
        album: hit.track?.album || identity.album,
        duration: 0,
        metingTrack: hit.track
          ? { platform: hit.track.platform, source: hit.track.source, id: hit.track.id, lyricId: hit.track.lyricId }
          : undefined,
        source: hit.source,
      }
    })

    for (let i = 0; i < attempts.length; i++) {
      if (signal?.aborted) return { url: '', tier: '', reason: 'ABORTED' }
      try {
        const value = await attempts[i]()
        if (value?.url) {
          logger?.debug?.(`[dsh-music] 直链命中第 ${i + 1} 档：${value.tier}`)
          resolveCache.set(key, value, RESOLVE_CACHE_MS)
          return value
        }
      } catch (error) {
        logger?.debug?.(`[dsh-music] 第 ${i + 1} 档失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const failed = { url: '', tier: '', reason: 'ALL_TIERS_FAILED' }
    resolveCache.set(key, failed, 15 * 1000)
    return failed
  }

  return { resolve, TIER }
}
