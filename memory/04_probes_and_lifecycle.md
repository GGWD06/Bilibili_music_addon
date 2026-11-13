# 🕵️ BiliMusic - 双世界页面探针与 MV3 生命周期 (04_probes_and_lifecycle.md)

本文档归档 Bilibili 页面双世界探针的 `cacheByCid` 防串曲机制、有效听歌时长统计算法以及 Service Worker 的状态持久化设计。

---

## 1. 🌐 B 站页面双世界探针 (`src/content/`)

由于 Chrome Content Script 默认在 `ISOLATED` 隔离环境运行，无法直接读取页面的 JS 全局变量或劫持页面自身发起的 `fetch`/`XHR` 请求，本项目采用双世界协同探针：

| 脚本文件 | 运行世界 | 注入时机 | 核心职责 |
| :--- | :--- | :--- | :--- |
| `src/content/probe-main.js` | `MAIN` | `document_start` | 抢在 B 站播放器初始化前无损劫持 `fetch` 与 `XMLHttpRequest`，捕获 `/x/player/wbi/playurl` 响应并存入 `cacheByCid`（`Map<cid, PlayinfoEntry>`）；读取首屏 `window.__playinfo__` 并绑定至初始视频 `cid`；结合 URL 与 `window.__INITIAL_STATE__` 解析当前在播曲目元数据（BVID、CID、分P、标题、封面、UP主）；监听 `history.pushState` / `replaceState` / `popstate` 追踪 SPA 无刷新切 P 与切歌；按需执行页面侧 DASH 音频流 `fetch` 转 `Blob URL`。 |
| `src/content/bridge-isolated.js` | `ISOLATED` | `document_idle` | 双向桥接 `MAIN` 世界与 Service Worker 的消息通信；查找页面 `<video>` 元素并绑定播放事件，按真实播放时间增量上报有效听歌时长。 |

---

## 2. 🛡️ 按 `cid` 索引缓存与严格防串曲机制 (`cacheByCid`)

- **实测痛点**：在 B 站视频播放页停留时，播放器或页面组件会在后台静默发起多个关联推荐视频、悬停预览或连播预加载的 `/x/player/wbi/playurl` 请求（实测单页可触发 5 个以上不同 `bvid`/`cid` 的 XHR 请求）。若探针用单一全局变量保存“最后一次拦截到的 `playinfo`”，会导致当前曲目的标题配上下一首预加载视频的音频流（严重串曲）。
- **核心防线**：
  1. **字典隔离存储**：所有从 `fetch`/`XHR` 拦截到的 `playurl` 响应，必须提取请求 URL 查询参数中的 `cid` 作为 Key 存入 `cacheByCid`（`Map<string, { data, source, bvid, updatedAt }>`），绝不互相覆盖。
  2. **首屏 SSR 绑定**：首屏 `window.__playinfo__` 仅在首次解析出初始页面 `cid` 时绑定入库，不在后续 SPA 跳转时冒充新视频。
  3. **URL 与 `__INITIAL_STATE__` 一致性校验**：在 SPA 切歌瞬间，`location.pathname`（或 `?bvid=`）会立即变化，但 `window.__INITIAL_STATE__.videoData` 存在数百毫秒的异步更新延迟。`currentMeta()` 必须校验 URL 中的 `bvid` 与 `videoData.bvid` 一致后才采信其 `cid` 与标题，并仅从 `cacheByCid.get(currentCid)` 读取当前曲目的音轨列表。

---

## 3. ⏱️ 真实听歌时长统计算法与触发策略

- **防拖动/防倍速虚增**：
  - 在 `bridge-isolated.js` 中，不以 `video.currentTime` 的跳跃差值计算听歌时长（防止用户拖动进度条虚增时长），而是基于 `<video>` 处于正常播放状态（`!video.paused && !video.ended && video.readyState >= 2`）下的真实挂钟秒数累加有效听歌时长。
- **有效播放与自动归档触发**：
  - 每隔固定周期（或切歌/卸载前）向 SW 同步有效播放秒数增量 `PLAY_HEARTBEAT`。
  - 当单首曲目累计有效听歌达到阈值（默认如 `15` 秒，避免用户快速连点切歌产生垃圾记录与无效下载）时，计入 `playCount += 1` 并在 `AUTO_CAPTURE` 模式下自动触发预检与原流归档（同时支持用户在 Popup 随时点击「立即下载」绕过阈值立即归档）。

---

## 4. 🔄 Service Worker 状态持久化与内存管理

- **全自动零手势运行**：
  - 无需用户预先点击插件图标授权，打开任意 B 站视频或歌单即可全自动统计与捕获。
- **SW 休眠无损恢复**：
  - Chrome MV3 Service Worker 空闲约 30 秒后会被系统挂起。所有活动标签页的当前曲目快照（`tabStates`）与进行中的下载任务映射（`pendingDownloads`）均实时写入 `chrome.storage.session`，SW 被 `chrome.downloads.onChanged` 或页面消息唤醒时立即从 `storage.session` 恢复上下文。
