import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createResolver, TIER } from '../src/media/resolve.mjs'
import { createCookieStore, normalizeCookie, mergeCookies } from '../src/auth/cookie-store.mjs'
import { qrToDataUrl } from '../src/auth/netease-qr.mjs'

/** 构造可观测的假后端：记录每次调用，并按脚本返回。 */
function fakes({ neteaseUrl = () => '', qqUrl = () => '', metingUrl = '' } = {}) {
  const calls = []
  const netease = {
    search: async (q) => { calls.push(['netease.search', q]); return [{ backend: 'netease', id: '100', title: '晴天', artist: '周杰伦' }] },
    song: async (id, hint, opts = {}) => {
      calls.push(['netease.song', id, opts.cookie ?? ''])
      const url = neteaseUrl({ id, cookie: opts.cookie ?? '', call: calls.length })
      return { url, br: url ? 320000 : 0, cover: 'cover.jpg', fee: 0 }
    },
  }
  const qq = {
    search: async (q) => { calls.push(['qq.search', q]); return [{ backend: 'qq', mid: 'MID1', title: '晴天', artist: '周杰伦' }] },
    song: async (mid, hint) => { calls.push(['qq.song', mid]); const url = qqUrl(); return { url, br: url ? 128000 : 0 } },
  }
  const meting = {
    resolveByKeyword: async (identity) => {
      calls.push(['meting.resolve', identity.title])
      return metingUrl ? { url: metingUrl, br: 0, source: 'gd:netease', track: { platform: 'gd', source: 'netease', id: '100', title: '晴天', artist: '周杰伦' } } : { url: '', br: 0, source: '' }
    },
  }
  return { calls, backends: { netease, qq, meting } }
}

const track = { backend: 'netease', id: '100', title: '晴天', artist: '周杰伦' }

test('未登录：跳过会员档，直接网易云免费档', async () => {
  const f = fakes({ neteaseUrl: ({ cookie }) => (cookie ? 'vip.mp3' : 'free.mp3') })
  const r = createResolver({ cookieStore: { state: () => ({ cookie: '' }) }, backends: f.backends })
  const out = await r.resolve(track)
  assert.equal(out.tier, TIER.NETEASE_FREE)
  assert.equal(out.url, 'free.mp3')
  assert.equal(f.calls.filter((c) => c[0] === 'netease.song').length, 1, '不应为会员档额外请求')
  assert.ok(f.calls.every((c) => c[0] !== 'netease.song' || c[2] === ''))
})

test('已登录：会员档命中即停', async () => {
  const f = fakes({ neteaseUrl: ({ cookie }) => (cookie.includes('MUSIC_U') ? 'vip.mp3' : 'free.mp3') })
  const r = createResolver({ cookieStore: { state: () => ({ cookie: 'MUSIC_U=abc' }) }, backends: f.backends })
  const out = await r.resolve({ ...track, id: '200' })
  assert.equal(out.tier, TIER.NETEASE_VIP)
  assert.equal(out.url, 'vip.mp3')
  assert.equal(f.calls.filter((c) => c[0] === 'qq.song').length, 0)
  assert.equal(f.calls.filter((c) => c[0] === 'meting.resolve').length, 0)
})

test('已登录但会员档失败：静默回退网易云匿名，再到 QQ 才轮到 Meting', async () => {
  const f = fakes({
    neteaseUrl: () => '',
    qqUrl: () => '',
    metingUrl: 'meting.mp3',
  })
  const r = createResolver({ cookieStore: { state: () => ({ cookie: 'MUSIC_U=abc' }) }, backends: f.backends })
  const out = await r.resolve({ backend: 'qq', mid: 'MIDX', title: '晴天', artist: '周杰伦' })
  assert.equal(out.tier, TIER.METING)
  assert.equal(out.url, 'meting.mp3')
  const order = f.calls.filter((c) => c[0] === 'netease.song' || c[0] === 'qq.song' || c[0] === 'meting.resolve').map((c) => c[0])
  assert.deepEqual(order, ['netease.song', 'netease.song', 'qq.song', 'meting.resolve'])
})

test('四档全失败：返回空 url，不抛错', async () => {
  const f = fakes({ neteaseUrl: () => '', qqUrl: () => '', metingUrl: '' })
  const r = createResolver({ cookieStore: { state: () => ({ cookie: 'MUSIC_U=abc' }) }, backends: f.backends })
  const out = await r.resolve({ backend: 'netease', id: '999', title: '查无此歌', artist: '无名' })
  assert.equal(out.url, '')
  assert.equal(out.reason, 'ALL_TIERS_FAILED')
})

test('Cookie 归一化与合并', () => {
  assert.equal(normalizeCookie('MUSIC_U=abc; Path=/; HttpOnly; __csrf=1; Max-Age=0'), 'MUSIC_U=abc; __csrf=1')
  assert.equal(mergeCookies('a=1; b=2', 'b=3; c=4'), 'a=1; b=3; c=4')
})

test('登录态文件：写入、读取、退出、无需重启即可生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-music-'))
  const file = join(dir, 'music-cookie.json')
  try {
    const store = createCookieStore({ file })
    assert.equal(store.state().loggedIn, false)
    assert.deepEqual(store.write('MUSIC_U=abc; os=pc', { nickname: '小明', userId: 42 }), { ok: true })
    const st = store.state()
    assert.equal(st.loggedIn, true)
    assert.equal(st.cookie, 'MUSIC_U=abc; os=pc')
    assert.equal(st.nickname, '小明')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).userId, '42')
    // 用同一个 file 新建 store（模拟插件重载）也能立刻读到
    assert.equal(createCookieStore({ file }).state().loggedIn, true)
    // 损坏文件按未登录处理
    writeFileSync(file, '{ not json')
    assert.equal(createCookieStore({ file }).state().loggedIn, false)
    store.write('')
    assert.equal(store.state().loggedIn, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('二维码由宿主绘制成 SVG data URL', () => {
  const url = qrToDataUrl('https://music.163.com/login?codekey=abc-123')
  assert.match(url, /^data:image\/svg\+xml;base64,/)
  const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<path d="M/)
})
