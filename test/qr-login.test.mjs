import test from 'node:test'
import assert from 'node:assert/strict'

import { createQrLogin, checkQrLogin } from '../src/auth/netease-qr.mjs'

/** 用可编程的 fetch 桩模拟网易云扫码接口的 Set-Cookie 下发。 */
function stubFetch(sequence) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: init.headers?.Cookie ?? '' })
    const next = sequence.shift()
    if (!next) throw new Error('unexpected extra fetch')
    return new Response(JSON.stringify(next.body), {
      status: 200,
      headers: [['content-type', 'application/json'], ...next.setCookie.map((c) => ['set-cookie', c])],
    })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('扫码登录：设备 Cookie 从 Set-Cookie 回流，803 能拿到 MUSIC_U', async () => {
  const stub = stubFetch([
    { body: { code: 200, unikey: 'KEY-1' }, setCookie: ['NMTID=dev1; Path=/; HttpOnly'] },
    { body: { code: 801, message: '等待扫码' }, setCookie: ['NMTID=dev2; Path=/'] },
    { body: { code: 803, message: '授权成功' }, setCookie: ['MUSIC_U=token-abc; Path=/; HttpOnly', '__csrf=csrf1; Path=/'] },
  ])
  try {
    const qr = await createQrLogin()
    assert.equal(qr.key, 'KEY-1')
    assert.match(qr.qrimg, /^data:image\/svg\+xml;base64,/)
    assert.match(qr.cookie, /NMTID=dev1/)

    const pending = await checkQrLogin('KEY-1', { deviceCookie: qr.cookie })
    assert.equal(pending.code, 801)
    assert.match(pending.cookie, /NMTID=dev2/)

    const done = await checkQrLogin('KEY-1', { deviceCookie: pending.cookie })
    assert.equal(done.code, 803)
    assert.ok(done.hasMusicU)
    assert.match(done.cookie, /MUSIC_U=token-abc/)
    assert.match(done.cookie, /NMTID=dev2/) // 设备 Cookie 不被丢掉

    // 第二次轮询请求头里应带着上一轮下发的设备 Cookie
    assert.match(stub.calls[2].cookie, /NMTID=dev2/)
  } finally {
    stub.restore()
  }
})

test('扫码登录：803 缺 MUSIC_U 时回传 Cookie 名用于诊断', async () => {
  const stub = stubFetch([
    { body: { code: 200, unikey: 'KEY-2' }, setCookie: [] },
    { body: { code: 803 }, setCookie: ['NMTID=dev9; Path=/'] },
  ])
  try {
    const qr = await createQrLogin()
    const done = await checkQrLogin('KEY-2', { deviceCookie: qr.cookie })
    assert.equal(done.code, 803)
    assert.equal(done.hasMusicU, false)
    assert.ok(done.cookieKeys.includes('NMTID'))
  } finally {
    stub.restore()
  }
})
