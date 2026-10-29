/**
 * 网易云扫码登录（宿主侧，直连公开 Web 接口，无第三方依赖）。
 *
 * 流程与网页版一致：
 *   POST /api/login/qrcode/unikey?type=1          → { unikey }
 *   GET  /api/login/qrcode/client/login?type=1&key=<unikey>
 *        → code 801 等待扫码 / 802 已扫码待确认 / 800 过期 / 803 授权成功（带回 cookie）
 *
 * 二维码本身由宿主用内置编码器绘制成 SVG data URL（网易云返回的 qrimg 已是占位图），
 * 浏览器只负责显示，因此不引入任何前端二维码依赖。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcode = require('../vendor/qrcode-generator.cjs')

const BASE = 'https://music.163.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://music.163.com/',
  'Origin': 'https://music.163.com',
}

/** 登录/账号接口带的设备 Cookie（与网页版扫码时一致）。 */
const DEVICE_COOKIE = 'appver=2.9.7; os=pc; channel=netease'

export const QR_CODE_MESSAGES = {
  800: '二维码已过期，正在刷新',
  801: '等待扫码',
  802: '已扫码，请在手机上确认',
  803: '登录成功',
}

/** 把文本编码成二维码 SVG 的 data URL。 */
export function qrToDataUrl(text, { scale = 6, quiet = 4, ec = 'M' } = {}) {
  const qr = qrcode(0, ec)
  qr.addData(String(text))
  qr.make()
  const count = qr.getModuleCount()
  const size = (count + quiet * 2) * scale
  let path = ''
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue
      path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#141414"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function mergeCookies(base = '', extra = '') {
  const map = new Map()
  for (const src of [base, extra]) {
    for (const pair of String(src).split(';')) {
      const s = pair.trim()
      const eq = s.indexOf('=')
      if (eq > 0) map.set(s.slice(0, eq), s.slice(eq + 1))
    }
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 只保留 name=value，丢掉 Set-Cookie 的属性段。 */
function stripCookieAttrs(raw) {
  if (!raw) return ''
  const attrs = new Set(['path', 'expires', 'max-age', 'httponly', 'secure', 'samesite', 'domain', 'version'])
  return String(raw)
    .split(/;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((pair) => {
      const eq = pair.indexOf('=')
      if (eq <= 0) return false
      return !attrs.has(pair.slice(0, eq).toLowerCase())
    })
    .join('; ')
}

async function request(path, { method = 'GET', cookie = '', signal } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...HEADERS,
      Cookie: mergeCookies(DEVICE_COOKIE, cookie),
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' ? { body: 'type=1' } : {}),
    signal: signal ?? AbortSignal.timeout(12000),
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  if (!res.ok) throw new Error(`网易云 ${path} → HTTP ${res.status}`)
  if (!body) throw new Error(`网易云 ${path} 返回了非 JSON 内容`)
  // 关键：设备 Cookie（NMTID 等）只在 Set-Cookie 里下发，必须回流到后续轮询，
  // 否则扫码确认后拿不到 MUSIC_U。
  const setCookie = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean)
  return { body, setCookie: stripCookieAttrs(setCookie.join('; ')) }
}

/** 申请二维码：返回 { key, qrurl, qrimg, cookie }，cookie 是本次下发的设备 Cookie 种子。 */
export async function createQrLogin({ signal } = {}) {
  const { body, setCookie } = await request('/api/login/qrcode/unikey?type=1', { method: 'POST', signal })
  const key = body?.unikey
  if (!key) throw new Error(body?.message || '网易云未返回二维码 key')
  const qrurl = `https://music.163.com/login?codekey=${key}`
  return { key, qrurl, qrimg: qrToDataUrl(qrurl), cookie: setCookie }
}

/**
 * 轮询扫码状态。`deviceCookie` 是同一张二维码此前轮询时服务端下发的设备 Cookie
 * （NMTID 等），必须带上（与浏览器行为一致），否则可能拿不到 MUSIC_U。
 */
export async function checkQrLogin(key, { deviceCookie = '', signal } = {}) {
  const { body, setCookie } = await request(`/api/login/qrcode/client/login?type=1&key=${encodeURIComponent(key)}`, {
    cookie: deviceCookie,
    signal,
  })
  const code = Number(body?.code)
  const cookie = mergeCookies(mergeCookies(deviceCookie, stripCookieAttrs(body?.cookie)), setCookie)
  const keys = cookie ? [...new Set(cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean))] : []
  return {
    code,
    message: QR_CODE_MESSAGES[code] ?? body?.message ?? `状态 ${code}`,
    cookie,
    // 诊断用：授权成功但缺 MUSIC_U 时，把已拿到的 Cookie 名回传，便于判断是哪一步丢了
    cookieKeys: keys,
    hasMusicU: /(?:^|;\s*)MUSIC_U=/.test(cookie),
  }
}

/** 用当前 Cookie 查账号信息；未登录 / Cookie 失效时返回 null。 */
export async function fetchAccount(cookie, { signal } = {}) {
  if (!cookie) return null
  try {
    const { body } = await request('/api/nuser/account/get', { cookie, signal })
    const profile = body?.profile
    const account = body?.account
    if (!profile?.nickname && profile?.userId == null && account?.id == null) return null
    return {
      nickname: profile?.nickname ?? '',
      userId: profile?.userId ?? account?.id ?? null,
      avatar: profile?.avatarUrl ?? '',
      vipType: Number(profile?.vipType) || 0,
      anonymous: account?.anonimousUser === true,
    }
  } catch {
    return null
  }
}
