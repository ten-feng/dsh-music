/**
 * 网易云登录态存储（宿主侧）。
 *
 * 约定：登录态写到 `~/.dsh/music-cookie.json`（与 dsh-my-music 的路径一致），
 * 文件不存在 = 用户从未在本机扫码登录/退出过。
 *
 * 关键行为：
 * - 每次取 Cookie 都重新读文件（mtime 变化才真正读盘），所以扫码登录 / 退出登录
 *   之后**无需重启**，搜索、取链、音频代理立刻生效；
 * - 文件损坏按「未登录」处理，绝不拿其它来源的 Cookie 顶替；
 * - Cookie 串只保留 `name=value`，丢掉 Path/HttpOnly/Expires 等属性。
 */

import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_COOKIE_FILE = join(homedir(), '.dsh', 'music-cookie.json')

const COOKIE_ATTRS = new Set([
  'path', 'expires', 'max-age', 'httponly', 'secure', 'samesite', 'domain', 'version', 'comment',
])

/** "a=1; Path=/; HttpOnly; b=2" → "a=1; b=2" */
export function normalizeCookie(raw) {
  if (!raw) return ''
  const parts = Array.isArray(raw) ? raw.join('; ') : String(raw)
  return parts
    .split(/;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((pair) => {
      const eq = pair.indexOf('=')
      if (eq <= 0) return false
      return !COOKIE_ATTRS.has(pair.slice(0, eq).toLowerCase())
    })
    .join('; ')
}

function toPairs(str) {
  const map = new Map()
  for (const pair of normalizeCookie(str).split(';')) {
    const s = pair.trim()
    const eq = s.indexOf('=')
    if (eq > 0) map.set(s.slice(0, eq), s.slice(eq + 1))
  }
  return map
}

/** 合并 Cookie，后出现的同名项覆盖前者（扫码轮询时设备 Cookie 会陆续下发）。 */
export function mergeCookies(base = '', extra = '') {
  const map = toPairs(base)
  for (const [name, value] of toPairs(extra)) map.set(name, value)
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** 登录态文件缓存：mtime + size 未变则不重复读盘。 */
function createFileCache(file) {
  let mtimeMs = -1
  let size = -1
  let parsed = null
  return () => {
    let st
    try {
      st = statSync(file)
    } catch {
      mtimeMs = -1
      size = -1
      parsed = null
      return { exists: false, cookie: '', savedAt: 0 }
    }
    if (st.mtimeMs === mtimeMs && st.size === size && parsed) return parsed
    mtimeMs = st.mtimeMs
    size = st.size
    let body = null
    try {
      // 兼容被编辑器/脚本写入的 BOM
      body = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      body = null
    }
    parsed = {
      exists: true,
      cookie: typeof body?.cookie === 'string' ? normalizeCookie(body.cookie) : '',
      savedAt: Number(body?.savedAt) || 0,
      nickname: typeof body?.nickname === 'string' ? body.nickname : '',
      userId: body?.userId != null ? String(body.userId) : '',
    }
    return parsed
  }
}

/**
 * 登录态仓库。
 * @param {{file?: string}} [options]
 */
export function createCookieStore({ file = DEFAULT_COOKIE_FILE } = {}) {
  const read = createFileCache(file)

  /** 当前登录态；`source` 为 'qr'（本机扫码）或 'none'。 */
  function state() {
    const f = read()
    return {
      cookie: f.exists ? f.cookie : '',
      loggedIn: Boolean(f.exists && f.cookie),
      source: f.exists && f.cookie ? 'qr' : 'none',
      savedAt: f.savedAt || 0,
      nickname: f.nickname || '',
      userId: f.userId || '',
      file,
    }
  }

  /** 写登录态；cookie 传空串 = 退出登录。原子写，避免半截文件。 */
  function write(cookie, extra = {}) {
    const body = {
      cookie: normalizeCookie(cookie),
      savedAt: Date.now(),
      ...(extra.nickname ? { nickname: extra.nickname } : {}),
      ...(extra.userId ? { userId: String(extra.userId) } : {}),
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
      renameSync(tmp, file)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return { file, state, write }
}
