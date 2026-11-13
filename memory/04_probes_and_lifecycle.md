# 🕵️ BiliMusic - 双世界页面探针与 MV3 生命周期 (04_probes_and_lifecycle.md)

本文档归档 Bilibili 页面双世界探针的 `cacheByCid` 防串曲机制、有效听歌时长统计算法以及 Service Worker 的状态持久化设计（已在 Phase 2 落地）。

---

## 1. 🌐 B 站页面双世界探针 (`src/content/`)

由于 Chrome Content Script 默认在 `ISOLATED` 隔离环境运行，无法直接读取页面的 JS 全局变量或劫持页面自身发起的 `fetch`/`XHR` 请求，本项目采用双世界协同探针：

| 脚本文件 | 运行世界 | 注入时机 | 核心职责 |
| :--- | :--- | :--- | :--- |
| `src/content/probe-main.js` | `MAIN` | `document_start` | 无损劫持 `fetch` 与 `XHR`（先 `clone()` 且全链路 `try/catch`），按 `cid` 隔离缓存 `playurl` 至 `cacheByCid`、按 `bvid` 缓存 `/x/web-interface/(wbi/)?view(/detail)` 至 `viewByBvid`，并辅以 `/x/player/(wbi/)?v2` 提取 `activePlayerCidByBvid`；在 `DOMContentLoaded` 与 250ms 轮询双路径捕获首屏 `window.__playinfo__` 与 `window.__INITIAL_STATE__`；监听 `pushState`/`replaceState`/`popstate` 追踪切 P 与切歌；按后台指令以页面天然 `Referer` 执行 `fetchDashBlob`（支持 `backupUrl` 容灾、`audio/x-m4a` MIME 修正与 10 分钟保底释放定时器）。 |
| `src/content/bridge-isolated.js` | `ISOLATED` | `document_idle` | 双向桥接 `MAIN` 世界与 SW 消息通信；以 1 秒挂钟采样（单步上限 `2.5s`）追踪 `<video>` / `<bwp-video>` 真实播放时长，每累积 `5s` 及切歌/`pause`/`ended`/`pagehide` 时向后台刷盘 `PLAY_HEARTBEAT`；检测 `Extension context invalidated` 时调用 `teardown()` 自动停机；异步中转 `FETCH_DASH_BLOB` ➔ `DASH_BLOB_READY`/`DASH_BLOB_FAILED` 与 `REVOKE_BLOB_URL`。 |

---

## 2. 🛡️ 按 `cid` 索引缓存与严格防串曲机制 (`cacheByCid`)

- **实测痛点**：在 B 站视频播放页停留时，后台会静默发起多个关联推荐视频或悬停预览的 `playurl` XHR 请求（实测单页可触发 5 个以上其他 `bvid`/`cid` 请求）。
- **核心防线**：
  1. **三表隔离缓存**：`cacheByCid`（`Map<cid, PlayinfoEntry>`）、`viewByBvid`（`Map<bvid, VideoMeta>`，弥补 SPA 跳转时 `__INITIAL_STATE__` 不更新问题）与 `activePlayerCidByBvid`（播放器 `v2` 接口兜底）。
  2. **首屏 SSR 绑定**：`tryCaptureSsrPlayinfo()` 在 `DOMContentLoaded` 与 250ms 轮询中捕获 `window.__playinfo__`，且 `ssrBoundCid` 仅绑定至初始页面 `cid` 一次，不冒充后续切歌视频。
  3. **严格比对消费**：`handlePlayurlPayload()` 仅在拦截到的 `cid` 与当前 `currentMeta().cid` 一致时才触发 `TRACK_SNAPSHOT` 推送，非当前曲目静默入缓存不打扰前台。

---

## 3. ⏱️ 真实听歌时长统计算法与触发策略

- **防拖动/防倍速虚增**：
  - `bridge-isolated.js` 基于 `Date.now()` 挂钟时间差在 `!el.paused && !el.ended && el.readyState >= 2` 时累加有效播放秒数（单 tick 上限 `2.5s` 防止电脑休眠唤醒虚增），不受进度条拖动或倍速影响。
- **并发防重复计数 (`withTabQueue`)**：
  - `service-worker.js` 对同 `tabId` 的 `handleTrackDetected` 与 `handlePlayHeartbeat` 采用 FIFO 串行队列 `withTabQueue`，配合 `withSessionLock` 串行写入 `chrome.storage.session`，杜绝临界阈值处并发心跳导致 `playCount` 重复累加。
- **有效播放计数阈值**：
  - 当单次播放会话 `sessionId` 累计时长首次达到 `settings.autoCaptureThresholdSeconds`（默认 `15` 秒）时，置位 `sessionCounted = true` 并为 `tracks.playCount += 1`（Phase 3 将在此节点触发自动捕获）。

---

## 4. 🔄 Service Worker 状态持久化与生命周期管理

- **全自动零手势运行**：打开 B 站 `/video/*` 或 `/list/*` 页面即刻自动探测与统计，无需点击激活授权。
- **Session 快照与清理**：活动标签页状态 `tabStates` 持久化于 `chrome.storage.session`，并在 `chrome.tabs.onRemoved` 关闭标签页时自动清理对应条目；扩展安装/启动时通过 `syncActionBadge` 同步三态角标（`AUTO` 红 / `STAT` 绿 / `OFF` 灰）。
