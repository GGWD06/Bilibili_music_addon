# ⚠️ BiliMusic - 历史关键决策与开发“避坑”指南 (05_pitfalls.md)

本文档系统归档 `BiliMusic` 在架构选型、Chrome 157 实测验证、MV3 模块边界、B 站探针防串曲与文件落盘过程中沉淀的黄金避坑法则。**在开发、重构或排错前必须查阅本指南。**

---

## 🗺️ 避坑法则全景导航矩阵 (Domain Navigation Matrix)

| 领域代号 | 领域主题 | 规则数 | 关注痛点与技术边界 | 直达索引 |
| :---: | :--- | :---: | :--- | :---: |
| **MV3_ARCH** | ⚙️ 1. Chrome MV3 架构、模块边界与生命周期 | **4** | Content Script ESM 限制、SW 休眠丢失、扩展重载后上下文失效、单测未隔离 `fetch` 污染本地播放器 | [查阅分类 ➔](#mv3_arch) |
| **BILI_PROBE** | 🕵️ 2. Bilibili 页面探针、时序竞态与防串曲 | **3** | `document_start` 无损劫持、首屏 `__playinfo__`、后台推荐预加载串曲 | [查阅分类 ➔](#bili_probe) |
| **DASH_FILE** | 📥 3. DASH 防盗链拉流、MIME 后缀与文件落盘 | **6** | `bilivideo.com` 403 与 DNR 失效、`video/mp4` 改写后缀、`onDeterminingFilename` 冲突、`Blob` 释放、`.bat` UTF-8 吞行、下载目录重定向 | [查阅分类 ➔](#dash_file) |

---

## <a id="mv3_arch"></a>⚙️ 1. Chrome MV3 架构、模块边界与生命周期 (4 项)

### <a id="pitfall-1"></a>#1 Content Script 严禁使用 ES Module `import`/`export` 语法
- **问题根源**：虽然 `service-worker.js` 和 `popup.html` 支持 `"type": "module"`，但 Chrome `manifest.json` 的 `content_scripts` 默认以经典脚本注入，直接使用 `import` 会抛出 `SyntaxError: Cannot use import statement outside a module`。
- **避坑铁律**：`src/content/probe-main.js` 与 `src/content/bridge-isolated.js` 必须保持**零外部依赖的独立单文件**（IIFE 封装），严禁引用 `src/common/` 中的 ESM 模块。

### <a id="pitfall-2"></a>#2 Service Worker 休眠导致内存状态与下载映射丢失
- **问题根源**：MV3 Service Worker 空闲约 30 秒后会被终止进程，所有模块顶层的内存变量（如当前曲目快照、进行中的 `downloadId` 关联信息）会全部清零。
- **避坑铁律**：活动标签页曲目快照（`tabStates`）与进行中的下载映射（`pendingDownloads`）必须同步持久化到 `chrome.storage.session`，SW 唤醒时优先从 `storage.session` 恢复状态。

### <a id="pitfall-3"></a>#3 扩展重新加载后旧标签页触发 `Extension context invalidated`
- **问题根源**：在 `chrome://extensions` 重新加载扩展或扩展更新后，已打开的 B 站标签页中残留的旧 `bridge-isolated.js` 调用 `chrome.runtime.sendMessage` 会抛出 `Error: Extension context invalidated.`。
- **避坑铁律**：`bridge-isolated.js` 中所有 `chrome.runtime.*` 调用与定时器必须检查 `chrome.runtime?.id` 并捕获该异常；一旦检测到上下文失效，立即停止旧脚本的心跳定时器，避免控制台持续报错刷屏。

### <a id="pitfall-14"></a>#14 SW 单元测试未隔离 `globalThis.fetch` 导致假数据写入本地运行中的桌面播放器
- **问题根源**：`DEFAULT_SETTINGS.enablePlayerSync` 默认为 `true`（指向 `http://127.0.0.1:19527`），而 `service-worker.js` 顶层初始化的 `playerSync` 在 `handleTrackDetected`、`handlePlayHeartbeat` 与下载完成回调中会异步调用 `globalThis.fetch` 向本地桌面播放器推送事件。若在桌面播放器（`player/start.mjs`）运行期间执行未屏蔽 `fetch` 的 Node 单元测试（如 `tests/phase2.test.mjs`、`tests/phase3.test.mjs`），测试曲目会被真实写入并持久化到 `player/data/library.json`。
- **避坑铁律**：所有直接导入 `service-worker.js` 的单元测试必须拦截或桩化 `globalThis.fetch`（并在 `finally` 中等待异步微任务排空后再恢复原值），禁止测试期间向 `127.0.0.1:19527` 真实运行实例发包。

---

## <a id="bili_probe"></a>🕵️ 2. Bilibili 页面探针、时序竞态与防串曲 (3 项)

### <a id="pitfall-4"></a>#4 `probe-main.js` 必须在 `document_start` 无损注入且校验 `__INITIAL_STATE__` 同步状态
- **问题根源**：B 站首屏初始化极快，晚注入会错过早期请求；同时在 SPA 切歌时，`location.pathname` 立即改变而 `window.__INITIAL_STATE__.videoData` 会滞后数百毫秒更新。
- **避坑铁律**：`probe-main.js` 锁定 `run_at: "document_start"`；劫持 `fetch`/`XHR` 必须先 `clone()` 且全包裹 `try/catch`；读取 `window.__INITIAL_STATE__` 时必须校验 URL 中的 `bvid` 与 `videoData.bvid` 是否一致，并在路由变化后做延迟二次同步。

### <a id="pitfall-5"></a>#5 首屏 SSR `window.__playinfo__` 不发请求 & 后台预加载触发严重串曲（实测大坑）
- **问题根源**：
  1. 首屏打开视频时，DASH 流内联在 `window.__playinfo__` 中，不发 `playurl` 网络请求；
  2. **更隐蔽的串曲陷阱（Spike 实测捕获）**：用户在看视频 A（如 41 分钟歌单 `cid=43240392504`）时，B 站页面后台会静默发起多达 5 个其他推荐视频（如 5 分钟视频 `cid=1128442355`）的 `/x/player/wbi/playurl` XHR 请求。若用单变量保存最新 `playinfo`，会把 5 分钟推荐视频的音频冠以 41 分钟当前视频的标题存盘！
- **避坑铁律**：必须使用 `cacheByCid`（`Map<cid, PlayinfoEntry>`）按请求 URL 中的 `cid` 隔离缓存所有 `playurl` 响应，首屏 `window.__playinfo__` 仅绑定初始 `cid`；消费音轨时只允许读取 `cacheByCid.get(currentCid)`。

### <a id="pitfall-6"></a>#6 B 站 DASH 音轨容器格式真相：Hi-Res FLAC 实际封装在 fMP4 容器内
- **问题根源**：B 站 DASH 的 `30251`（Hi-Res FLAC）与 `30250`（杜比 E-AC-3）并非裸 `.flac` 文件，而是以 `ftyp` 开头的 **fMP4（Fragmented MP4）** 容器封装。若直接将文件后缀存为 `.flac`，部分严格校验文件头 `fLaC` 魔数的播放器会报错无法打开。
- **避坑铁律**：所有 DASH 音频流落盘扩展名统一使用 **`.m4a`**，并在曲库元数据与 UI 徽章中清晰标注其真实内部编码（`Hi-Res FLAC` / `Dolby Atmos` / `192K AAC`）。

---

## <a id="dash_file"></a>📥 3. DASH 防盗链拉流、MIME 后缀与文件落盘 (6 项)

### <a id="pitfall-7"></a>#7 `bilivideo.com` 源站 403 `SERVER_FORBIDDEN`（DNR 补 `Referer` 对 `chrome.downloads` 失效）
- **问题根源**：经 Chrome 157 实测，当 CDN 节点为 `upos-sz-mirrorcosov.bilivideo.com` 时，在 SW 中直接调用 `chrome.downloads.download(url)`——**即使配置了 `declarativeNetRequest` 动态注入 `Referer` 与 `Origin` 头**——依然会触发 `SERVER_FORBIDDEN`（仅落盘 548 字节的 403 HTML）；而同一时刻页面上下文 `probe-main.js` 的 `fetch(url)` 则直接返回 `HTTP 206` 正常流。此外，SW 中无 `URL.createObjectURL`。
- **避坑铁律**：彻底弃用 SW 直链下载与 DNR 方案；锁定由 `probe-main.js` 在页面上下文执行 `fetch`（主 `baseUrl` 失败自动切换 `backupUrl`）生成 `Blob URL` 后移交 SW `chrome.downloads.download` 落盘。

### <a id="pitfall-8"></a>#8 CDN 返回 `Content-Type: video/mp4` 导致 Chrome 自动将 `.m4a` 后缀改写为 `.mp4`
- **问题根源**：B 站 CDN 对纯音轨流返回的响应头也是 `Content-Type: video/mp4`。若页面 `fetch` 后直接用 `res.blob()` 生成 `Blob URL`，`blob.type` 会继承 `video/mp4`，导致 `chrome.downloads.download({ filename: 'xxx.m4a' })` 在 Windows 上被 Chrome 自动改写为 `xxx.mp4`，影响部分只扫描 `.m4a` 的音乐播放器。
- **避坑铁律**：在 `probe-main.js` 生成 `Blob` 时，使用 `new Blob([rawBlob], { type: 'audio/x-m4a' })` 将 MIME 显式修正为音频类型，避免被 Chrome 强制改为 `.mp4`。

### <a id="pitfall-9"></a>#9 `chrome.downloads.onDeterminingFilename` 全局钩子覆盖子目录陷阱
- **问题根源**：只要扩展在 SW 中注册了 `chrome.downloads.onDeterminingFilename` 监听器，并对某次下载调用了无参 `suggest()`，Chrome 就会直接丢弃 `chrome.downloads.download({ filename: 'BiliMusic/...' })` 中传入的子目录与自定义文件名，退回默认根目录文件名（Blob 下载退回 UUID 文件名）。
- **避坑铁律**：本扩展严禁注册无差别调用空 `suggest()` 的 `onDeterminingFilename` 监听器；直接使用 `chrome.downloads.download({ filename })` 即可使 `BiliMusic/` 子目录原生生效。

### <a id="pitfall-10"></a>#10 页面侧 `Blob URL` 落盘后必须及时 `revokeObjectURL`
- **问题根源**：每首歌曲的 `Blob` 占 3MB~60MB 内存，若调用 `URL.createObjectURL` 后不释放，连续听歌会导致 B 站标签页内存持续上涨。
- **避坑铁律**：`downloader.js` 监听 `chrome.downloads.onChanged`，一旦状态变为 `complete` 或 `interrupted`，立即通知对应标签页调用 `URL.revokeObjectURL(blobUrl)` 释放内存，同时在页面侧设置 10 分钟保底自动释放定时器。

### <a id="pitfall-11"></a>#11 Windows `.bat` 批处理脚本严禁直接混写 UTF-8 中文（奇数汉字字节吞换行符）
- **问题根源**：Windows `cmd.exe` 默认以 **GBK (CP936)** 双字节编码逐字节解析 `.bat` 文件。若 `.bat` 以 UTF-8 保存且包含奇数个汉字（3 字节/字），行尾残留的半个汉字字节会吞掉换行符及下一行命令开头，导致 `title ...` 乱码且 `cd /d`、`echo` 被截断报错。
- **避坑铁律**：`start-player.bat` 等 Windows 批处理脚本必须全部使用**纯 ASCII 指令**（首行执行 `chcp 65001 >nul` 后将所有中文提示交由 `player/start.mjs` 等 Node.js 脚本输出）。

### <a id="pitfall-12"></a>#12 Windows “下载”文件夹被重定向至非 `USERPROFILE\Downloads` 路径
- **问题根源**：许多 Windows 用户会将“下载”系统目录迁移至其他盘符（如注册表 `User Shell Folders\{374DE290-123F-4565-9164-39C4925E467B}` 为 `D:`，Chrome 即落盘至 `D:\BiliMusic`），而 Node.js `path.join(os.homedir(), 'Downloads', 'BiliMusic')` 只指向 `C:\Users\<user>\Downloads\BiliMusic`，导致首次打开播放器显示 `0` 首歌曲；且当 `User Shell Folders` 返回裸盘符 `D:` 时，Node `path.resolve('D:')` 会受当前工作目录影响。
- **避坑铁律**：`player/lib/scanner.mjs` 必须读取 Windows 注册表真实“下载”路径（裸盘符补全反斜杠 `\`）并检查各盘符根目录下存在的 `BiliMusic`；同时 `store.mjs` 在收到 Chrome 插件推送的 `filename` 时自动反推并纳管实际归档目录。

### <a id="pitfall-13"></a>#13 Node HTTP 流式代理中的 `req.on('close')` 误判与落盘缓存竞态
- **问题根源**：在 Node.js 16+ / 24 的 `http.Server` 中，`GET` 请求的 `req.on('close')` 会在空请求体读取完成时即刻触发（此时上游流响应还没发送完），若用来中止上游 `fetch` 会导致流传输与边下边存失效；此外，若先调用 `res.end()` 再异步执行 `tmpStream.end()` 与 `fsp.rename()`，客户端在收到 `Content-Length` 全部字节后立刻发起的二次 `Range` 请求会错失本地缓存。
- **避坑铁律**：客户端提前断连检测必须监听 `res.on('close', () => { if (!res.writableFinished) ... })`；边听边存时须在确认流完整后先 `await tmpStream.end` + `await fsp.rename(tmpPath, cachePath)`，再调用 `res.end()`，保证缓存原子就绪后再结束 HTTP 响应。
