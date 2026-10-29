/**
 * 宿主冒烟测试：用假的 cordis ctx 启动真实插件，挂到本地 http server 上打真实接口。
 * 覆盖：health / account / 扫码二维码 / 轮询 / 搜索 / 四档瀑布取链 / 同源音频代理 / 歌词。
 *
 * 运行：node test/host-smoke.mjs
 */
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cookieFile = join(mkdtempSync(join(tmpdir(), 'dsh-music-smoke-')), 'music-cookie.json')
process.env.DSH_MUSIC_COOKIE_FILE = cookieFile

const { apply } = await import('../index.js')

const routes = new Map()
const webServer = {
  register({ path, handler }) {
    routes.set(path, handler)
    return () => routes.delete(path)
  },
}
const skills = { registerProvider() {} }

const ctx = {
  logger: { debug: () => {}, warn: console.warn, info: () => {} },
  systemPrompt: { section() {}, getSectionOrder: () => 0 },
  inject(services, callback) {
    if (services.includes('skills')) callback({ skills })
    if (services.includes('webServer')) {
      callback({ reflect: { get: () => webServer }, effect: (fn) => fn() })
    }
  },
}

apply(ctx)

const server = http.createServer((req, res) => {
  for (const [prefix, handler] of routes) {
    if (req.url.startsWith(prefix)) return handler(req, res)
  }
  res.writeHead(404).end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/plugins/dsh-music/api`

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const getJson = async (path) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  const health = await getJson('/health')
  check('health', health.status === 200 && health.body?.ok === true && health.body.tiers.length === 4, JSON.stringify(health.body?.tiers))

  const account = await getJson('/account')
  check('未登录时 account 返回未登录', account.status === 200 && account.body?.loggedIn === false, JSON.stringify(account.body))

  const qr = await getJson('/login/qr/create')
  const qrOk = qr.status === 200 && typeof qr.body?.key === 'string' && /^data:image\/svg\+xml;base64,/.test(qr.body?.qrimg ?? '')
  check('扫码登录：二维码由宿主绘制', qrOk, qrOk ? `key=${String(qr.body.key).slice(0, 8)}… svg=${qr.body.qrimg.length}B` : JSON.stringify(qr.body))

  if (qrOk) {
    const poll = await getJson(`/login/qr/check?key=${encodeURIComponent(qr.body.key)}`)
    check('扫码状态机：未扫码返回 801', poll.status === 200 && poll.body?.code === 801, poll.body?.message)
  }

  const search = await getJson(`/search?backend=netease&q=${encodeURIComponent('晴天 周杰伦')}&limit=5`)
  const songs = search.body?.songs ?? []
  check('搜索', search.status === 200 && songs.length > 0, `${songs.length} 首`)

  if (songs.length) {
    const pick = songs.find((s) => s.title.includes('晴天')) ?? songs[0]
    const res = await fetch(base + '/song', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ track: { ...pick, title: '晴天', artist: '周杰伦' } }),
    })
    const body = await res.json()
    const song = body.song ?? {}
    const proxied = String(song.url).startsWith('/plugins/dsh-music/api/stream/')
    check('四档瀑布取链（未登录 → 网易云免费）', Boolean(song.url) && proxied && song.tier === 'netease-free', `tier=${song.tier} br=${song.br} url=${String(song.url).slice(0, 48)}…`)

    if (proxied) {
      const streamRes = await fetch(`http://127.0.0.1:${server.address().port}${song.url}`, { headers: { Range: 'bytes=0-1023' } })
      const buf = Buffer.from(await streamRes.arrayBuffer())
      const ct = streamRes.headers.get('content-type') ?? ''
      check('同源音频代理（Range）', (streamRes.status === 206 || streamRes.status === 200) && buf.length > 0 && ct.startsWith('audio/'), `status=${streamRes.status} ${ct} ${buf.length}B`)

      const headRes = await fetch(`http://127.0.0.1:${server.address().port}${song.url}`, { method: 'HEAD' })
      check('音频代理 HEAD', headRes.status === 200, `status=${headRes.status}`)
    }

    const lyricRes = await fetch(base + '/lyric', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ track: pick }),
    })
    const lyric = await lyricRes.json()
    check('歌词', typeof lyric.lrc === 'string' && lyric.lrc.includes('['), `${String(lyric.lrc).length}B`)
  }

  const meting = await getJson('/search?backend=meting&q=' + encodeURIComponent('晴天 周杰伦'))
  check('Meting 兜底解析可用', meting.status === 200, `${meting.body?.songs?.length ?? 0} 首`)
} finally {
  server.close()
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exitCode = failures === 0 ? 0 : 1
}
