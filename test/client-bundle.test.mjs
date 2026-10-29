/**
 * 浏览器半区契约测试：模拟 DSH 的 __ModuleLoader__ + 最小 DOM，验证
 *   1) client.js 是合法的 ModuleLoader 工厂包（不是 ESM）；
 *   2) factory 返回 { apply, inject }，apply 能安装围栏观察器；
 *   3) 设置页 settings.section 注册了「音乐账号」区块。
 * 零依赖、不启动浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: { setProperty() {}, removeProperty() {}, cssText: '' },
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    childElementCount: 0,
    isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { this.children.push(child); this.childElementCount = this.children.length; return child },
    append(...nodes) { this.children.push(...nodes); this.childElementCount = this.children.length },
    replaceChildren(...nodes) { this.children = nodes; this.childElementCount = nodes.length },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ width: 200, height: 200, left: 0, top: 0 }),
    closest: () => null,
    querySelectorAll: () => [],
    getContext: () => ({
      clearRect() {}, setTransform() {}, createRadialGradient: () => ({ addColorStop() {} }),
      beginPath() {}, arc() {}, fill() {}, stroke() {}, fillStyle: '', strokeStyle: '', lineWidth: 1,
    }),
    width: 0,
    height: 0,
    data: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.data, name) ? this.data[name] : null },
    setAttribute(name, value) { this.data[name] = String(value) },
  }
  return el
}

function buildSandbox(state = null) {
  const doc = {
    hidden: false,
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: { lang: 'zh-CN' },
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  const registrations = []
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    localStorage: {
      getItem: (key) => (state && key === 'dsh-music.state.v1' ? JSON.stringify(state) : null),
      setItem() {},
      removeItem() {},
    },
    matchMedia: () => ({ matches: false }),
    navigator: {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 0,
    document: doc,
    AudioContext: undefined,
    location: { href: 'http://dsh.test/' },
    __ModuleLoader__: { load: (entry) => registrations.push(entry) },
  }
  sandbox.window = sandbox
  sandbox.addEventListener = () => {}
  sandbox.removeEventListener = () => {}
  sandbox.innerWidth = 1280
  sandbox.innerHeight = 800
  return { sandbox, doc, registrations }
}

test('client.js 以 __ModuleLoader__ 工厂注册并暴露 apply/inject', async () => {
  const { sandbox, doc, registrations } = buildSandbox({
    backend: 'netease',
    theme: 'glass',
    queue: [{ backend: 'netease', id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', cover: 'https://x/c.jpg', duration: 269000 }],
    index: 0,
    volume: 0.9,
    mode: 'loop',
    lyricMode: 'bubble',
    liked: [],
  })
  const context = createContext(sandbox)
  const code = readFileSync(join(root, 'client.js'), 'utf8')
  runInContext(code, context, { filename: 'client.js' })

  assert.equal(registrations.length, 1, '应恰好注册一个客户端模块')
  const entry = registrations[0]
  assert.equal(entry.id, 'dsh-music')

  const React = {
    createElement: () => ({}),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  const moduleExports = entry.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })

  assert.equal(typeof moduleExports.apply, 'function')
  assert.ok(Array.isArray(moduleExports.inject))
  assert.ok(moduleExports.inject.includes('slots'))

  const registered = []
  const localeDicts = []
  const ctx = {
    slots: {
      inject(name, run) { run() },
      register(shape, Component) { registered.push({ shape, Component }); return () => {} },
    },
    locale: {
      register(ns, dict) { localeDicts.push([ns, dict]); return () => {} },
      bind(ns) { return (key, vars) => (localeDicts.find(([n]) => n === ns)?.[1]?.zh?.[key] ?? key) },
    },
    inject() {},
  }
  const dispose = moduleExports.apply(ctx)
  assert.equal(typeof dispose, 'function', 'apply 应返回清理函数')
  assert.ok(doc.body.children.some((c) => c.tagName === 'AUDIO'), '应挂载全局音频单例')

  assert.equal(localeDicts[0]?.[0], 'settings.dshMusic')
  const section = registered.find((r) => r.shape.name === 'settings.section')
  assert.ok(section, '应注册 settings.section')
  assert.equal(section.shape.id, 'dsh-music-account')
  assert.equal(section.shape.label(), '音乐账号')
  assert.equal(typeof section.Component, 'function')
  // 首次渲染不应抛错（hooks 由测试桩代替）
  assert.ok(section.Component())

  // 悬浮播放器：挂在 body 上、不随对话滚动，且从持久化状态恢复出当前曲目
  const dock = doc.body.children.find((c) => c.className === 'dshmd')
  assert.ok(dock, '应创建悬浮播放条')
  assert.equal(dock.hidden, false, '有当前曲目时应显示')
  const titleEl = dock.children[0].children[1].children[0]
  assert.equal(titleEl.textContent, '晴天')
  const full = doc.body.children.find((c) => c.className === 'dshmf')
  assert.ok(full, '应创建展开态面板')
  assert.equal(full.hidden, true, '默认收起')
})
