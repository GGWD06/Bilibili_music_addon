# ⚠️ BiliMusic - 历史关键决策与开发“避坑”指南 (05_pitfalls.md)

本文档系统归档 `BiliMusic` 在架构选型（DASH 原流 vs `tabCapture`）、Chrome MV3 模块边界、B 站探针注入与跨平台文件落盘过程中沉淀的黄金避坑法则。**在开发、重构或排错前必须查阅本指南。**

---

## 🗺️ 避坑法则全景导航矩阵 (Domain Navigation Matrix)

| 领域代号 | 领域主题 | 规则数 | 关注痛点与技术边界 | 直达索引 |
| :---: | :--- | :---: | :--- | :---: |
| **MV3_ARCH** | ⚙️ 1. Chrome MV3 架构、模块边界与生命周期 | **3** | Content Script ESM 限制、SW 休眠丢失、SW 无 `URL.createObjectURL` | [查阅分类 ➔](#mv3_arch) |
| **BILI_PROBE** | 🕵️ 2. Bilibili 页面探针、时序竞态与 DASH 流 | **3** | `document_start` 抢先劫持、`__INITIAL_STATE__` 判空、首屏 SSR 内联 `__playinfo__` | [查阅分类 ➔](#bili_probe) |
| **DASH_FILE** | 📥 3. DASH 防盗链拉流、内存回收与文件落盘 | **3** | CDN 403 防盗链与 `backupUrl` 容灾、`Blob URL` 内存泄漏、Windows 非法字符清洗 | [查阅分类 ➔](#dash_file) |

---

## <a id="mv3_arch"></a>⚙️ 1. Chrome MV3 架构、模块边界与生命周期 (3 项)

### <a id="pitfall-1"></a>#1 Content Script 严禁使用 ES Module `import`/`export` 语法
- **问题根源**：虽然 `service-worker.js` 和 `popup.html` 支持 `"type": "module"`，但 Chrome `manifest.json` 的 `content_scripts` 默认以经典脚本注入，直接使用 `import` 会直接抛出 `SyntaxError: Cannot use import statement outside a module`，导致探针完全失效。
- **避坑铁律**：`src/content/probe-main.js` 与 `src/content/bridge-isolated.js` 必须保持**零外部依赖的独立单文件**（IIFE 封装），严禁引用 `src/common/` 中的 ESM 模块。

### <a id="pitfall-2"></a>#2 Service Worker 休眠导致内存状态与下载映射丢失
- **问题根源**：MV3 Service Worker 空闲约 30 秒后会被终止进程，所有模块顶层的内存变量（如当前曲目快照、进行中的 `downloadId` 关联信息）会全部清零。
- **避坑铁律**：活动标签页曲目快照与进行中的下载映射必须同步持久化到 `chrome.storage.session`（配合 `chrome.storage.local` 存用户配置），SW 唤醒入口必须优先从 `storage.session` 恢复状态。

### <a id="pitfall-3"></a>#3 MV3 Service Worker 中不存在 `URL.createObjectURL`
- **问题根源**：`ServiceWorkerGlobalScope` 原生不支持 `URL.createObjectURL(blob)`。若在 SW 中 `fetch` 音频流转 `Blob`，将无法生成可供 `chrome.downloads.download` 使用的本地 URL（若转 Data URL 则几兆到几十兆的音频会直接撑爆内存或触发 URL 长度限制）。
- **避坑铁律**：DASH 音频流的 `fetch` 与 `URL.createObjectURL(blob)` 统一放在页面 `probe-main.js` 中执行（天然具备 DOM `URL` API 与原站 `Referer`），生成 `blob:https://www.bilibili.com/...` 后传给 SW 调用 `chrome.downloads.download` 落盘。

---

## <a id="bili_probe"></a>🕵️ 2. Bilibili 页面探针、时序竞态与 DASH 流 (3 项)

### <a id="pitfall-4"></a>#4 `probe-main.js` 必须在 `document_start` 注入且安全等待 `window.__INITIAL_STATE__`
- **问题根源**：B 站首屏初始化极快，若探针在 `document_idle` 才注入会错过首屏网络请求；但 `document_start` 阶段 DOM 尚未解析，`window.__INITIAL_STATE__` 尚未挂载。
- **避坑铁律**：`manifest.json` 强制 `probe-main.js` 为 `run_at: "document_start"` 以第一时间劫持 `fetch` / `XHR`；读取 `window.__INITIAL_STATE__` 时必须搭配 `DOMContentLoaded` 监听或轮询兜底，严禁直接解构读取。

### <a id="pitfall-5"></a>#5 首屏直出 `window.__playinfo__` 导致不发 `playurl` XHR/Fetch 请求
- **问题根源**：用户直接打开或刷新 B 站视频页时，首屏首个视频的 DASH 流信息往往由服务端 SSR 直接内联在 HTML 的 `window.__playinfo__` 全局变量中，播放器**不会**再次发起 `/x/player/wbi/playurl` 网络请求（只有切 P、换音质或 SPA 跳转时才发请求）。如果只劫持 `fetch`/`XHR`，首屏第一首歌永远抓不到流！
- **避坑铁律**：`probe-main.js` 必须**双管齐下**——既要在 `DOMContentLoaded` 时主动读取 `window.__playinfo__` 提取首屏 DASH 音频流，又要劫持 `fetch`/`XHR` 捕获后续切 P、切歌与切换音质时的动态 `playurl` 响应。

### <a id="pitfall-6"></a>#6 为什么放弃 `tabCapture` 录音而改用 DASH 原流直下
- **问题根源**：`tabCapture` + `MediaRecorder` 输出的是有损重编码的 WebM/Opus，不仅使 Hi-Res/FLAC 音质升级失去意义，还会受倍速播放、拖进度条、缓冲卡顿和首次点击手势限制困扰。
- **避坑铁律**：锁定 DASH 原流提取方案，对极少数仅有旧版 `durl`（无分离 `dash.audio`）的远古视频做优雅降级（仅统计不下载）。

---

## <a id="dash_file"></a>📥 3. DASH 防盗链拉流、内存回收与文件落盘 (3 项)

### <a id="pitfall-7"></a>#7 B 站 CDN 防盗链 403 与 PCDN/MCDN 节点失效
- **问题根源**：直接将 `*.bilivideo.com` 流地址传给 `chrome.downloads.download` 会因缺少 `Referer: https://www.bilibili.com/` 返回 403 Forbidden；此外 `baseUrl` 经常指向不稳定的 PCDN/MCDN 节点。
- **避坑铁律**：在 `probe-main.js`（B 站页面上下文）中发起 `fetch`，浏览器自动携带合法 `Referer` 与 `Origin`；当 `baseUrl` 请求失败时自动遍历 `backupUrl` 数组重试。

### <a id="pitfall-8"></a>#8 页面侧 `Blob URL` 落盘后必须及时 `revokeObjectURL`
- **问题根源**：每首歌曲的 `Blob` 占 3MB~30MB 内存，若调用 `URL.createObjectURL` 后不释放，连续听歌几小时会导致 B 站标签页内存暴涨甚至崩溃。
- **避坑铁律**：`downloader.js` 监听 `chrome.downloads.onChanged`，一旦状态变为 `complete` 或 `interrupted`，立即通知对应标签页调用 `URL.revokeObjectURL(blobUrl)` 释放内存。

### <a id="pitfall-9"></a>#9 Windows 非法文件名字符、尾随点号与保留字导致 `chrome.downloads` 崩溃
- **问题根源**：B 站视频标题常包含 `: / \ * ? " < > |`、控制符或以 `.` 结尾，直接拼接传给 `chrome.downloads.download` 的 `filename` 会触发 `Invalid filename` 失败。
- **避坑铁律**：所有归档路径与文件名必须经由 `src/common/sanitizer.js` 三级清洗流水线处理，且在 `downloader.js` 中保留降级保底命名重试策略。
