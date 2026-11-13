# 🗄️ BiliMusic - 数据模型与消息契约 (02_data_models.md)

本文档归档 `src/common/` 已落地的数据模型、IndexedDB 表结构、`chrome.storage` 状态快照、统一消息信封与 B 站 DASH 音质字典。

---

## 1. 💾 IndexedDB 本地曲库与统计表 (`src/common/db.js`)

数据库名称：`bilimusic_db`（`DB_VERSION = 1`）。

| 对象仓库 (Store) | 主键 & 索引 | 核心字段定义 |
| :--- | :--- | :--- |
| `tracks` | 主键 `trackKey` (`${bvid}_${cid}`)<br>索引：`bvid`, `cid`, `lastPlayedAt`, `playCount`, `totalPlayedSeconds`, `downloadedAt` | `trackKey`, `bvid`, `cid`, `p`, `totalParts`, `title`, `part`, `owner`, `cover`, `biliPlayCount`, `biliPlayedSeconds`, `playerPlayCount`, `playerPlayedSeconds`, `playCount`, `totalPlayedSeconds`, `firstPlayedAt`, `lastPlayedAt`, `qualityId`, `codecs`, `downloadId`, `filename`, `downloadedAt` |
| `play_logs` | 主键 `id` (`autoIncrement: true`)<br>索引：`trackKey`, `timestamp`, `sessionId` | `id`, `trackKey`, `sessionId`（用于合并单次播放会话心跳）, `timestamp`, `duration`, `counted`（是否已达到有效播放计数阈值） |

核心导出函数：`makeTrackKey`, `openDatabase`, `getTrack`, `getAllTracks`, `upsertTrackMeta`, `recordPlayProgress`, `mergeTracksFromPlayer`, `markTrackDownloaded`, `clearTrackDownload`, `sortLeaderboardItems`, `getLeaderboard`, `clearListeningStats`。

- **跨端汇总规则**：`playCount = biliPlayCount + playerPlayCount`，`totalPlayedSeconds = biliPlayedSeconds + playerPlayedSeconds`（同时保留网页端与桌面播放器端各自明细）。

---

## 2. 🔐 `chrome.storage` 持久化与状态快照 (`STORAGE_KEYS` / `DEFAULT_SETTINGS`)

- **`chrome.storage.session`**（跨 SW 休眠持久）：
  - `tabStates`：按 `tabId` 存放活动标签页的当前曲目元数据、当前 `cid` 音轨列表、最高 DASH 音质代号及下载状态（`DOWNLOAD_STATUS`）。
  - `pendingDownloads`：按 `downloadId` 存放进行中的下载上下文，保证 SW 休眠唤醒后可完成落盘入库、旧文件清理与 `Blob URL` 释放。
  - `playerSyncState`：缓存桌面播放器联机状态、上次同步时间与曲库汇总。
- **`chrome.storage.local`**（键 `settings`，跨浏览器重启持久）：
  - 默认值 `DEFAULT_SETTINGS`：`{ mode: 'STATS_ONLY', autoCaptureThresholdSeconds: 15, enableQualityUpgrade: true, archiveSubfolder: 'BiliMusic', groupMultiPartInSubdir: true, audioMimeType: 'audio/x-m4a', enablePlayerSync: true, playerApiOrigin: 'http://127.0.0.1:19527' }`（默认开启“仅听歌统计 + 按需手动下载”，防止日常看普通视频误触发自动下载）。

---

## 3. ✉️ 统一消息信封契约 (`src/common/messaging.js`)

- **信封格式 (`createEnvelope`)**：`{ __bm: 1, target, action, payload, timestamp, ...meta }`。
- **目标域 (`MSG_TARGET`)**：`background` / `content` / `popup`。
- **动作枚举 (`ACTION`)**：
  - Content ➔ SW：`TRACK_DETECTED`, `PLAY_HEARTBEAT`, `DASH_BLOB_READY`, `DASH_BLOB_FAILED`
  - SW ➔ Content：`FETCH_DASH_BLOB`, `REVOKE_BLOB_URL`
  - Popup ⇄ SW：`GET_POPUP_STATE`, `POPUP_STATE_UPDATED`, `SET_WORK_MODE`, `UPDATE_SETTINGS`, `MANUAL_DOWNLOAD`, `GET_LEADERBOARD`, `CLEAR_STATS`, `SYNC_PLAYER_NOW`, `GET_PLAYER_SYNC_STATUS`, `EXPORT_DOWNLOAD_HISTORY`
  - **已下载音乐清单导出契约 (`src/common/history-export.js`)**：支持 `md`（含 AI 查重提示词与 Markdown 表格）、`json`、`csv`（UTF-8 BOM）三种导出格式；严格仅导出当前仍存在于本地磁盘（`chrome.downloads` 在库未删 / 播放器 `fileExists !== false`）或 Google Drive 云端（`gdriveExists === true`）的已下载曲目，自动剔除已删除历史与未下载记录。
- **路由器与发送封装**：`isEnvelopeFor`, `createMessageRouter`, `sendToBackground`, `notifyPopup`, `sendToTab`。

---

## 4. 🎚️ 状态机与 DASH 音质等级字典 (`src/common/constants.js`)

- **工作模式 (`WORK_MODE`)**：`AUTO_CAPTURE`（红 `AUTO`）、`STATS_ONLY`（绿 `STAT`）、`PAUSED`（灰 `OFF`）。
- **下载状态 (`DOWNLOAD_STATUS`)**：`idle`, `checking`, `downloading`, `completed`, `upgraded`, `skipped`, `unsupported_durl`, `error`。
- **B 站 DASH 音质映射 (`DASH_QUALITY_MAP`)**（均封装于 fMP4 容器，统一扩展名 `.m4a`、`mime: 'audio/x-m4a'`）：
  - `30251`：Hi-Res 无损（`FLAC`, 权重 `500`）
  - `30250`：杜比全景声（`E-AC-3`, 权重 `400`）
  - `30280`：192K 高码率（`AAC`, 权重 `300`）
  - `30232`：132K 标准（`AAC`, 权重 `200`）
  - `30216`：64K 流畅（`AAC`, 权重 `100`）
- **工具函数**：`getQualityInfo`, `compareQuality`, `pickBestAudioTrack`。

---

## 5. 🧹 文件名清洗与归档路径规范 (`src/common/sanitizer.js`)

- **三级流水线**：
  1. `sanitizeSegment`：Unicode `NFC` 归一化 ➔ 剔除控制字符/零宽字符/Windows 非法字符 ➔ 剥离首尾点号空格并消除内部 `..` ➔ 按码点安全截断（防拆分 Emoji 代理对） ➔ 防御 `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` 保留字。
  2. `sanitizeArchiveDir`：剥离斜杠与 `.` / `..` 路径穿越段，生成安全子目录。
  3. `buildArchiveFilename` / `buildFallbackFilename`：单 P 输出 `BiliMusic/{UP主} - {标题}.m4a`，多 P 默认输出 `BiliMusic/{UP主} - {标题}/P{序号} - {分P名}.m4a`（总相对路径长度受控于 180 字符内），保底输出 `BiliMusic/{bvid}_{cid}_{qualityId}.m4a`。

---

## 6. ☁️ 桌面播放器与 Google Drive 云端曲库持久化 (`player/data/`)

所有运行时文件均位于受 `.gitignore` 忽略的 `player/data/` 目录下：

- **`player/data/library.json`** (`player/lib/store.mjs`)：
  - `tracks` 增量支持云端混合字段：`gdriveFileId`, `gdriveRelativePath`, `gdriveSize`, `gdriveModifiedTime`, `gdriveExists`, `playable`（满足 `(fileExists && filePath) || (gdriveExists && gdriveFileId)` 即视为可播）；
  - 纯云端未关联 B 站元数据曲目以 `gdrive_<sha1>` 键入库，后续若发现本地文件或通过 Chrome 插件同步会平滑匹配/迁移并保留红心收藏与歌单归属；
  - `summary` 汇总包含 `localTracks`、`localOnlyTracks`、`cloudTracks`、`cloudOnlyTracks`、`bothTracks`（双端均存在曲目数）。
- **`player/data/gdrive-auth.json`** (`player/lib/gdrive.mjs`)：
  - 存储用户各自的 OAuth `clientId`、`clientSecret`（可选）、`folderInput` / `folderId`、`cacheEnabled`、`accessToken`、`refreshToken`、`expiresAt`、`userEmail`、`displayName`、`lastSyncAt`；`/api/gdrive/status` 仅返回脱敏状态布尔值与邮箱，严禁回传令牌或密钥。
- **`player/data/gdrive-cache/`**：
  - 按 `{safeGdriveFileId}{ext}` 存储完整云端音频缓存，默认上限 `2 GB`（LRU 按文件修改时间淘汰）。
