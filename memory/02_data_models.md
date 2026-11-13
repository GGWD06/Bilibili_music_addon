# 🗄️ BiliMusic - 数据模型与消息契约 (02_data_models.md)

本文档用于归档 `src/common/` 下的核心数据模型、IndexedDB 表结构、`chrome.storage` 状态快照、统一消息信封与 B 站 DASH 音质字典。

> **当前工程阶段提示**：当前工程已完成架构验证与目录骨架初始化，下列结构将在 `src/common/constants.js`、`src/common/messaging.js`、`src/common/db.js` 与 `src/common/sanitizer.js` 落地时细化为精确代码实现。

---

## 1. 💾 IndexedDB 本地曲库与统计表 (`src/common/db.js`)

| 对象仓库 (Store) | 定位 | 关键设计职责 |
| :--- | :--- | :--- |
| `tracks` | 曲目主表 | 以 `trackKey`（`${bvid}_${cid}`）为主键，记录曲目元数据（`bvid`、`cid`、`p` 分P序号、`title` 主标题、`part` 分P名、`owner` UP主、`cover` 封面 URL、已落盘最高 DASH 音质代号 `qualityId`、编码 `codecs`、Chrome 下载项 `downloadId`、本地归档文件名 `filename`、累计播放次数 `playCount`、累计有效听歌秒数 `totalPlayedSeconds`、最后播放时间 `lastPlayedAt`） |
| `play_logs` | 听歌流水表 | 记录每次有效播放行为流水（自增主键 `id`、索引 `trackKey`、播放时间戳 `timestamp`、本次有效听歌秒数 `duration`），支撑 Popup「听歌排行榜」聚合统计 |

---

## 2. 🔐 `chrome.storage` 持久化与状态快照

- **`chrome.storage.session`（易失但跨 SW 休眠持久）**：
  - `tabStates`：按 `tabId` 存放各 B 站活动标签页的当前曲目实时快照（元数据、当前 `cid` 匹配的可用音轨列表、最高 DASH 音质代号、归档状态：`idle` / `checking` / `downloading` / `completed` / `upgraded` / `skipped` / `error`）。
  - `pendingDownloads`：按 `downloadId` 存放进行中的下载上下文（`{ tabId, trackKey, qualityId, codecs, blobUrl, oldDownloadId, isFallback, trackMeta }`），确保 Service Worker 休眠被唤醒时可完成落盘入库、旧文件清理与 `Blob URL` 释放。
- **`chrome.storage.local`（跨浏览器重启持久）**：
  - 存放用户全局偏好配置（如工作模式 `mode`：`AUTO_CAPTURE` 自动捕获并统计 / `STATS_ONLY` 仅听歌统计 / `PAUSED` 暂停、触发自动下载的有效播放秒数阈值 `autoCaptureThresholdSeconds`、是否允许高音质覆盖升级 `enableQualityUpgrade`）。

---

## 3. ✉️ 统一消息信封契约 (`src/common/messaging.js`)

- **设计规范**：所有跨运行域消息（Content ⇄ SW ⇄ Popup）必须经由统一信封组装器构造，并通过 `target` 字段进行路由过滤。
- **典型信封骨架**：
  - `target`：目标域标识（`background` / `popup` / `content`）
  - `action`：动作常量（统一在 `src/common/constants.js` 枚举，如 `TRACK_DETECTED`、`PLAY_HEARTBEAT`、`FETCH_DASH_BLOB`、`REVOKE_BLOB_URL`、`GET_POPUP_STATE`、`SET_WORK_MODE`、`MANUAL_DOWNLOAD` 等）
  - `payload`：业务载荷
  - `timestamp`：毫秒时间戳

---

## 4. 🎚️ 状态机与 DASH 音质等级字典 (`src/common/constants.js`)

- **扩展工作模式枚举 (`WORK_MODE`)**：
  - `PAUSED`（待机，灰色图标）
  - `AUTO_CAPTURE`（自动捕获原流 + 统计，红色图标）
  - `STATS_ONLY`（纯听歌统计，绿色图标）
- **B 站 DASH 音质代号映射字典 (`DASH_QUALITY_MAP`)**：
  - 从 `/x/player/wbi/playurl`（或首屏 `window.__playinfo__`）的 `dash.flac.audio`、`dash.dolby.audio` 与 `dash.audio` 提取真实音频流。
  - **容器与扩展名说明**：B 站所有 DASH 音频流（含 `30251` Hi-Res FLAC 与 `30250` 杜比 E-AC-3）均封装于 **fMP4（Fragmented MP4，`box=ftyp`）** 容器内，并非裸 `.flac` 容器；因此归档文件扩展名统一使用 **`.m4a`**，确保容器头与扩展名严格匹配并被主流音乐软件扫描入库：
    - `30251`：Hi-Res 无损（fMP4-FLAC，权重 `500`，扩展名 `.m4a`）
    - `30250`：杜比全景声（fMP4-EAC3，权重 `400`，扩展名 `.m4a`）
    - `30280`：高码率 192K（fMP4-AAC，权重 `300`，扩展名 `.m4a`）
    - `30232`：标准 132K（fMP4-AAC，权重 `200`，扩展名 `.m4a`）
    - `30216`：流畅 64K（fMP4-AAC，权重 `100`，扩展名 `.m4a`）

---

## 5. 🧹 文件名清洗与归档路径规范 (`src/common/sanitizer.js`)

- **三级文件名清洗流水线**：负责清洗视频主标题、分 P 标题与 UP 主名称，剔除系统非法字符（`\ / : * ? " < > |`）、控制字符、尾随点号/空格与 Windows 保留设备名。
- **归档相对路径生成器**：
  - 单 P 视频：`BiliMusic/{UP主} - {视频标题}.m4a`
  - 多 P 合集：`BiliMusic/{UP主} - {视频标题}/P{序号} - {分P标题}.m4a`
  - 保底降级路径：`BiliMusic/{bvid}_{cid}_{qualityId}.m4a`
