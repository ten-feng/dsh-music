# dsh-music 🎧

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的音乐播放器插件：模型在回复里输出一个 `dsh-music` 围栏，插件会在右下角唤起**悬浮播放器**（魅族16 物理比例，277×569），自动搜索并播放，不挤占对话区域。

本仓库基于 [jh-Evil/dsh-music](https://github.com/jh-Evil/dsh-music) 定向改造，当前维护仓库：[ten-feng/dsh-music](https://github.com/ten-feng/dsh-music)。新增：

1. **设置页「音乐账号」**：网易云扫码登录（二维码由宿主实时绘制）、登录状态展示、退出登录；Cookie 落盘到 `~/.dsh/music-cookie.json`，无需重启即生效。
2. **四档音源瀑布**：网易云会员 → 网易云免费 → QQ 免费库 → Meting 聚合兜底；未登录自动跳过会员档。
3. **同源音频代理**：第 4 档（以及所有直链）都经宿主 `/plugins/dsh-music/api/stream/<token>` 回源播放，支持 Range 拖动。

围栏本身不再渲染成大卡片：客户端识别到 `dsh-music` 围栏后把它隐藏，直接驱动右下角悬浮播放器；全局单例音频与队列跨围栏共享。

## 功能

- **扫码登录（新增）**：设置 → 音乐账号 → 扫码登录网易云。状态机覆盖「等待扫码 → 已扫码待确认 → 登录成功 / 二维码过期」，过期可一键刷新；登录态写入本地文件，退出登录立即失效。
- **四档瀑布（新增）**：
  1. 网易云会员直链（仅扫码已登录时启用）
  2. 网易云免费直链（匿名 Cookie，始终可用）
  3. QQ 音乐免费库
  4. Meting 聚合（GD Studio / Meting 实例，按歌名 + 歌手搜索后解析直链）
  - 未登录时第 1 档**静默跳过**，不报错、不弹登录提示；
  - 网易云取链失败会先用匿名 Cookie 重试，两档都失败才轮到 QQ；
  - QQ 失败后自动请求 Meting；四档全失败才标记「不可播」并跳下一曲；
  - 原有的「QQ 失败跨回网易云」保留为极端兜底，晚于 Meting 触发。
- **双后端搜索**：网易云（搜索 / 播放直链 / 歌词 / 翻译歌词）、QQ 音乐（搜索 / 歌词 / 封面）。
- **主题**：`glass` 玻璃拟态｜ `neon` 霓虹｜ `paper` 纸感｜ `vapor` 蒸汽波，以及**自定义主题对象**（accent / bg / text / radius）。悬浮窗按主题切换强调色与封面光晕。
- **歌词**：点控制区「歌词」按钮，封面位置切换为三行歌词面板（当前行居中高亮、上下各一行），再点回到封面；开关不改变面板尺寸。
- **界面**：277×569（73.2×150.5mm @96dpi），队列/搜索列表固定展开，搜索框常驻；按住顶部可拖动。Web 版拖到窗口边缘会转为独立悬浮小窗（可拖到桌面任意位置），桌面版受 Electron 宿主限制保持在窗口内。
- **播放器**：搜索、队列（点行切歌 / 插播）、循环 / 单曲 / 随机、进度拖拽、音量、系统 MediaSession（锁屏 / 媒体键）、状态持久化（直链过期自动重新解析）；歌单**按顺序逐首解析、就绪一首入队一首**，切歌不用等直链。

## 安装

```bash
# 从 GitHub 公开库安装（tarball，不需要 git；profile 按你的环境换成 desktop / web）
dsh plugin --profile desktop add https://codeload.github.com/ten-feng/dsh-music/tar.gz/refs/heads/main

# 已把源码 clone 到本地时
dsh plugin --profile desktop add link:/path/to/dsh-music
```

DSH 桌面版没有暴露 `dsh` 命令时，可直接用 pnpm 写入同一个 profile：

```bash
pnpm add https://codeload.github.com/ten-feng/dsh-music/tar.gz/refs/heads/main --dir "%USERPROFILE%\.dsh\profiles\desktop"
```

装完重启 DSH 即可。零运行时依赖，Node ≥ 20。

> 依赖指向 `refs/heads/main`，`pnpm install` 会跟随最新 main；需要固定版本时把 URL 换成某个 tag，例如
> `https://codeload.github.com/ten-feng/dsh-music/tar.gz/refs/tags/v0.2.11`。

> 客户端半区必须走 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 工厂格式
> （与官方客户端插件一致）；直接 `export` 的 ESM 版本不会被宿主加载。

## 使用

对模型说：

- 「放一首周杰伦的晴天」→ 玻璃主题播放器，自动搜索解析播放
- 「来点深夜 lo-fi，蒸汽波主题」→ `{"theme":"vapor","keyword":"深夜 lo-fi"}`
- 「建一个粤语经典歌单，纸感主题」→ playlist 围栏 + `theme:"paper"`
- 「自定义主题，粉色强调色」→ `{"theme":{"accent":"#f9a8d4"}}`

围栏示例（模型自动生成，也可手写测试）：

```dsh-music
{"theme":"glass","backend":"netease","keyword":"周杰伦 晴天","autoplay":true}
```

```dsh-music
{"theme":{"accent":"#f0abfc"},"playlist":[
  {"title":"晴天","artist":"周杰伦"},
  {"title":"Lemon","artist":"米津玄師"}
]}
```

完整字段规范见 [SKILL.md](SKILL.md)。

## 扫码登录

设置 → **音乐账号** → 「扫码登录网易云」，用网易云音乐 App 扫码即可。二维码由宿主按网易云授权链接实时绘制（`/plugins/dsh-music/api/login/qr/create`），前端只负责显示与轮询。

- Cookie 持久化路径：`~/.dsh/music-cookie.json`（可用 `DSH_MUSIC_COOKIE_FILE` 覆盖）。
- 登录/退出后搜索、取链、音频代理立刻使用新 Cookie，**无需重启**。
- QQ 音乐不提供扫码登录，也没有设置页登录入口；`DSH_MUSIC_QQ_COOKIE` 的读取方式保持原样。

## 可选配置（环境变量）

| 变量 | 作用 |
|---|---|
| `DSH_MUSIC_COOKIE_FILE` | 网易云登录态文件路径，默认 `~/.dsh/music-cookie.json` |
| `DSH_MUSIC_NETEASE_COOKIE` | 网易云免费档 Cookie（默认 `appver=2.9.7` 匿名） |
| `DSH_MUSIC_QQ_COOKIE` | QQ 音乐 Cookie：填用户自己的 Cookie 后，QQ 侧免费歌曲有机会直接拿到直链 |
| `DSH_MUSIC_GD_API` | GD Studio 接口地址，默认 `https://music-api.gdstudio.xyz/api.php`；置空则跳过 |
| `DSH_MUSIC_METING_API` | Meting 实例列表（逗号分隔），默认 `api.i-meto.com` / `api.injahow.cn` / `api.moeyao.cn`，按顺序尝试 |

所有音乐请求与音频流都经宿主 Node 侧代理（同源 `/plugins/dsh-music/api/*`），浏览器无跨域问题；插件不收集任何凭据，Cookie 仅随请求发往对应音乐站点。

## 本地预览（不需要 DSH）

```bash
node dev/gen-fixture.mjs   # 生成测试音频/封面/歌词 fixtures
node dev/server.mjs        # http://127.0.0.1:4531/preview.html?spec=glass
```

`?spec=glass|neon|paper|vapor|custom` 切主题；搜索词带 `demo ` 前缀走本地 fixtures（确定性预览），否则走真实音乐接口（失败自动兜底 fixtures）。

## 测试

```bash
node --test test/waterfall.test.mjs test/client-bundle.test.mjs   # 无需网络的单元测试
node test/host-smoke.mjs                                           # 真机接口冒烟（搜索/取链/代理/歌词/扫码）
```

- `waterfall.test.mjs`：四档顺序、未登录跳过会员档、登录后会员失败回退匿名、全失败不抛错、Cookie 落盘与热生效、二维码绘制。
- `client-bundle.test.mjs`：模拟 `__ModuleLoader__`，验证浏览器半区是合法工厂包、`apply/inject` 契约、设置页 `settings.section` 注册。
- `host-smoke.mjs`：用假 cordis ctx 起真实 host，打真实接口（含同源音频代理 Range 请求）。

## 架构

```
index.js                  宿主半区：systemPrompt 区段 + music skill + /plugins/dsh-music/api 路由
src/backends/netease.mjs  网易云适配（同一函数服务会员/免费两档，只切 Cookie）
src/backends/qq.mjs       QQ 音乐适配（保持不变）
src/backends/meting.mjs   Meting / GD Studio 聚合兜底（第 4 档）
src/auth/cookie-store.mjs 登录态文件读写（mtime 缓存，扫码后即时生效）
src/auth/netease-qr.mjs   扫码登录状态机 + 宿主侧二维码绘制
src/media/resolve.mjs     四档瀑布解析（可注入后端，便于测试）
src/media/proxy.mjs       同源音频代理（token + Range）
client.js                 浏览器半区：ModuleLoader 工厂（围栏识别 + 右下角悬浮播放器 + 设置页账号区块）
SKILL.md                  music skill：围栏字段规范与模型行为准则
cordis.patch.yml          bundle 插入声明（dsh plugin add 时并入 profile）
dev/                      预览服务器与 fixtures
test/                     单元测试与宿主冒烟测试
```

关键机制：

- **围栏 → 悬浮播放器**：MutationObserver 观察会话 DOM，发现 `language-dsh-music` 代码块（或 label+pre 结构兜底）且 JSON 解析完整后，隐藏围栏并驱动右下角播放器；启动 / 切会话后的前 2.5 秒属于「历史模式」，只隐藏不播放，避免重启自动放歌。
- **会话切换续播**：执行过的围栏按 spec 指纹记账，切会话导致消息重渲染时只确保悬浮条可见，不会把音乐倒回第一首；切会话另用 `sessions` 服务的 current 兜底识别（DSH Web 切会话不一定改 URL）。
- **渐进队列**：歌单不再一次性塞进队列，而是串行解析、就绪一首追加一首，第一首就绪即开播；已入队但没解析的曲目在后台按顺序预热，轮到它时直链已就绪。
- **LOCAL-FIRST**：搜索 / 切歌 / 切歌词全部在播放器内经插件自身 HTTP 路由完成，零模型往返。
- **多围栏共享**：同一会话里多个围栏驱动同一个播放器单例，队列、进度、音频始终一致。
- **四档瀑布**：宿主 `POST /song` 内部完成，客户端只消费 `song.url`（已是同源代理地址）与 `song.tierLabel`。

## 已知边界

- QQ 音乐免登录直链受腾讯签名限制，仅搜索 / 歌词 / 封面保证可用（插件会自动降级到网易云 / Meting）。
- 网易云 VIP / 下架歌曲在未登录时无直链，会走免费档 / QQ / Meting 兜底。
- 公共 Meting 实例的可用性不由本插件保证：默认列表已经按「能直链才算成功」逐个尝试，也可用 `DSH_MUSIC_METING_API` 换成自建实例（GD Studio 当前仅稳定支持 `source=netease`）。
- 浏览器自动播放策略：首次 `autoplay` 可能需要用户点一次播放按钮（播放器会提示）。
- 独立小窗依赖浏览器的 Document Picture-in-Picture（Chrome/Edge 116+）；DSH 桌面版（Electron）宿主禁止 `window.open` 且未开放窗口 API，播放器只能在 DSH 窗口内拖动。
- 仅供个人学习使用，音乐版权归各平台所有。

## 更新日志

### 0.3.0

- 修复：切换会话时历史围栏被重新执行，音乐倒回第一首（按 spec 指纹去重 + 按会话 id 识别切会话）。
- 改进：歌单按顺序逐首解析、就绪一首入队一首，替代一次性入队；队列里未解析的曲目后台预热，切歌不再等直链。
- 状态栏：解析期间显示「正在准备队列：还剩 N 首…」，播放时不覆盖音质提示。
