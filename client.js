/**
 * dsh-music 浏览器半区（client half）。
 *
 * 部署形态与 DSH Web 客户端插件一致：以 `window.__ModuleLoader__.load({ id, factory })`
 * 注册工厂，factory 内是纯 DOM 的围栏渲染器（零 React 依赖），只有设置页的
 * 「账号」区块用 require('react') 渲染。
 *
 * 围栏渲染机制与改造前完全一致：MutationObserver 观察会话 DOM，找到标注
 * `dsh-music` 的代码围栏（流式阶段先挂骨架，15s 未完成还原代码块），把其表面
 * （label + <pre>）替换为播放器卡片；宿主重渲染时围栏恢复为代码块，观察器重新挂载；
 * 播放状态存于全局单例，跨挂载/跨卡片共享，刷新后从 localStorage 恢复。
 *
 * 音源解析在宿主侧按四档瀑布完成（会员 → 免费 → QQ → Meting），浏览器只取
 * `song.url`（已是同源代理地址）；四档全失败后仍保留原有的「跨后端」最后兜底。
 * @module dsh-music/client
 */

/*
 * 注册 id 必须与宿主图里的包名一致：本插件在 npm 上重命名为
 * `dsh-music-plugin`（package.json / cordis.patch.yml 都改了）时，client.js
 * 仍只注册 `dsh-music`，宿主就会报
 *   client-modules: could not load "dsh-music-plugin": ... loaded without registering
 * 并让整个 web boot 失败。这里把同一个工厂按两个名字各注册一次，改包名不再炸。
 * 用 var 而不是 const：combo 批次会把多个 bundle 拼进同一个脚本，顶层 const
 * 会与其它 bundle 抢全局词法作用域，且 HMR 重新执行时会触发重复声明。
 */
var __dshMusicClientFactory = (require) => {
/**
 * dsh-music 浏览器半区（client half）。
 *
 * 走 dsh-genui 的 DOM channel 形态：不依赖宿主 React 组件树，观察会话 DOM，
 * 找到标注 `dsh-music` 的代码围栏，把其表面（label + <pre>）替换为播放器卡片。
 * 宿主重渲染时围栏恢复为代码块，观察器重新挂载；播放状态存于全局单例，
 * 跨挂载/跨卡片共享，刷新后从 localStorage 恢复（直链过期自动重新解析）。
 *
 * 特效：玻璃拟态卡片 + 封面氛围光（CSS blur，无 CORS 限制）、悬浮歌词气泡、
 * WebAudio 频谱驱动（不可用时自动降级为模拟节拍）的气泡粒子场、点击气泡迸发。
 * @module dsh-music/client
 */

const inject = ['slots', 'locale']

/* ================= 常量与小工具 ================= */

const FENCE_LANG = 'dsh-music'
const API_BASE = '/plugins/dsh-music/api'
const STORE_KEY = 'dsh-music.state.v1'
/** 宿主代理 token 的有效期是 10 分钟，缓存的直链留 8 分钟余量后强制重解析。 */
const RESOLVE_TTL_MS = 8 * 60 * 1000

const THEMES = ['glass', 'neon', 'paper', 'vapor']
const BACKEND_LABEL = { netease: '网易云', qq: 'QQ 音乐', meting: 'Meting' }

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

const h = (tag, cls, html) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (html !== undefined) el.innerHTML = html
  return el
}
/** DSH 桌面版（Electron）：宿主拒绝一切 window.open，且未暴露创建窗口的 API，
 *  所以播放器只在窗口内拖动；浏览器/Web 版才允许拖到边缘转为独立小窗。 */
const isDesktopApp = () => Boolean(window.dshDesktop) || /Electron/i.test(navigator.userAgent)
const icon = (paths, fill = false) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" ${fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${paths}</svg>`

const I = {
  logo: icon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  play: icon('<path d="M8 5v14l11-7z"/>', true),
  pause: icon('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>', true),
  prev: icon('<path d="M6 6h2v12H6zM18 6l-8.5 6L18 18z"/>', true),
  next: icon('<path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/>', true),
  loop: icon('<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  one: icon('<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10l1.5-1v6" stroke-width="1.8"/>'),
  shuffle: icon('<path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>'),
  heart: icon('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  volume: icon('<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  chevronDown: icon('<path d="M6 9l6 6 6-6"/>'),
  close: icon('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  note: icon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  popout: icon('<path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  embed: icon('<path d="M10 20H4v-6"/><path d="M4 20l7-7"/><path d="M20 10V4h-6"/>'),
  trash: icon('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>'),
}

const DOCK_CSS = `
.dshmd{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:277px;max-width:calc(100vw - 24px);
  border-radius:22px;overflow:hidden;color:#f6f8ff;isolation:isolate;
  background:linear-gradient(155deg,rgba(24,28,48,.95),rgba(9,11,21,.97));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 20px 50px -18px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.07);
  backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4);
  font:11px/1.45 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  transition:transform .25s ease,opacity .25s ease}
.dshmd[hidden]{display:none}
.dshmd *{box-sizing:border-box;min-width:0}
.dshmd button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0}
.dshmd svg{width:14px;height:14px;display:block}
.dshmd::before{content:'';position:absolute;inset:-30px;z-index:-1;background-image:var(--dshmd-cover,none);
  background-size:cover;background-position:center;filter:blur(40px) saturate(1.6);opacity:.5;transition:opacity .5s}
.dshmd-row{display:flex;align-items:center;gap:8px;padding:8px;position:relative}
.dshmd-cover{flex:0 0 auto;width:36px;height:36px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.08);
  box-shadow:0 6px 16px -6px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.08)}
.dshmd-cover img{width:100%;height:100%;object-fit:cover;display:block}
.dshmd-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:0;cursor:pointer}
.dshmd-title{font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmd-artist{font-size:9px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmd-acts{display:flex;align-items:center;gap:1px;flex:0 0 auto}
.dshmd-b{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:rgba(246,248,255,.72);
  transition:all .18s}
.dshmd-b:hover{color:#fff;background:rgba(255,255,255,.12)}
.dshmd-b:active{transform:scale(.9)}
.dshmd-b.main{width:32px;height:32px;background:var(--dshmd-accent,#8ab8ff);color:#0b1020;margin:0 1px;
  box-shadow:0 8px 20px -8px var(--dshmd-accent,#8ab8ff)}
.dshmd-b.main:hover{color:#0b1020;filter:brightness(1.08)}
.dshmd-bar{height:2px;background:rgba(255,255,255,.1);position:relative;overflow:hidden}
.dshmd-bar i{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--dshmd-accent,#8ab8ff);transition:width .25s linear}
.dshmd-close{position:absolute;top:5px;right:5px;width:16px;height:16px;border-radius:50%;font-size:11px;line-height:1;
  color:rgba(255,255,255,.5);display:none}
.dshmd:hover .dshmd-close{display:flex;align-items:center;justify-content:center}

/* 展开：魅族16 物理比例（73.2 × 150.5mm ≈ 277 × 569 CSS px @96dpi）——列表固定展开，不再收起 */
.dshmf{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:277px;max-width:calc(100vw - 24px);
  box-sizing:border-box;height:min(569px,calc(100vh - 20px));max-height:calc(100vh - 20px);overflow:hidden;
  border-radius:22px;color:#f2f5ff;
  background:linear-gradient(168deg,rgba(27,31,52,.97),rgba(9,11,22,.985));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 30px 70px -22px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);
  font:10px/1.45 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  padding:6px 10px;display:flex;flex-direction:column;gap:3px;isolation:isolate;
  animation:dshmf-in .32s cubic-bezier(.22,.8,.3,1) both}
.dshmf > *{flex:0 0 auto}
.dshmf[hidden]{display:none}
/* 画中画独立小窗：面板铺满小窗，窗口本身可拖到 DSH 窗口外 */
.dshmf.dshmf-in-pip{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;
  border-radius:0;animation:none;transform:none}
.dshmf *{box-sizing:border-box;min-width:0}
.dshmf::before{content:'';position:absolute;inset:-50px;z-index:-2;background-image:var(--dshmf-cover,none);
  background-size:cover;background-position:center;filter:blur(64px) saturate(1.4);opacity:.32;transition:opacity .5s}
.dshmf::after{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;
  background:linear-gradient(180deg,rgba(8,10,20,.2),rgba(8,10,20,.86) 62%),
    radial-gradient(90% 55% at 50% 0%,rgba(255,255,255,.07),transparent 65%)}
.dshmf button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0}
.dshmf svg{width:14px;height:14px;display:block}
.dshmf-head{display:flex;align-items:center;justify-content:space-between;padding:0 1px;color:rgba(235,240,255,.55);
  font-size:8px;letter-spacing:.1em;text-transform:uppercase;cursor:grab;touch-action:none}
.dshmf-head:active{cursor:grabbing}
.dshmf-head-label{display:flex;align-items:center;gap:5px}
.dshmf-live{width:4px;height:4px;border-radius:50%;background:var(--dshmf-accent,#8ab8ff);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 22%,transparent);
  animation:dshmf-live 2.6s ease-in-out infinite}
.dshmf-head-acts{display:flex;align-items:center;gap:3px}
.dshmf-icon-btn{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:rgba(235,240,255,.6);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
  transition:all .18s}
.dshmf-icon-btn:hover{color:#fff;background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.16)}
.dshmf-icon-btn:active{transform:scale(.92)}
.dshmf-icon-btn svg{width:10px;height:10px}
.dshmf-visual{position:relative;height:88px;flex:0 0 88px;width:100%;margin:2px 0 0}
.dshmf-cover{position:absolute;top:0;left:50%;margin-left:-44px;width:88px;height:88px;border-radius:16px;
  overflow:hidden;
  background:rgba(255,255,255,.06);
  box-shadow:0 16px 32px -16px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.1)}
.dshmf-cover::after{content:'';position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(150deg,rgba(255,255,255,.18),transparent 46%)}
.dshmf-cover img{width:100%;height:100%;object-fit:cover;display:block}
.dshmf-cover.playing{animation:dshmf-breathe 6s ease-in-out infinite}
.dshmf-song{display:flex;align-items:baseline;justify-content:center;gap:5px;padding:0 3px;min-width:0}
.dshmf-title{font-size:13px;line-height:1.3;font-weight:700;letter-spacing:.15px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.dshmf-artist{font-size:9px;line-height:1.4;color:rgba(235,240,255,.62);padding-bottom:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.dshmf-song-sep{flex:0 0 auto;font-size:8px;color:rgba(235,240,255,.28)}

/* 歌词面板：打开时在封面同一位置替换显示，尺寸完全一致，不改变布局 */
.dshmf-lyricbox{display:none;position:absolute;inset:0;width:100%;height:100%;overflow-y:auto;overscroll-behavior:contain;
  border-radius:16px;padding:8px 6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
  flex-direction:column;justify-content:center;gap:0;scrollbar-width:none;
  mask-image:linear-gradient(transparent,#000 12%,#000 88%,transparent);
  -webkit-mask-image:linear-gradient(transparent,#000 12%,#000 88%,transparent)}
.dshmf[data-lyric="1"] .dshmf-lyricbox{display:flex}
.dshmf[data-lyric="1"] .dshmf-cover{display:none}
.dshmf[data-lyric="1"] .dshmf-lyric{display:none}
.dshmf-lb{flex:0 0 auto;font-size:9.5px;line-height:1.4;text-align:center;color:rgba(235,240,255,.5);padding:1px 0;
  transition:color .25s,font-size .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmf-lb.act{font-size:11.5px;font-weight:650;color:#fff;
  text-shadow:0 0 16px color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 55%,transparent)}
.dshmf-lb.ghost{color:transparent;text-shadow:none}
.dshmf-lyric-empty{margin:auto;font-size:9px;color:rgba(235,240,255,.4)}
.dshmf-controls button.on{color:var(--dshmf-accent,#8ab8ff);background:rgba(255,255,255,.12)}
.dshmf-seek{-webkit-appearance:none;appearance:none;width:100%;height:3px;border-radius:99px;outline:none;cursor:pointer;
  background:linear-gradient(to right,var(--dshmf-accent,#8ab8ff) 0 var(--p,0%),rgba(255,255,255,.16) var(--p,0%) 100%)}
.dshmf-seek::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;border-radius:50%;background:#fff;
  box-shadow:0 0 0 2px color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 32%,transparent)}
.dshmf-times{display:flex;justify-content:space-between;font-size:8.5px;color:rgba(235,240,255,.55);
  font-variant-numeric:tabular-nums;margin-top:-2px}
.dshmf-controls{display:flex;align-items:center;justify-content:center;gap:6px;padding:1px 0}
.dshmf-controls button{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:rgba(235,240,255,.72);transition:all .18s}
.dshmf-controls button:hover{color:#fff;background:rgba(255,255,255,.1)}
.dshmf-controls button.play{width:44px;height:44px;margin:0 2px;color:#07101f;
  background:linear-gradient(145deg,color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 88%,#fff),var(--dshmf-accent,#8ab8ff));
  box-shadow:0 10px 22px -10px var(--dshmf-accent,#8ab8ff),inset 0 1px 0 rgba(255,255,255,.5)}
.dshmf-controls button.play:hover{color:#07101f;filter:brightness(1.08);transform:scale(1.03)}
.dshmf-controls button.play svg{width:19px;height:19px}
.dshmf-vol{display:flex;align-items:center;gap:8px;opacity:.65}
.dshmf-vol svg{width:13px;height:13px}
.dshmf-vol input{flex:1;-webkit-appearance:none;appearance:none;height:3px;border-radius:99px;outline:none;
  background:linear-gradient(to right,var(--dshmf-accent,#8ab8ff) 0 var(--v,90%),rgba(255,255,255,.2) var(--v,90%) 100%)}
.dshmf-vol input::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:#fff}

/* 播放列表 / 搜索结果 */
.dshmf-tabs{display:flex;gap:2px;padding:2px;border-radius:9px;background:rgba(255,255,255,.055);
  border:1px solid rgba(255,255,255,.06)}
.dshmf-tab{flex:1;padding:4px 0;border-radius:7px;font-size:9px;font-weight:500;color:rgba(235,240,255,.55);
  transition:all .18s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
.dshmf-tab:hover{color:rgba(235,240,255,.85)}
.dshmf-tab.on{color:#fff;background:rgba(255,255,255,.13);box-shadow:0 1px 0 rgba(255,255,255,.1)}
.dshmf-tab.on::before{content:'';display:inline-block;width:3px;height:3px;border-radius:50%;margin-right:4px;
  vertical-align:1px;background:var(--dshmf-accent,#8ab8ff);box-shadow:0 0 6px var(--dshmf-accent,#8ab8ff)}
.dshmf-search{display:flex;gap:5px;padding:0}
.dshmf-search input{flex:1;min-width:0;height:24px;padding:0 8px;border-radius:7px;border:1px solid rgba(255,255,255,.09);
  background:rgba(255,255,255,.06);color:#f2f5ff;font:inherit;font-size:9.5px;outline:none;transition:all .2s}
.dshmf-search input::placeholder{color:rgba(235,240,255,.38)}
.dshmf-search input:focus{border-color:color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 55%,transparent);
  background:rgba(255,255,255,.09)}
.dshmf-search button{flex:0 0 auto;height:24px;padding:0 10px;border-radius:7px;font-size:9.5px;font-weight:600;
  color:#07101f;background:var(--dshmf-accent,#8ab8ff);border:none;transition:filter .18s,transform .12s}
.dshmf-search button:hover{filter:brightness(1.08)}
.dshmf-search button:active{transform:scale(.96)}
.dshmf-list{flex:1 1 auto;height:auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;border-radius:10px;
  padding:2px 0 4px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
.dshmf-list::-webkit-scrollbar{width:4px}
.dshmf-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:99px}
.dshmf-list:empty::after{content:'暂无曲目';display:block;padding:16px;text-align:center;font-size:9px;
  color:rgba(235,240,255,.4)}
.dshmf-row{display:flex;align-items:center;gap:6px;padding:3px 8px;min-height:36px;font-size:10.5px;cursor:pointer;
  border-bottom:1px solid rgba(255,255,255,.045);transition:background .15s,box-shadow .15s}
.dshmf-row:last-child{border-bottom:none}
.dshmf-row:hover{background:rgba(255,255,255,.06)}
.dshmf-row.act{background:color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 11%,transparent);
  box-shadow:inset 3px 0 0 var(--dshmf-accent,#8ab8ff)}
.dshmf-row .no{width:12px;text-align:right;color:rgba(235,240,255,.38);font-size:9px;flex:0 0 auto;
  font-variant-numeric:tabular-nums}
.dshmf-row.act .no{color:var(--dshmf-accent,#8ab8ff);opacity:.9}
.dshmf-row .cov{width:24px;height:24px;border-radius:6px;object-fit:cover;flex:0 0 auto;
  background:rgba(255,255,255,.07);filter:saturate(.82) brightness(.94)}
.dshmf-row .cov.ph{display:flex;align-items:center;justify-content:center;color:rgba(235,240,255,.35)}
.dshmf-row .cov.ph svg{width:11px;height:11px}
.dshmf-row .meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:0}
.dshmf-row .tt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eef2ff;font-size:10.5px;font-weight:550}
.dshmf-row.act .tt{color:color-mix(in srgb,var(--dshmf-accent,#8ab8ff) 65%,#fff)}
.dshmf-row .ar{font-size:8.5px;color:rgba(235,240,255,.48);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmf-row .src{flex:0 0 auto;font-size:7.5px;padding:0 4px;border-radius:4px;color:rgba(235,240,255,.42);
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03)}
.dshmf-row .play{flex:0 0 auto;width:16px;height:16px;color:rgba(235,240,255,.55);display:flex;
  align-items:center;justify-content:center;opacity:0;transition:opacity .15s,color .15s}
.dshmf-row:hover .play,.dshmf-row.act .play{opacity:.9}
.dshmf-row:hover .play{color:#fff}
.dshmf-row.bad{opacity:.62}
.dshmf-row.bad .tt{text-decoration:line-through;color:rgba(255,150,150,.9)}
.dshmf-row.bad .src{color:#ff9a9a;border-color:rgba(255,120,120,.4)}
.dshmf-row .play svg{width:11px;height:11px}
.dshmd-row{cursor:grab;touch-action:none}
.dshmd-row:active{cursor:grabbing}
@keyframes dshmf-in{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
@keyframes dshmf-breathe{0%,100%{transform:scale(1);box-shadow:0 22px 44px -20px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.1)}
  50%{transform:scale(1.015);box-shadow:0 26px 52px -20px rgba(0,0,0,.95),0 0 0 1px rgba(255,255,255,.16)}}
@keyframes dshmf-live{0%,100%{opacity:1}50%{opacity:.35}}
@media (max-width:480px){
  .dshmd,.dshmf{right:10px;bottom:10px;width:calc(100vw - 20px)}
  .dshmf{height:min(569px,calc(100vh - 20px));max-height:calc(100vh - 20px)}
}
@media (prefers-reduced-motion:reduce){
  .dshmf,.dshmf-cover.playing,.dshmf-live{animation:none}
}
`

/* ================= LRC 解析 ================= */

function parseLrc(lrc) {
  const out = []
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of String(lrc ?? '').split(/\r?\n/)) {
    const times = []
    let m
    tagRe.lastIndex = 0
    while ((m = tagRe.exec(raw))) times.push(+m[1] * 60 + +m[2] + (m[3] ? Number(`0.${m[3].padEnd(3, '0').slice(0, 3)}`) : 0))
    if (!times.length) continue
    const text = raw.replace(tagRe, '').replace(/<[^>]*>/g, '').trim()
    if (!text) continue
    for (const t of times) out.push({ t, text })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

function parseTranslation(lrc) {
  const out = []
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of String(lrc ?? '').split(/\r?\n/)) {
    let m
    tagRe.lastIndex = 0
    while ((m = tagRe.exec(raw))) {
      const text = raw.replace(tagRe, '').replace(/<[^>]*>/g, '').trim()
      if (text) out.push({ t: +m[1] * 60 + +m[2] + (m[3] ? Number(`0.${m[3].padEnd(3, '0').slice(0, 3)}`) : 0), text })
      break
    }
  }
  return out
}

/* ================= API ================= */

async function api(path, opts) {
  // 宿主解析偶尔会长时间不返回，加超时避免播放器永远停在「正在解析…」
  const res = await fetch(`${API_BASE}/${path}`, { signal: AbortSignal.timeout(60000), ...opts })
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  if (!res.ok || (body && body.error)) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}
const apiSearch = (backend, q, limit = 12) => api(`search?backend=${encodeURIComponent(backend)}&q=${encodeURIComponent(q)}&limit=${limit}`)
const apiSong = (track) => api('song', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track }) })
const apiLyric = (track) => api('lyric', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track }) })

/** 解析播放直链并缓存到曲目上（此前只被调用、从未定义，导致起播必抛 ReferenceError）。 */
async function resolveTrack(t) {
  if (!t) return { resolved: null, failed: true }
  // 代理 token 10 分钟过期（src/media/proxy.mjs 的 TOKEN_TTL_MS）：
  // 缓存的直链超过安全期就丢掉重解析，否则循环到第二轮会全是失效链接。
  if (t.resolved?.url) {
    if (!t.resolvedAt || Date.now() - t.resolvedAt < RESOLVE_TTL_MS) {
      return { resolved: t.resolved, failed: false }
    }
    t.resolved = null
  }
  try {
    const data = await apiSong({
      backend: t.backend,
      id: t.id,
      mid: t.mid,
      title: t.title,
      artist: t.artist,
      album: t.album,
      cover: t.cover,
      duration: t.duration,
      metingTrack: t.metingTrack,
    })
    const song = data?.song ?? null
    if (!song || !song.url) {
      t.failed = true
      t.resolved = null
      t.error = song?.reason === 'ALL_TIERS_FAILED' ? '四档音源都没拿到直链' : '没有可播放的音源'
      return { resolved: null, failed: true }
    }
    if (t.backend && song.backend && song.backend !== t.backend) t.fellBack = true
    if (song.backend) t.backend = song.backend
    if (song.metingTrack) t.metingTrack = song.metingTrack
    // 搜索接口常常不带封面（album.picUrl 为空），只有详情接口才有。
    // 解析成功就把详情里的元数据补回曲目，否则这首曲目会一直显示空封面。
    if (song.cover && song.cover !== t.cover) t.cover = song.cover
    if (!t.title && song.title) t.title = song.title
    if (!t.artist && song.artist) t.artist = song.artist
    if (!t.album && song.album) t.album = song.album
    if (!t.duration && song.duration) t.duration = song.duration
    t.resolved = song
    t.resolvedAt = Date.now()
    t.retried = false
    t.failed = false
    t.error = ''
    return { resolved: song, failed: false }
  } catch (e) {
    t.failed = true
    t.error = e instanceof Error ? e.message : String(e)
    return { resolved: null, failed: true }
  }
}

/** 拉歌词；失败只让歌词面板留空，不影响播放。 */
async function loadLyric(t) {
  store.lines = []
  store.trans = []
  store.emit()
  try {
    const data = await apiLyric({
      backend: t.backend,
      id: t.id,
      mid: t.mid,
      title: t.title,
      artist: t.artist,
      metingTrack: t.metingTrack,
    })
    store.lines = parseLrc(data?.lrc ?? '')
    store.trans = parseTranslation(data?.tlrc ?? '')
  } catch { /* 歌词失败忽略 */ }
  store.emit()
}

function pickBest(songs, want) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')
  const wt = norm(want.title)
  const wa = norm(want.artist)
  let best = null
  let bestScore = -1
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i]
    const st = norm(s.title)
    const sa = norm(s.artist)
    let score = 0
    if (st === wt) score += 10
    else if (st.includes(wt) || wt.includes(st)) score += 6
    if (wa && (sa.includes(wa) || wa.includes(sa))) score += 4
    if (!wa && sa) score += 1
    score += Math.max(0, 2 - i * 0.2)
    if (score > bestScore) { bestScore = score; best = s }
  }
  return bestScore >= 5 ? best : (songs[0] ?? null)
}

/* ================= 全局播放状态（单例，多卡片共享） ================= */

const store = {
  backend: 'netease',
  theme: 'glass',
  customTheme: null,
  lyricMode: 'bubble',
  queue: [],
  pending: [], // 待解析歌单：按顺序解析好一首、入队一首
  autoplayPending: false,
  index: -1,
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.9,
  mode: 'loop', // loop | one | shuffle
  radio: false,
  liked: [],
  lines: [],
  trans: [],
  tab: 'queue',
  panelTab: 'queue', // 悬浮窗里显示的列表：queue | results
  panelLyric: false,
  results: [],
  lastQuery: '',
  status: '',
  statusKind: '',
  failStreak: 0,
  lastFenceKey: '',
  relay: null,
  subs: new Set(),
  emit(kind) { for (const fn of this.subs) fn(kind) },
  get track() { return this.queue[this.index] ?? null },
}

const saveState = (() => {
  let timer = null
  const snapshot = () => ({
    backend: store.backend, theme: store.theme, customTheme: store.customTheme,
    lyricMode: store.lyricMode, volume: store.volume, mode: store.mode, radio: store.radio,
    liked: store.liked, index: store.index,
    // 本地补丁（2026-10-31）：会话视图共享同一份快照 —— 队列、当前曲、谁在出声
    ownerId,
    playing: typeof audio !== 'undefined' ? (!audio.paused && !!audio.src) : false,
    position: typeof audio !== 'undefined' && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    appliedKeys: Array.from(sharedAppliedKeys).slice(-80),
    updatedAt: Date.now(),
    queue: store.queue.map((t) => ({ backend: t.backend, id: t.id, mid: t.mid, title: t.title, artist: t.artist, album: t.album, cover: t.cover, duration: t.duration })),
    pending: store.pending.map((t) => ({ backend: t.backend, id: t.id, mid: t.mid, title: t.title, artist: t.artist, album: t.album, cover: t.cover, duration: t.duration })),
  })
  return () => {
    // 镜像态（别的会话持有播放）不写快照，避免把对方的队列覆盖成自己的旧状态
    if (ownerId && ownerId !== INSTANCE_ID) return
    clearTimeout(timer)
    timer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot())) } catch { /* ignore */ } }, 400)
  }
})()

function hydrate() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    Object.assign(store, {
      backend: s.backend ?? store.backend, theme: s.theme ?? store.theme,
      customTheme: s.customTheme ?? null, lyricMode: s.lyricMode ?? store.lyricMode,
      volume: Number.isFinite(s.volume) ? clamp(s.volume, 0, 1) : 0.9,
      mode: s.mode ?? 'loop', radio: !!s.radio,
      liked: Array.isArray(s.liked) ? s.liked : [],
      queue: Array.isArray(s.queue) ? s.queue : [],
      pending: Array.isArray(s.pending) ? s.pending : [],
      index: Number.isInteger(s.index) ? s.index : -1,
    })
    for (const t of [...store.queue, ...store.pending]) { t.resolved = null; t.failed = false }
  } catch { /* ignore */ }
}

/* ================= 跨会话视图共享同一份播放器状态（本地补丁 2026-10-31） ================= */
/*
 * DSH 桌面版把每个会话放在独立的 WebContentsView（独立文档）里，于是每个会话都有一份
 * dsh-music 实例、各自的 store 与 <audio>。目标：所有会话共享同一份队列，同一时间只有
 * 一个实例出声。做法：把共享状态写进同一个 localStorage 键（STORE_KEY），靠 storage
 * 事件在实例间同步；谁在放，谁就是 owner，其他实例只镜像列表、不发声。
 */
const INSTANCE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
let ownerId = ''              // '' = 无人持有；INSTANCE_ID = 本实例；其他 = 别的会话在放
let remotePausing = false     // 被别的会话抢占导致的暂停，不要回写状态
const sharedAppliedKeys = new Set()
let lastAdoptedRaw = ''       // 最近一次采纳过的快照原文，避免重复处理

function adoptShared(raw) {
  // 同一条快照只处理一次：切会话 / 重复事件不产生多余的重渲染
  if (raw === lastAdoptedRaw) return
  lastAdoptedRaw = raw
  let s
  try { s = JSON.parse(raw) } catch { return }
  if (!s || typeof s !== 'object') return
  if (Array.isArray(s.appliedKeys)) for (const k of s.appliedKeys) sharedAppliedKeys.add(k)

  const otherOwner = !!s.ownerId && s.ownerId !== INSTANCE_ID
  if (otherOwner) {
    // 别的会话在放：本实例立刻静音（避免多路同时出声），但保留它的列表用于展示
    if (!audio.paused) {
      remotePausing = true
      try { audio.pause() } catch { /* ignore */ }
      remotePausing = false
    }
    ownerId = s.ownerId
    // 本实例手里的 <audio> 指向的是自己的旧曲目，清掉避免按播放时放出旧歌
    if (audio.src) { try { audio.removeAttribute('src'); audio.load() } catch { /* ignore */ } }
    const changed = Array.isArray(s.queue) && (
      s.queue.length !== store.queue.length ||
      s.queue.some((t, i) => t.title !== store.queue[i]?.title || t.artist !== store.queue[i]?.artist)
    )
    if (Array.isArray(s.queue)) {
      store.queue = s.queue.map((t) => ({ ...t, resolved: null, failed: false }))
    }
    if (Array.isArray(s.pending)) store.pending = s.pending.map((t) => ({ ...t, resolved: null, failed: false }))
    if (Number.isInteger(s.index)) store.index = s.index
    if (typeof s.backend === 'string') store.backend = s.backend
    if (typeof s.theme === 'string') store.theme = s.theme
    if (typeof s.mode === 'string') store.mode = s.mode
    if (Number.isFinite(s.volume)) store.volume = clamp(s.volume, 0, 1)
    if (!store.playing && Number.isFinite(s.position)) store.position = s.position
    drainToken += 1 // 停掉本实例正在跑的队列解析，避免两边抢
    store.pending = []
    store.emit()
    if (changed && store.queue.length) store.showDock?.()
    return
  }

  // 无人持有（对方暂停 / 关闭）：仍然采纳共享列表，保证每个会话看到的是同一份队列
  ownerId = ''
  if (Array.isArray(s.queue) && s.queue.length) {
    const sameQueue = s.queue.length === store.queue.length &&
      s.queue.every((t, i) => t.title === store.queue[i]?.title && t.artist === store.queue[i]?.artist)
    if (!sameQueue) {
      store.queue = s.queue.map((t) => ({ ...t, resolved: null, failed: false }))
      if (Number.isInteger(s.index)) store.index = s.index
      store.emit()
      store.showDock?.()
    }
  }
}

function installSharedSync() {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORE_KEY || !event.newValue) return
    try { adoptShared(event.newValue) } catch (err) { console.warn('[dsh-music] 共享状态同步失败：', err) }
  })
  // 首次挂载就把别处的列表接过来（切到没播过的会话也能看到同一份歌单）
  syncFromStorage()
}

/** 主动读一次共享快照（切会话时也调用，保证列表立刻对齐）。 */
function syncFromStorage() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) adoptShared(raw)
  } catch { /* ignore */ }
}

/* ================= 音频单例 + 节拍引擎 ================= */

const audio = document.createElement('audio')
audio.preload = 'auto'
audio.style.display = 'none'

function lyricIndexAt(pos) {
  const lines = store.lines
  if (!lines.length) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= pos + 0.2) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function mediaSessionUpdate(t) {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t?.title ?? '未在播放',
      artist: t?.artist ?? '',
      album: t?.album ?? '',
      artwork: t?.cover ? [{ src: t.cover, sizes: '500x500' }] : [],
    })
  } catch { /* ignore */ }
}

async function playIndex(i, { auto = false } = {}) {
  const t = store.queue[i]
  if (!t) return
  store.index = i
  store.position = 0
  store.duration = t.duration ? t.duration / 1000 : 0
  store.emit()
  saveState() // 切歌同步给其他会话视图
  const resolved = await resolveTrack(t)
  if (resolved.failed) {
    audio.pause()
    store.playing = false
    store.position = 0
    store.lines = []
    store.trans = []
    store.status = `「${t.title}」播放失败：${t.error}`
    store.statusKind = 'err'
    store.emit()
    if (auto) {
      store.failStreak += 1
      if (store.failStreak < store.queue.length) setTimeout(() => void next(true), 900)
      else store.status = '队列中的曲目都无法播放，已停止'
    }
    return
  }
  audio.src = resolved.resolved.url
  audio.volume = 1
  try { await audio.play() } catch {
    store.status = '浏览器要求先点击一次播放按钮'
    store.statusKind = ''
  }
  void loadLyric(t)
  mediaSessionUpdate(t)
  const song = resolved.resolved
  const tier = song.tierLabel || (t.fellBack ? `已自动切换到 ${BACKEND_LABEL[t.backend]}` : BACKEND_LABEL[t.backend])
  store.status = `${tier}${song.br ? ` · ${Math.round(song.br / 1000)}kbps` : ''}`
  store.statusKind = ''
  store.emit()
}

async function extendRadio() {
  const t = store.track
  if (!t) return false
  const q = (t.artist ?? '').split(' / ')[0] || t.title
  store.status = `电台：正在寻找「${q}」的相似曲目…`
  store.emit()
  try {
    const found = await apiSearch(store.backend, q, 10)
    const known = new Set(store.queue.map((x) => x.title))
    const fresh = (found.songs ?? []).filter((s) => !known.has(s.title)).slice(0, 5)
    if (!fresh.length) return false
    store.queue.push(...fresh)
    store.status = '电台已为你加歌'
    store.emit()
    return true
  } catch { return false }
}

async function next(auto = false) {
  const n = store.queue.length
  if (!n) return
  let i
  if (store.mode === 'shuffle' && n > 1) {
    do { i = Math.floor(Math.random() * n) } while (i === store.index)
  } else {
    i = store.index + 1
    if (i >= n) {
      if (store.radio) {
        const extended = await extendRadio()
        if (!extended) i = 0
      } else i = 0
    }
  }
  void playIndex(i, { auto })
}

function prev() {
  const n = store.queue.length
  if (!n) return
  if (audio.currentTime > 3.5) { audio.currentTime = 0; return }
  void playIndex((store.index - 1 + n) % n)
}

function setupAudio() {
  audio.volume = 1
  let audioErrorStreak = 0
  audio.addEventListener('play', () => {
    store.playing = true
    // 本地补丁：谁在出声，谁就持有共享播放权，别的会话收到后自动静音
    if (!remotePausing) { ownerId = INSTANCE_ID; saveState() }
    store.emit()
  })
  audio.addEventListener('pause', () => {
    store.playing = false
    if (!remotePausing && ownerId === INSTANCE_ID) { ownerId = ''; saveState() }
    store.emit()
  })
  audio.addEventListener('timeupdate', () => {
    store.position = audio.currentTime
    if (audio.currentTime > 5) {
      // 这一首真的播起来了：清掉重试标记与连续错误计数
      audioErrorStreak = 0
      if (store.track) store.track.retried = false
    }
    if (Number.isFinite(audio.duration) && audio.duration > 0) store.duration = audio.duration
    store.emit('quiet')
  })
  audio.addEventListener('ended', () => {
    if (store.mode === 'one') { audio.currentTime = 0; void audio.play(); return }
    void next(true)
  })
  audio.addEventListener('error', () => {
    if (!audio.src) return
    const t = store.track
    // 直链失效（代理 token 到期等）：清掉缓存重解析一次，还失败才跳下一首
    if (t && !t.retried) {
      t.retried = true
      t.resolved = null
      t.resolvedAt = 0
      store.status = '直链已失效，正在重新解析…'
      store.statusKind = ''
      store.emit()
      void playIndex(store.index, { auto: true })
      return
    }
    if (t) { t.retried = false; t.resolved = null; t.resolvedAt = 0; t.failed = true }
    audioErrorStreak += 1
    // 整张队列轮一遍都失败就停下，别无限跳过（列表会看起来一直在滚）
    if (audioErrorStreak >= Math.max(2, store.queue.length)) {
      audioErrorStreak = 0
      audio.pause()
      store.playing = false
      store.status = '队列里的曲目都无法播放，已停止'
      store.statusKind = 'err'
      store.emit()
      return
    }
    store.status = '音频加载失败，已跳过'
    store.statusKind = 'err'
    store.emit()
    setTimeout(() => void next(true), 800)
  })
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => void audio.play())
      navigator.mediaSession.setActionHandler('pause', () => audio.pause())
      navigator.mediaSession.setActionHandler('previoustrack', () => prev())
      navigator.mediaSession.setActionHandler('nexttrack', () => void next())
    } catch { /* ignore */ }
  }
}

/** 规范化围栏 spec：字段校验与兜底。 */
function normalizeSpec(raw) {
  const spec = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  out.resume = spec.resume === true
  out.theme = spec.theme
  out.backend = spec.backend === 'qq' ? 'qq' : spec.backend === 'netease' ? 'netease' : null
  out.keyword = typeof spec.keyword === 'string' ? spec.keyword.trim() : ''
  out.autoplay = spec.autoplay === true
  out.lyricMode = ['bubble', 'bar', 'none'].includes(spec.lyricMode) ? spec.lyricMode : null
  out.title = typeof spec.title === 'string' ? spec.title.slice(0, 40) : ''
  out.playlist = Array.isArray(spec.playlist)
    ? spec.playlist
      .filter((p) => p && typeof p === 'object' && (p.title || p.id || p.mid))
      .slice(0, 30)
      .map((p) => ({
        backend: p.backend === 'qq' ? 'qq' : p.backend === 'netease' ? 'netease' : null,
        id: p.id != null ? String(p.id) : undefined,
        mid: p.mid != null ? String(p.mid) : undefined,
        title: String(p.title ?? '').slice(0, 120),
        artist: String(p.artist ?? '').slice(0, 120),
        album: String(p.album ?? '').slice(0, 120),
        cover: typeof p.cover === 'string' ? p.cover : '',
        duration: Number(p.duration) || 0,
      }))
    : null
  return out
}

/* ================= DOM channel：围栏观察与接管 ================= */

/** 从 <pre> 向上找围栏表面：第一个"带语言标签子节点且不太大"的祖先。 */
function surfaceOf(pre) {
  let el = pre.parentElement
  for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
    if (el.childElementCount > 5) return pre.parentElement
    for (const child of el.children) {
      if (child === pre || child.contains(pre)) continue
      if (child.childElementCount === 0 && child.textContent.trim() === FENCE_LANG) return el
    }
  }
  return pre.parentElement
}

function findFences(scope) {
  const found = [...scope.querySelectorAll(`code[class*="language-${FENCE_LANG}"]`)]
  const seenPres = new Set(found.map((c) => c.closest('pre')))
  for (const pre of scope.querySelectorAll('pre')) {
    if (seenPres.has(pre)) continue
    const surface = surfaceOf(pre)
    if (!surface || surface.dataset.dshmMounted) continue
    for (const child of surface.children) {
      if (child !== pre && child.childElementCount === 0 && child.textContent.trim() === FENCE_LANG) { found.push(pre); break }
    }
  }
  return found
}

/* ---------- 围栏 → 悬浮窗（对话里不渲染卡片） ---------- */

let lastApplied = { key: '', at: 0 }
/** 播放器里是否已经有"活着"的曲目（正在播或已播过一段）。 */
function musicAlive() {
  return store.queue.length > 0 && store.index >= 0 && (store.playing || store.position > 3)
}

/** 搜索并写入 store.results（悬浮窗的「搜索结果」页读数）。 */
async function searchIntoResults(keyword) {
  store.status = `正在搜索「${keyword}」…`
  store.statusKind = ''
  store.emit()
  try {
    const found = await apiSearch(store.backend, keyword, 10)
    const songs = (found.songs ?? []).map((song) => ({ ...song, resolved: null, failed: false }))
    store.results = songs
    store.lastQuery = keyword
    if (!songs.length) {
      store.status = `没有找到「${keyword}」`
      store.statusKind = 'err'
    } else {
      store.status = `已从${BACKEND_LABEL[store.backend]}找到 ${songs.length} 首`
      store.statusKind = ''
    }
    store.emit()
    return songs
  } catch (error) {
    store.results = []
    store.status = `搜索失败：${error instanceof Error ? error.message : String(error)}`
    store.statusKind = 'err'
    store.emit()
    return []
  }
}

/* ---------- 顺序解析队列：解析好一首入队一首，切歌不再等 ---------- */

let drainToken = 0

/** 接管一份新歌单：清空队列，按顺序逐首解析，就绪一首追加一首。 */
function setPendingTracks(tracks, { autoplay = false } = {}) {
  drainToken += 1
  store.pending = tracks.slice()
  store.queue = []
  store.index = -1
  store.autoplayPending = autoplay
  store.tab = 'queue'
  store.panelTab = 'queue'
  store.emit()
  void drainPending()
}

/** 解析进度只在不播放时占用状态栏，别盖掉正在播放的音质提示。 */
function setPendingStatus() {
  if (store.playing) return
  store.status = store.pending.length
    ? `正在准备队列：还剩 ${store.pending.length} 首…`
    : `队列就绪，共 ${store.queue.length} 首`
  store.statusKind = ''
  store.emit()
}

/** 串行解析 store.pending：不并发、不抢带宽，队列被换掉即自动停止。 */
async function drainPending() {
  const token = ++drainToken
  setPendingStatus()
  while (store.pending.length && token === drainToken) {
    const t = store.pending[0]
    await resolveTrack(t)
    if (token !== drainToken) return
    store.pending.shift()
    store.queue.push(t)
    store.emit()
    saveState()
    // 第一首就绪就开播，后面继续在后台解析
    if (store.autoplayPending && store.queue.length === 1) {
      store.autoplayPending = false
      void playIndex(0, { auto: true })
    }
    setPendingStatus()
  }
  if (token !== drainToken) return
  store.pending = []
  store.autoplayPending = false
  setPendingStatus()
  saveState()
}

/** 已入队但还没解析的曲目：按顺序在后台预热，轮到它时直链已经就绪。 */
async function warmQueue(fromIndex = 0) {
  const token = drainToken
  for (let i = fromIndex; i < store.queue.length; i++) {
    if (token !== drainToken) return
    if (store.pending.length) return // 有新的待解析歌单在跑，让给它
    const t = store.queue[i]
    if (!t || t.failed) continue
    // 已有直链且在安全期内才跳过；过期的预热等于没预热
    if (t.resolved?.url && t.resolvedAt && Date.now() - t.resolvedAt < RESOLVE_TTL_MS) continue
    await resolveTrack(t)
    if (token !== drainToken) return
    store.emit()
    saveState()
  }
}

/** 把一份围栏 spec 直接喂给悬浮播放器：设置主题/后端，取歌单或搜索并开播。 */
async function applyFenceSpec(rawSpec) {
  const spec = normalizeSpec(rawSpec)
  store.showDock?.()
  if (typeof rawSpec?.theme === 'object' && rawSpec.theme) {
    store.customTheme = rawSpec.theme
    store.theme = 'custom'
  } else if (THEMES.includes(spec.theme)) {
    store.theme = spec.theme
    store.customTheme = null
  }
  if (spec.lyricMode) store.lyricMode = spec.lyricMode
  if (spec.backend) store.backend = spec.backend

  // 本地补丁：`{"resume":true}` —— 不换列表，从当前曲目/进度继续播放
  if (spec.resume === true) {
    if (!store.track) return
    if (!audio.paused) return
    if (audio.src) {
      const pos = Number.isFinite(store.position) ? store.position : 0
      if (pos > 1 && Math.abs(audio.currentTime - pos) > 2) {
        try { audio.currentTime = pos } catch { /* ignore */ }
      }
      void audio.play().catch(() => {})
    } else {
      void playIndex(store.index, { auto: true })
    }
    return
  }

  if (spec.playlist?.length) {
    setPendingTracks(
      spec.playlist.map((item) => ({
        backend: item.backend ?? store.backend,
        resolved: null,
        failed: false,
        ...item,
      })),
      { autoplay: spec.autoplay !== false },
    )
    return
  }

  if (!spec.keyword) return
  const songs = await searchIntoResults(spec.keyword)
  if (!songs.length) return
  setPendingTracks(songs.slice(0, 10), { autoplay: spec.autoplay !== false })
}

/**
 * 认领一个围栏：对话里的代码块直接隐藏，播放交给悬浮窗。
 * - 启动 / 切换会话后的「历史消息」只隐藏、不播放，避免一重启就自动放歌；
 * - 10 秒内重复的同一份 spec 只处理一次（防 React 重渲染导致重复起播）。
 */
function consumeFence(surface, spec) {
  if (!surface || surface.dataset.dshmMounted === 'done') return
  surface.dataset.dshmMounted = 'done'
  surface.style.display = 'none'
  const key = JSON.stringify(spec)
  const known = knownFenceKeys.has(key) || sharedAppliedKeys.has(key)
  knownFenceKeys.add(key)
  // 已知围栏（切会话重渲染 / 别的会话里的老卡片）：直接忽略，不重播也不更新界面
  if (known) return
  // 进入会话后最初渲染出来的围栏属于历史消息：登记但不起播
  if (historyMode || Date.now() < freshUntil) return
  const now = Date.now()
  if (key === lastApplied.key && now - lastApplied.at < 10000) return
  lastApplied = { key, at: now }
  // 本地补丁：点歌即接管共享播放权，登记的指纹同步给其他会话
  sharedAppliedKeys.add(key)
  knownFenceKeys.add(key)
  ownerId = INSTANCE_ID
  saveState()
  void applyFenceSpec(spec)
}

function take(codeEl) {
  const pre = codeEl.tagName === 'PRE' ? codeEl : codeEl.closest('pre')
  if (!pre) return
  const surface = surfaceOf(pre)
  if (!surface) return
  if (surface.dataset.dshmMounted === 'done') return
  const body = (codeEl.textContent ?? '').trim()
  let spec = null
  try { spec = JSON.parse(body) } catch { spec = null }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return
  consumeFence(surface, spec)
}

/* ---------- 新版 DSH：按内容识别 dsh-music 围栏 ---------- */

// 只允许 dsh-music 围栏 schema 里的键；出现任何陌生键就不认，
// 避免把用户要的普通 JSON 示例抢过来渲染成播放器。
const SPEC_KEYS = new Set(['theme', 'backend', 'keyword', 'playlist', 'autoplay', 'lyricMode', 'title', 'resume', 'nonce'])

function isMusicSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false
  const keys = Object.keys(spec)
  if (keys.length === 0) return false
  if (keys.some((key) => !SPEC_KEYS.has(key))) return false
  if (spec.resume === true) return true
  const hasKeyword = typeof spec.keyword === 'string' && spec.keyword.trim().length > 0
  const hasPlaylist = Array.isArray(spec.playlist) && spec.playlist.length > 0
  return hasKeyword || hasPlaylist
}

function findCodeBlocks(scope) {
  const out = []
  for (const block of scope.querySelectorAll('.md-code-block')) {
    if (block.dataset.dshmMounted === 'done') continue
    const pre = block.querySelector('pre')
    if (!pre) continue
    out.push({ block, pre })
  }
  return out
}

function takeCodeBlock(block, pre) {
  if (block.dataset.dshmMounted === 'done') return
  const text = (pre.textContent ?? '').trim()
  let spec = null
  try { spec = JSON.parse(text) } catch { spec = null }
  if (!isMusicSpec(spec)) return
  consumeFence(block, spec)
}

/**
 * 历史模式：启动或切换会话后的一小段时间里，DOM 里出现的是「旧消息」，
 * 其中的围栏只隐藏、不触发播放——这样重启应用不会自己放歌。
 */
let historyMode = true
let historyTimer = null
let lastHref = ''
let lastSessionId = ''

/** 当前会话 id：由 sessions 服务注入，拿不到时返回空串。 */
function currentSessionId() {
  try { return store.currentSessionId?.() ?? '' } catch { return '' }
}

function armHistoryMode(ms = 2500) {
  historyMode = true
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => { historyMode = false }, ms)
}

/**
 * 围栏全局共享（本地补丁 2026-10-31）：所有会话共用一份播放器、一份围栏登记表。
 * 任何会话里出现过的围栏都会记进 knownFenceKeys，同一份围栏只驱动播放器一次；
 * 切会话时看到的旧围栏都已是「已知项」，只隐藏、不重播、不替换正在放的队列。
 * 某个会话里新发出的点歌围栏（第一次出现、且不在进入会话后的历史窗口内）照常接管。
 */
const knownFenceKeys = new Set()
let freshUntil = 0

function armFreshWindow(ms = 4000) {
  freshUntil = Date.now() + ms
}

function installDomChannel() {
  armHistoryMode(2500)
  lastHref = location.href
  let scheduled = false
  const scan = () => {
    scheduled = false
    if (document.hidden) return
    // 切会话 / 换路由时重新进入历史模式：旧消息不自动播放
    if (location.href !== lastHref) {
      lastHref = location.href
      armHistoryMode(1500)
    }
    // DSH Web GUI 切会话不一定改 URL，用会话服务的 current 兜底识别：
    // 换会话后的一小段时间里历史围栏只隐藏不播放，避免把正在播的歌顶掉
    const sid = currentSessionId()
    if (sid && lastSessionId && sid !== lastSessionId) {
      armHistoryMode(3000)
      // 本地补丁：进入新会话后的一小段时间里渲染出的围栏属于历史消息，只登记不起播
      armFreshWindow(4000)
    }
    if (sid && !lastSessionId) armFreshWindow(4000)
    if (sid) lastSessionId = sid
    // 1) 旧版宿主：围栏带 language-dsh-music 类名或语言标签文本
    for (const el of findFences(document)) {
      try { take(el) } catch (err) { console.warn('[dsh-music] 围栏挂载失败：', err) }
    }
    // 2) 新版宿主：代码块不再暴露语言类名（标题显示「代码块」），
    //    只能按内容识别——要求 JSON 键名完全落在 dsh-music schema 内，
    //    且带 keyword / playlist，避免误伤普通 JSON 示例。
    for (const { block, pre } of findCodeBlocks(document)) {
      try { takeCodeBlock(block, pre) } catch (err) { console.warn('[dsh-music] 代码块挂载失败：', err) }
    }
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(scan)
  }
  const mo = new MutationObserver(schedule)
  mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  document.addEventListener('visibilitychange', schedule)
  scan()
  return () => {
    clearTimeout(historyTimer)
    mo.disconnect()
    document.removeEventListener('visibilitychange', schedule)
  }
}

/* ================= 悬浮播放器（固定层，不随对话滚动） ================= */

const DOCK_ACCENT = { glass: '#8ab8ff', neon: '#22d3ee', paper: '#e8a250', vapor: '#f0abfc' }

/**
 * 右下角悬浮播放器：折叠态是手机播放器风格的迷你条，展开态是手机全屏播放器面板。
 * 挂在 document.body 上并 position:fixed，因此对话滚动、消息覆盖都不会影响它；
 * 与对话卡片共用同一个全局 store / audio 单例，多卡片与悬浮条永远同步。
 */
function createDock() {
  if (document.querySelector('.dshmd')) return
  const dock = h('div', 'dshmd')
  dock.hidden = true

  const img = document.createElement('img')
  img.alt = ''
  const cover = h('div', 'dshmd-cover')
  cover.appendChild(img)

  const title = h('div', 'dshmd-title', '未在播放')
  const artist = h('div', 'dshmd-artist', '发一张 dsh-music 卡片开始播放')
  const text = h('div', 'dshmd-text')
  text.append(title, artist)

  const btnPrev = h('button', 'dshmd-b', I.prev)
  btnPrev.title = '上一首'
  const btnToggle = h('button', 'dshmd-b main', I.play)
  btnToggle.title = '播放 / 暂停'
  const btnNext = h('button', 'dshmd-b', I.next)
  btnNext.title = '下一首'
  const btnExpand = h('button', 'dshmd-b', icon('<path d="M6 15l6-6 6 6"/>'))
  btnExpand.title = '展开播放器'
  const acts = h('div', 'dshmd-acts')
  acts.append(btnPrev, btnToggle, btnNext, btnExpand)

  const row = h('div', 'dshmd-row')
  row.append(cover, text, acts)
  const barFill = document.createElement('i')
  const bar = h('div', 'dshmd-bar')
  bar.appendChild(barFill)
  const btnClose = h('button', 'dshmd-close', '×')
  btnClose.title = '隐藏悬浮条（下次播放会重新出现）'
  dock.append(row, bar, btnClose)

  /* 展开态：手机全屏播放器 */
  const full = h('div', 'dshmf')
  full.hidden = true
  const fImg = document.createElement('img')
  fImg.alt = ''
  const fCover = h('div', 'dshmf-cover')
  fCover.appendChild(fImg)
  const fTitle = h('span', 'dshmf-title', '未在播放')
  const fSep = h('span', 'dshmf-song-sep', '·')
  const fArtist = h('span', 'dshmf-artist', '')
  const fSong = h('div', 'dshmf-song')
  fSong.append(fTitle, fSep, fArtist)
  const fSeek = h('input', 'dshmf-seek')
  fSeek.type = 'range'
  fSeek.min = '0'
  fSeek.max = '1000'
  fSeek.value = '0'
  const fCur = h('span', '', '0:00')
  const fDur = h('span', '', '0:00')
  const fTimes = h('div', 'dshmf-times')
  fTimes.append(fCur, fDur)
  const fPrev = h('button', '', I.prev)
  const fPlay = h('button', 'play', I.play)
  const fNext = h('button', '', I.next)
  const fMode = h('button', '', I.loop)
  fMode.title = '循环播放 / 单曲播放'
  const fLyricBtn = h('button', '', icon('<path d="M4 6h16"/><path d="M4 12h11"/><path d="M4 18h7"/>'))
  fLyricBtn.title = '歌词'
  const fControls = h('div', 'dshmf-controls')
  fControls.append(fMode, fPrev, fPlay, fNext, fLyricBtn)
  const fCollapse = h('button', 'dshmf-icon-btn', I.chevronDown)
  fCollapse.title = '收起'
  fCollapse.setAttribute('aria-label', '收起')
  const fClose = h('button', 'dshmf-icon-btn', I.close)
  fClose.title = '关闭播放器'
  fClose.setAttribute('aria-label', '关闭')
  const fHead = h('div', 'dshmf-head', '<span class="dshmf-head-label"><i class="dshmf-live"></i>正在播放</span>')
  const fClean = h('button', 'dshmf-icon-btn', I.trash)
  fClean.title = '清理不可播曲目'
  fClean.setAttribute('aria-label', '清理不可播曲目')
  const fHeadActs = h('div', 'dshmf-head-acts')
  fHeadActs.append(fClean, fCollapse, fClose)
  fHead.appendChild(fHeadActs)

  /* 列表：播放队列 / 搜索结果 */
  const fTabQueue = h('button', 'dshmf-tab', '播放队列')
  const fTabResults = h('button', 'dshmf-tab', '搜索结果')
  const fTabs = h('div', 'dshmf-tabs')
  fTabs.append(fTabQueue, fTabResults)
  const fSearchInput = h('input', '')
  fSearchInput.placeholder = '搜索歌曲 / 歌手…'
  const fSearchBtn = h('button', '', '搜索')
  const fSearch = h('div', 'dshmf-search')
  fSearch.append(fSearchInput, fSearchBtn)
  const fList = h('div', 'dshmf-list')

  const fLyricBox = h('div', 'dshmf-lyricbox')
  /* 封面 / 歌词共用同一块定尺舞台：切换只换内容，不改布局尺寸 */
  const fVisual = h('div', 'dshmf-visual')
  fVisual.append(fCover, fLyricBox)

  full.append(fHead, fVisual, fSong, fSeek, fTimes, fControls, fTabs, fSearch, fList)

  document.body.append(dock, full)

  /* ---- 拖动（折叠条与展开面板共用同一个位置，位置记在 localStorage） ---- */
  const POS_KEY = 'dsh-music.dock.pos.v1'
  let pos = null
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null') } catch { pos = null }
  if (pos && (!Number.isFinite(pos.x) || !Number.isFinite(pos.y))) pos = null
  let suppressClickUntil = 0

  const place = () => {
    for (const el of [dock, full]) {
      if (!pos) {
        el.style.left = ''
        el.style.top = ''
        el.style.right = ''
        el.style.bottom = ''
        continue
      }
      el.style.left = `${pos.x}px`
      el.style.top = `${pos.y}px`
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    }
  }
  /* 顶部禁区：DSH 页眉是 Electron 的窗口拖拽区（-webkit-app-region: drag）。
     播放器一旦停进那块区域，指针事件会被窗口拖拽吞掉，就再也抓不住了
     （表现为「拖动播放器变成拖动整个 DSH 窗口」）。所以把可停靠范围限制在页眉下方。 */
  const isDragRegion = (node) => {
    for (let n = node; n; n = n.parentElement) {
      let v = ''
      try {
        const cs = getComputedStyle(n)
        v = cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || ''
      } catch { /* ignore */ }
      if (v) return String(v).trim() === 'drag'
    }
    return false
  }
  // 从页面顶部往下扫出拖拽区底边；扫不到时桌面端退回保守高度，浏览器端不限制
  const headerGuardHeight = () => {
    let bottom = 0
    try {
      const x = Math.round((window.innerWidth || 0) / 2)
      if (x > 0 && typeof document.elementFromPoint === 'function') {
        for (let y = 0; y <= 140; y += 2) {
          const hit = document.elementFromPoint(x, y)
          if (hit && isDragRegion(hit)) bottom = y + 2
          else if (bottom) break
        }
      }
    } catch { bottom = 0 }
    if (bottom) return bottom + 6
    // 兜底：量一下顶部贴边的固定/粘性页眉（个别版本读不到 -webkit-app-region）
    let fallback = 0
    try {
      const vw = window.innerWidth || 0
      const nodes = document.querySelectorAll('header,[role="banner"],[class*="titlebar"],[class*="Titlebar"],[class*="topbar"],[class*="header"],[class*="Header"]')
      for (const el of nodes) {
        const r = el.getBoundingClientRect()
        if (r.top <= 1 && r.height >= 16 && r.height <= 140 && r.width >= vw * 0.5) fallback = Math.max(fallback, r.bottom)
      }
    } catch { fallback = 0 }
    if (fallback) return fallback + 6
    return isDesktopApp() ? 56 : 0
  }
  let topGuard = headerGuardHeight()
  const clampPos = (x, y, el) => {
    const rect = el.getBoundingClientRect()
    const w = rect.width || 320
    const h = rect.height || 120
    const minY = Math.max(8, topGuard)
    return {
      x: clamp(x, 8, Math.max(8, window.innerWidth - w - 8)),
      y: clamp(y, minY, Math.max(minY, window.innerHeight - h - 8)),
    }
  }

  let drag = null
  let inPip = false
  const startDrag = (el) => (event) => {
    if (inPip) return
    if (event.button !== undefined && event.button !== 0) return
    if (event.target.closest?.('button') || event.target.closest?.('input')) return
    topGuard = headerGuardHeight()
    const rect = el.getBoundingClientRect()
    drag = { el, dx: event.clientX - rect.left, dy: event.clientY - rect.top, sx: event.clientX, sy: event.clientY, moved: false }
    // 不在这里 preventDefault：否则可能连带吞掉点击（点歌名要能展开）
  }
  const onMove = (event) => {
    if (!drag) return
    if (!drag.moved && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) < 4) return
    drag.moved = true
    document.body.style.userSelect = 'none'
    try { window.getSelection?.()?.removeAllRanges() } catch { /* ignore */ }
    pos = clampPos(event.clientX - drag.dx, event.clientY - drag.dy, drag.el)
    place()
    // 浏览器/Web 版拖到窗口边缘：DOM 无法直接渲染到窗口外，自动转成独立小窗
    // 桌面版（Electron）宿主禁止窗口创建，保持窗口内拖动
    if (!floatWin && !isDesktopApp() && (event.clientX >= window.innerWidth - 3 || event.clientY >= window.innerHeight - 3 ||
      event.clientX <= 2 || event.clientY <= 2)) {
      drag = null
      document.body.style.userSelect = ''
      suppressClickUntil = Date.now() + 400
      void togglePip()
    }
  }
  const onUp = () => {
    if (!drag) return
    const moved = drag.moved
    drag = null
    document.body.style.userSelect = ''
    if (moved) {
      suppressClickUntil = Date.now() + 260
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* ignore */ }
    }
  }
  row.addEventListener('pointerdown', startDrag(dock))
  fHead.addEventListener('pointerdown', startDrag(full))
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('resize', () => {
    topGuard = headerGuardHeight()
    if (!pos) return
    pos = clampPos(pos.x, pos.y, full.hidden ? dock : full)
    place()
  })
  // 恢复上次位置时也要过一遍禁区夹取，否则历史位置在页眉里会一直卡住
  if (pos) pos = clampPos(pos.x, pos.y, full)
  place()

  let dismissed = false
  let lastTrackKey = ''
  let seekHeld = false

  const show = () => {
    const t = store.track
    if (!t) return
    const key = `${t.title}|${t.artist}|${store.index}`
    if (key !== lastTrackKey) {
      lastTrackKey = key
      dismissed = false
    }
    dock.hidden = dismissed || !full.hidden
  }
  // 供围栏驱动时重新唤出悬浮窗（用户手动 × 关闭后，新的播放请求应该重新显示）
  store.showDock = () => {
    dismissed = false
    show()
  }
  const expand = () => {
    if (!store.track) return
    dock.hidden = true
    full.hidden = false
    if (pos) {
      pos = clampPos(pos.x, pos.y, full)
      place()
    }
    sync()
  }
  const collapse = () => {
    full.hidden = true
    if (pos) {
      pos = clampPos(pos.x, pos.y, dock)
      place()
    }
    sync()
  }
  const toggle = () => {
    if (!store.track) return
    if (audio.paused) {
      if (audio.src) void audio.play().catch(() => {})
      else void playIndex(store.index)
    } else audio.pause()
  }

  /* ---- 独立小窗：优先 Document PiP，不支持时退回 window.open ---- */
  let floatWin = null
  const pipSupported = () => typeof window.documentPictureInPicture?.requestWindow === 'function'
  const flashTip = (msg) => {
    const tip = h('div', '', '')
    tip.style.cssText = 'position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:9;padding:5px 12px;' +
      'border-radius:999px;background:rgba(10,12,20,.92);color:#fff;font-size:10px;white-space:nowrap;pointer-events:none'
    tip.textContent = msg
    full.appendChild(tip)
    setTimeout(() => tip.remove(), 2400)
  }
  const leaveFloat = () => {
    if (!floatWin) return
    const win = floatWin
    floatWin = null
    inPip = false
    document.body.appendChild(full)
    full.classList.remove('dshmf-in-pip')
    fCollapse.innerHTML = I.chevronDown
    fCollapse.title = '收起'
    fCollapse.setAttribute('aria-label', '收起')
    try { if (win.document.body.contains(full)) win.document.body.removeChild(full) } catch { /* ignore */ }
    if (floatRestoreCollapsed) {
      full.hidden = true
      dock.hidden = false
      floatRestoreCollapsed = false
    }
    place()
    sync()
  }
  /**
   * 独立小窗的文档不一定已经长好（Document PiP 新窗口、window.open 刚写入骨架），
   * 取 body/head 之前先补一个最小骨架，避免 appendChild 抛异常后只留下一片空白窗口。
   */
  const ensureFloatDoc = (doc) => {
    if (!doc) return false
    if (!doc.body || !doc.documentElement) {
      try {
        doc.open()
        doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
        doc.close()
      } catch { /* ignore */ }
    }
    return !!doc.body
  }
  /** 从迷你条拖出时 full 还是隐藏的，收回主界面时要还原成收起状态 */
  let floatRestoreCollapsed = false
  const attachFloat = (win) => {
    let doc
    try {
      doc = win.document
    } catch (err) {
      try { win.close() } catch { /* ignore */ }
      flashTip('独立小窗不可用：无法访问窗口文档')
      console.warn('[dsh-music] 独立小窗无法访问 document：', err)
      return
    }
    if (!ensureFloatDoc(doc)) {
      try { win.close() } catch { /* ignore */ }
      flashTip('独立小窗不可用：窗口文档未就绪')
      console.warn('[dsh-music] 独立小窗文档没有 body')
      return
    }
    // 关键：从迷你条（dock）拖到边缘时 full 仍是 hidden，直接搬进小窗就是一片空白。
    // 先展开再搬，窗口里才有内容。
    floatRestoreCollapsed = full.hidden
    dock.hidden = true
    full.hidden = false
    floatWin = win
    inPip = true
    try {
      doc.documentElement.style.background = 'transparent'
      doc.body.style.cssText = 'margin:0;background:transparent;overflow:hidden'
      const st = doc.createElement('style')
      st.textContent = DOCK_CSS
      ;(doc.head || doc.documentElement).appendChild(st)
      doc.body.appendChild(full)
    } catch (err) {
      // 搬移失败就把面板退回主界面，别把窗口留成白板
      floatWin = null
      inPip = false
      try { document.body.appendChild(full) } catch { /* ignore */ }
      full.classList.remove('dshmf-in-pip')
      try { win.close() } catch { /* ignore */ }
      flashTip('独立小窗不可用：面板搬移失败')
      console.warn('[dsh-music] 独立小窗搬移失败：', err)
      return
    }
    full.classList.add('dshmf-in-pip')
    // 头部按钮变成「收回主界面」
    fCollapse.innerHTML = I.embed
    fCollapse.title = '收回主界面'
    fCollapse.setAttribute('aria-label', '收回主界面')
    win.addEventListener('pagehide', leaveFloat)
    sync()
  }
  const openFallbackWindow = () => {
    try {
      const win = window.open('', 'dsh-music-float', 'popup=yes,width=300,height=600')
      if (!win) return null
      win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>dsh-music</title></head><body></body></html>')
      win.document.close()
      try { win.resizeTo(300, 600) } catch { /* ignore */ }
      try { win.focus() } catch { /* ignore */ }
      return win
    } catch { return null }
  }
  const togglePip = async () => {
    if (floatWin) {
      try { floatWin.close() } catch { /* ignore */ }
      return
    }
    if (pipSupported()) {
      try {
        const win = await window.documentPictureInPicture.requestWindow({ width: 300, height: 600 })
        try { win.resizeTo(300, 600) } catch { /* ignore */ }
        attachFloat(win)
        return
      } catch (err) {
        console.warn('[dsh-music] Document PiP 不可用，改用独立窗口：', err)
      }
    }
    const win = openFallbackWindow()
    if (win) attachFloat(win)
    else {
      flashTip('当前环境不支持独立小窗')
      console.warn('[dsh-music] 当前环境不支持独立小窗')
    }
  }

  const closePlayer = () => {
    if (floatWin) {
      try { floatWin.close() } catch { /* ignore */ }
    }
    dismissed = true
    dock.hidden = true
    full.hidden = true
    // 关闭悬浮窗即暂停，避免界面藏起来后还在后台放歌
    try { audio.pause() } catch { /* ignore */ }
    store.playing = false
    store.emit()
  }
  const cycleMode = () => {
    store.mode = store.mode === 'one' ? 'loop' : 'one'
    saveState()
    store.emit()
  }

  text.addEventListener('click', () => {
    if (Date.now() < suppressClickUntil) return
    expand()
  })
  btnExpand.addEventListener('click', expand)
  btnClose.addEventListener('click', closePlayer)
  fClose.addEventListener('click', closePlayer)
  // 主窗口：收起成迷你条；小窗里：收回主界面
  fCollapse.addEventListener('click', () => {
    if (floatWin) { try { floatWin.close() } catch { /* ignore */ } return }
    collapse()
  })
  fMode.addEventListener('click', cycleMode)
  btnToggle.addEventListener('click', toggle)
  fPlay.addEventListener('click', toggle)
  btnNext.addEventListener('click', () => void next())
  fNext.addEventListener('click', () => void next())
  btnPrev.addEventListener('click', () => prev())
  fPrev.addEventListener('click', () => prev())
  fSeek.addEventListener('pointerdown', () => { seekHeld = true })
  fSeek.addEventListener('pointerup', () => { seekHeld = false })
  fSeek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (Number(fSeek.value) / 1000) * audio.duration
      store.position = audio.currentTime
    }
  })

  const setCover = (el, url, cssVar, target) => {
    if (el.getAttribute('data-src') === (url || '')) return
    el.setAttribute('data-src', url || '')
    el.src = url || ''
    el.style.display = url ? '' : 'none'
    target.style.setProperty(cssVar, url ? `url("${String(url).replace(/"/g, '%22')}")` : 'none')
  }

  let listSig = ''
  const renderList = () => {
    const tab = store.panelTab
    const items = tab === 'queue' ? store.queue : store.results
    fTabQueue.textContent = `播放队列${store.queue.length ? ` ${store.queue.length}` : ''}`
    fTabResults.textContent = `搜索结果${store.results.length ? ` ${store.results.length}` : ''}`
    fTabQueue.classList.toggle('on', tab === 'queue')
    fTabResults.classList.toggle('on', tab === 'results')
    const sig = `${tab}|${items.length}|${store.index}|${store.playing}|${items.filter((x) => x.failed).length}`
    if (sig === listSig) return
    listSig = sig
    const rows = items.map((item, i) => {
      const row = h('div', `dshmf-row${tab === 'queue' && i === store.index ? ' act' : ''}`)
      const no = h('span', 'no', tab === 'queue' ? String(i + 1) : '')
      let cov
      if (item.cover) {
        cov = document.createElement('img')
        cov.className = 'cov'
        cov.alt = ''
        cov.loading = 'lazy'
        cov.src = item.cover
        cov.addEventListener('error', () => { cov.replaceWith(h('span', 'cov ph', I.note)) })
      } else {
        cov = h('span', 'cov ph', I.note)
      }
      const meta = h('div', 'meta')
      const tt = h('div', 'tt')
      tt.textContent = item.title || '未知曲目'
      const ar = h('div', 'ar')
      ar.textContent = [item.artist, item.album].filter(Boolean).join(' · ')
      meta.append(tt, ar)
      const bad = Boolean(item.failed)
      if (bad && tab === 'queue') row.classList.add('bad')
      const src = h('span', 'src', bad ? '不可播' : (BACKEND_LABEL[item.backend] ?? ''))
      const play = h('span', 'play', I.play)
      row.append(no, cov, meta, src, play)
      row.addEventListener('click', () => {
        if (tab === 'queue') {
          void playIndex(i)
          return
        }
        store.queue.splice(store.index + 1, 0, { ...item, resolved: null, failed: false })
        void playIndex(store.index + 1)
      })
      return row
    })
    fList.replaceChildren(...rows)
    // 队列切歌后把当前行带进视野（只滚列表，不动整页）
    const activeRow = fList.querySelector?.('.dshmf-row.act')
    activeRow?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  /* 清理不可播：把四档音源都拿不到直链的曲目移出队列，保留正在播放的那首 */
  const cleanUnplayable = () => {
    const bad = store.queue.filter((t) => t.failed)
    if (!bad.length) {
      store.status = '队列里没有不可播的曲目'
      store.statusKind = ''
      store.emit()
      return
    }
    const cur = store.track
    const keepCur = Boolean(cur && !cur.failed)
    store.queue = store.queue.filter((t) => !t.failed)
    if (!store.queue.length) {
      store.index = -1
      store.position = 0
      store.duration = 0
      store.playing = false
      store.lines = []
      store.trans = []
      try { audio.pause(); audio.removeAttribute('src') } catch { /* ignore */ }
      store.status = `已清理 ${bad.length} 首不可播曲目，队列已空`
    } else {
      store.index = keepCur
        ? Math.max(0, store.queue.indexOf(cur))
        : Math.min(Math.max(0, store.index), store.queue.length - 1)
      store.status = `已清理 ${bad.length} 首不可播曲目`
    }
    store.statusKind = ''
    store.failStreak = 0
    listSig = ''
    saveState()
    store.emit()
    if (!keepCur && store.queue.length) void playIndex(store.index)
  }
  fClean.addEventListener('click', cleanUnplayable)

  /* 歌词面板：打开后顶替封面位置 */
  let lyricSig = ''
  const renderLyricBox = () => {
    if (!store.panelLyric) {
      if (lyricSig) {
        fLyricBox.replaceChildren()
        lyricSig = ''
      }
      return
    }
    const lines = store.lines
    const idx = lyricIndexAt(store.position)
    const sig = `${idx}|${lines.length}|${store.track?.title ?? ''}`
    if (sig === lyricSig) return
    lyricSig = sig
    const nodes = []
    if (!lines.length) {
      nodes.push(h('div', 'dshmf-lyric-empty', '暂无歌词'))
    } else {
      for (let k = -1; k <= 1; k++) {
        const i = idx + k
        if (i < 0 || i >= lines.length) {
          nodes.push(h('div', 'dshmf-lb ghost', '·'))
          continue
        }
        const line = h('div', `dshmf-lb${i === idx ? ' act' : ''}`)
        line.textContent = lines[i].text
        nodes.push(line)
      }
    }
    fLyricBox.replaceChildren(...nodes)
    const active = fLyricBox.querySelector?.('.dshmf-lb.act')
    active?.scrollIntoView?.({ block: 'center' })
  }
  const toggleLyricPanel = () => {
    store.panelLyric = !store.panelLyric
    lyricSig = ''
    store.emit()
  }
  fLyricBtn.addEventListener('click', toggleLyricPanel)

  const runPanelSearch = async () => {
    const keyword = fSearchInput.value.trim()
    if (!keyword) return
    store.panelTab = 'results'
    listSig = ''
    // 悬浮窗内搜索只铺结果，不自动播放（点某一行才播）
    await searchIntoResults(keyword)
  }
  fTabQueue.addEventListener('click', () => { store.panelTab = 'queue'; listSig = ''; sync() })
  fTabResults.addEventListener('click', () => { store.panelTab = 'results'; listSig = ''; sync() })
  fSearchBtn.addEventListener('click', runPanelSearch)
  fSearchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') runPanelSearch() })

  const sync = () => {
    const t = store.track
    const accent = store.theme === 'custom'
      ? (store.customTheme?.accent || '#8ab8ff')
      : (DOCK_ACCENT[store.theme] ?? '#8ab8ff')
    for (const el of [dock, full]) el.style.setProperty('--dshmd-accent', accent)
    full.style.setProperty('--dshmf-accent', accent)

    if (!t) {
      dock.hidden = true
      full.hidden = true
      // 队列被清空时把列表也抹掉，避免下次展开看到已删除的残留行
      listSig = ''
      fList.replaceChildren()
      return
    }
    show()

    setCover(img, t.cover, '--dshmd-cover', dock)
    setCover(fImg, t.cover, '--dshmf-cover', full)
    title.textContent = t.title || '未知曲目'
    artist.textContent = [t.artist, BACKEND_LABEL[t.backend]].filter(Boolean).join(' · ')
    fTitle.textContent = t.title || '未知曲目'
    fArtist.textContent = t.artist || ''
    fSep.style.display = fArtist.textContent ? '' : 'none'

    const playing = store.playing
    btnToggle.innerHTML = playing ? I.pause : I.play
    fPlay.innerHTML = playing ? I.pause : I.play
    fMode.innerHTML = store.mode === 'one' ? I.one : I.loop
    fMode.title = store.mode === 'one' ? '单曲播放（点击切回循环）' : '循环播放（点击切单曲）'
    fCover.classList.toggle('playing', playing)

    const pct = store.duration > 0 ? clamp(store.position / store.duration, 0, 1) : 0
    barFill.style.width = `${(pct * 100).toFixed(2)}%`
    fSeek.style.setProperty('--p', `${(pct * 100).toFixed(2)}%`)
    if (!seekHeld) fSeek.value = String(Math.round(pct * 1000))
    fCur.textContent = fmtTime(store.position)
    fDur.textContent = fmtTime(store.duration)
    renderList()
    full.dataset.lyric = store.panelLyric ? '1' : '0'
    fLyricBtn.classList.toggle('on', Boolean(store.panelLyric))
    renderLyricBox()
  }

  store.subs.add(sync)
  sync()
}

/* ================= apply ================= */

function apply(ctx) {
  if (typeof document === 'undefined') return () => {}

  // 设置页「账号」区块：扫码登录网易云 / 登录状态 / 退出登录。
  // 走 settings.section 槽位（与官方设置页同一套契约），不新增侧边栏或常驻播放器。
  // 放在 boot 守卫之前，插件热重载时也能重新登记。
  const LOCALE_NS = 'settings.dshMusic'
  let tr = null
  try {
    if (ctx?.locale?.register) {
      const off = ctx.locale.register(LOCALE_NS, {
        zh: { nav: '音乐账号' },
        en: { nav: 'Music account' },
      })
      if (typeof off === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => off, 'dsh-music: locale dictionary')
      }
      tr = ctx.locale.bind?.(LOCALE_NS) ?? null
    }
  } catch (error) {
    console.warn('[dsh-music] 语言包注册失败：', error)
  }
  try {
    if (ctx?.slots?.inject && getReact()) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-music-account',
        order: 40,
        locale: LOCALE_NS,
        label: () => (tr ? tr('nav') : '音乐账号'),
        inject: () => ({}),
      }, MusicAccountSection))
    }
  } catch (error) {
    console.warn('[dsh-music] 设置页注册失败：', error)
  }

  if (window.__DSH_MUSIC_BOOTED__) return () => {}
  window.__DSH_MUSIC_BOOTED__ = true

  const style = document.createElement('style')
  style.id = 'dshm-style'
  style.textContent = DOCK_CSS
  document.head.appendChild(style)

  hydrate()
  document.body.appendChild(audio)
  setupAudio()
  createDock()
  installSharedSync()
  // 本地补丁：别的会话点过歌，这个会话一进来就该看到同一份列表
  if (store.queue.length) { store.showDock?.(); store.emit() }

  // 刷新/重启时：有待入队的曲目就接着按顺序解析；否则把队列里还没解析的曲目预热好
  if (store.pending.length) void drainPending()
  else if (store.queue.length) void warmQueue(Math.max(0, store.index + 1))

  // sessions 可选注入：有会话服务时启用「AI 推荐」回传通道
  ctx?.inject?.(['sessions'], (scope) => {
    const sessions = scope.get?.('sessions') ?? scope.sessions
    if (!sessions?.list?.getSnapshot || !sessions?.scope) return
    store.currentSessionId = () => {
      try { return sessions.list.getSnapshot().current ?? '' } catch { return '' }
    }
    store.relay = (text) => {
      try {
        const sid = sessions.list.getSnapshot().current
        const conv = sid ? sessions.scope(sid)?.get('conversation') : null
        void conv?.send(text)
        return true
      } catch { return false }
    }
  })

  return installDomChannel()
}

/* ================= 设置页：账号（扫码登录网易云） ================= */

let ReactLib = null
let ReactTried = false
/** 惰性取 react：围栏卡片/播放器半区本身零 React 依赖，只有设置页需要。 */
function getReact() {
  if (!ReactTried) {
    ReactTried = true
    try { ReactLib = require('react') } catch { ReactLib = null }
  }
  return ReactLib
}

const ACCOUNT_API = `${API_BASE}`

const acctStyles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '520px' },
  title: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 600 },
  intro: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
  card: {
    display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)', background: 'var(--dsw-alias-bg-layer-1, transparent)',
  },
  dot: (on) => ({ width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto', background: on ? '#22c55e' : '#9ca3af' }),
  name: { fontWeight: 600, fontSize: '13px' },
  sub: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
  row: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
  btn: {
    font: 'inherit', fontSize: '12px', height: '28px', padding: '0 12px', borderRadius: '8px', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: 'inherit',
  },
  btnPrimary: {
    font: 'inherit', fontSize: '12px', height: '28px', padding: '0 12px', borderRadius: '8px', cursor: 'pointer',
    border: '1px solid transparent', background: 'var(--dsw-alias-brand-primary, #4f6ef7)', color: '#fff',
  },
  btnDanger: {
    font: 'inherit', fontSize: '12px', height: '28px', padding: '0 12px', borderRadius: '8px', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', background: 'transparent', color: '#b42318',
  },
  qrBox: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '14px',
    borderRadius: '12px', border: '1px dashed var(--dsw-alias-border-l2, #e5e7eb)',
  },
  qr: { width: '200px', height: '200px', borderRadius: '8px', background: '#fff', display: 'block' },
  msg: (err) => ({ margin: 0, fontSize: '12px', lineHeight: '18px', color: err ? '#b42318' : 'var(--dsw-alias-label-tertiary, #8b93a1)' }),
}

async function accountGet(path) {
  const res = await fetch(`${ACCOUNT_API}/${path}`)
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.error) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

/** 「账号」区块：显示登录状态、扫码登录、退出登录。 */
function MusicAccountSection() {
  const React = getReact()
  if (!React) return null
  const { createElement: e, useState, useEffect, useCallback, useRef } = React
  const [status, setStatus] = useState('loading')
  const [account, setAccount] = useState(null)
  const [qr, setQr] = useState(null)
  const [phase, setPhase] = useState('idle')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef(null)
  const alive = useRef(true)
  const startLoginRef = useRef(null)
  const autoRefreshes = useRef(0)

  const stopPolling = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const body = await accountGet('account')
      if (!alive.current) return
      setAccount(body)
      setStatus('ready')
    } catch (error) {
      if (!alive.current) return
      setStatus('error')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const poll = useCallback((key) => {
    stopPolling()
    const tick = async () => {
      try {
        const body = await accountGet(`login/qr/check?key=${encodeURIComponent(key)}`)
        if (!alive.current) return
        if (body.code === 803) {
          stopPolling()
          autoRefreshes.current = 0
          if (body.ok) {
            setPhase('success')
            setMessage('登录成功，已生效')
            setQr(null)
            await loadStatus()
          } else {
            setPhase('error')
            setMessage(body.message ?? '登录失败')
          }
          return
        }
        if (body.code === 800) {
          stopPolling()
          setPhase('expired')
          // 二维码约 60s 过期：自动换一张（连续两次仍过期就留给用户手动刷新）
          if (autoRefreshes.current < 2) {
            autoRefreshes.current += 1
            setMessage('二维码已过期，正在自动刷新…')
            timer.current = setTimeout(() => startLoginRef.current?.(), 600)
          } else {
            setMessage('二维码已过期，请点击刷新')
          }
          return
        }
        setPhase(body.code === 802 ? 'scanned' : 'waiting')
        setMessage(body.message ?? '')
        timer.current = setTimeout(tick, 1800)
      } catch (error) {
        if (!alive.current) return
        stopPolling()
        setPhase('error')
        setMessage(error instanceof Error ? error.message : String(error))
      }
    }
    timer.current = setTimeout(tick, 1200)
  }, [loadStatus, stopPolling])

  const startLogin = useCallback(async () => {
    stopPolling()
    setBusy(true)
    setPhase('loading')
    setMessage('正在获取二维码…')
    try {
      const body = await accountGet('login/qr/create')
      if (!alive.current) return
      setQr(body)
      setPhase('waiting')
      setMessage('请用网易云音乐 App 扫码')
      poll(body.key)
    } catch (error) {
      if (!alive.current) return
      setPhase('error')
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [poll, stopPolling])
  startLoginRef.current = startLogin

  const logout = useCallback(async () => {
    setBusy(true)
    autoRefreshes.current = 0
    try {
      await accountGet('logout')
      if (!alive.current) return
      setQr(null)
      setPhase('idle')
      setMessage('已退出登录')
      await loadStatus()
    } catch (error) {
      if (!alive.current) return
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [loadStatus])

  useEffect(() => {
    alive.current = true
    void loadStatus()
    return () => {
      alive.current = false
      stopPolling()
    }
  }, [loadStatus, stopPolling])

  const loggedIn = Boolean(account?.loggedIn)
  const nickname = account?.nickname || ''

  return e('div', { style: acctStyles.wrap },
    e('div', { style: acctStyles.card },
      e('span', { style: acctStyles.dot(loggedIn) }),
      e('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
        e('span', { style: acctStyles.name }, loggedIn ? '已登录网易云' : '未登录网易云'),
        e('span', { style: acctStyles.sub },
          loggedIn
            ? [nickname || '网易云账号', account?.vipType ? ' · 会员账号' : ' · 免费账号'].filter(Boolean).join('')
            : '未登录时自动跳过会员音源，直接播放免费音源'),
      ),
      e('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
        loggedIn
          ? e('button', { type: 'button', style: acctStyles.btnDanger, disabled: busy, onClick: () => void logout() }, '退出登录')
          : e('button', { type: 'button', style: acctStyles.btnPrimary, disabled: busy, onClick: () => void startLogin() }, '扫码登录网易云'),
      ),
    ),
    qr
      ? e('div', { style: acctStyles.qrBox },
        e('img', { src: qr.qrimg, alt: '网易云登录二维码', style: acctStyles.qr }),
        e('p', { style: acctStyles.msg(phase === 'error') }, message || '请用网易云音乐 App 扫码'),
        e('div', { style: acctStyles.row },
          e('button', { type: 'button', style: acctStyles.btn, onClick: () => void startLogin(), disabled: busy }, '刷新二维码'),
          e('button', { type: 'button', style: acctStyles.btn, onClick: () => { stopPolling(); setQr(null); setPhase('idle'); setMessage('') } }, '收起'),
        ),
      )
      : null,
    !qr && (phase === 'error' || phase === 'expired')
      ? e('p', { style: acctStyles.msg(true) }, message || '获取二维码失败')
      : null,
    e('p', { style: acctStyles.intro },
      '扫码登录后 Cookie 保存在本机 ~/.dsh/music-cookie.json，会员音源立即生效，无需重启。QQ 音乐不使用扫码登录。'),
  )
}

    return { apply, inject, name: 'dsh-music' }
}

for (var __dshMusicId of ['dsh-music', 'dsh-music-plugin']) {
  window.__ModuleLoader__.load({ id: __dshMusicId, factory: __dshMusicClientFactory })
}
