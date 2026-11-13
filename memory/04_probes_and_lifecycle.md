# 🕵️ BiliMusic - 双世界页面探针与 MV3 生命周期 (04_probes_and_lifecycle.md)

本文档归档 Bilibili 页面双世界探针的数据抓取机制、有效听歌时长统计算法以及 Service Worker 的状态持久化设计。

---

## 1. 🌐 B 站页面双世界探针 (`src/content/`)

由于 Chrome Content Script 默认在 `ISOLATED` 隔离环境运行，无法直接读取页面的 JS 全局变量或劫持页面自身发起的 `fetch`/`XHR` 请求，本项目采用双世界协同探针：

| 脚本文件 | 运行世界 | 注入时机 | 核心职责 |
| :--- | :--- | :--- | :--- |
| `src/content/probe-main.js` | `MAIN` | `document_start` | 抢在 B 站播放器初始化前劫持 `fetch` 与 `XMLHttpRequest`，捕获 `/x/player/wbi/playurl` 中的 DASH 音频流列表（`audio` / `flac` / `dolby`）；等待并读取 `window.__INITIAL_STATE__` 获取分 P 清单、BVID、CID、标题、封面与 UP 主信息；劫持 `history.pushState` / `replaceState` 及 `popstate` 追踪 SPA 无刷新切歌；按需执行页面侧 DASH 音频流 `fetch` 转 `Blob URL`。 |
| `src/content/bridge-isolated.js` | `ISOLATED` | `document_idle` | 双向桥接 `MAIN` 世界与 Service Worker 的消息通信；查找页面 `<video>` 元素并绑定播放事件（`play`、`pause`、`ended`、`timeupdate`），按真实播放秒数增量（不受倍速或拖进度条欺骗）向后台上报有效听歌时长。 |

---

## 2. ⏱️ 真实听歌时长统计算法与触发策略

- **防拖动/防倍速虚增**：
  - 在 `bridge-isolated.js` 中，不以 `video.currentTime` 的跳跃差值计算听歌时长（否则用户把进度条从 00:00 拖到 04:00 会被误判为听了 4 分钟），而是基于播放状态下的真实挂钟时间差或连续小步长 `timeupdate` 累加有效听歌秒数。
- **防切歌秒跳垃圾数据**：
  - 用户快速连点切歌时，只有单首累计有效播放达到阈值（如默认 ≥ 15 秒，可在设置中调整或立即自动捕获）才计入有效播放次数 `playCount` 并触发自动归档下载（或支持一开播即刻静默预下载）。

---

## 3. 🔄 Service Worker 状态持久化与内存管理

- **全自动零手势运行**：
  - 弃用 `tabCapture` 后，插件彻底摆脱“每次打开浏览器必须先点击一次插件图标授权”的限制，用户打开任意 B 站视频或享单即可全自动统计与捕获。
- **SW 休眠无损恢复**：
  - Chrome MV3 Service Worker 空闲约 30 秒后会被系统挂起。所有活动标签页的当前曲目快照、下载任务映射（`downloadId -> { tabId, trackKey, blobUrl }`）均实时写入 `chrome.storage.session`，SW 被 `chrome.downloads.onChanged` 或页面消息唤醒时立即从 `storage.session` 恢复上下文。
