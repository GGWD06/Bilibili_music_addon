# 🗄️ BiliMusic - 数据模型与消息契约 (02_data_models.md)

本文档用于归档 `src/common/` 下的核心数据模型、IndexedDB 表结构、`chrome.storage` 状态快照、统一消息信封与 B 站 DASH 音质字典。

> **当前工程阶段提示**：当前工程已完成目录骨架初始化，下列结构将在 `src/common/constants.js`、`src/common/messaging.js`、`src/common/db.js` 与 `src/common/sanitizer.js` 落地时同步细化为精确字段定义。

---

## 1. 💾 IndexedDB 本地曲库与统计表 (`src/common/db.js`)

| 对象仓库 (Store) | 定位 | 关键设计职责（待代码实现后补充精确主键与索引） |
| :--- | :--- | :--- |
| `tracks` | 曲目主表 | 以 `trackKey`（如 `${bvid}_${cid}`）为主键，记录曲目元数据（BVID、CID、分P序号、标题、分P名、UP主、封面 URL、已存最高 DASH 音质代号 `qualityId`、编码信息、下载 ID `downloadId`、本地归档路径、累计播放次数 `playCount` 与累计听歌时长 `totalPlayedSeconds`） |
| `play_logs` | 听歌流水表 | 记录每次有效播放行为流水（自增 ID、`trackKey`、播放时间戳 `timestamp`、本次有效听歌秒数 `duration`），支撑 Popup「听歌排行榜」按总榜/近期维度聚合渲染 |

---

## 2. 🔐 `chrome.storage` 持久化与状态快照

- **`chrome.storage.session`（易失但跨 SW 休眠持久）**：
  - 存放各 B 站活动标签页的当前曲目实时快照（元数据、解析到的最高 DASH 音质代号、下载状态：`idle` / `checking` / `downloading` / `completed` / `skipped` / `error`）及正在计时的播放会话，确保 Service Worker 休眠唤醒后不丢失上下文。
- **`chrome.storage.local`（跨浏览器重启持久）**：
  - 存放用户全局偏好配置（如工作模式：`AUTO_CAPTURE` 自动捕获并统计 / `STATS_ONLY` 仅听歌统计 / `PAUSED` 暂停、最低触发下载的听歌秒数阈值、是否允许高音质覆盖升级等）。

---

## 3. ✉️ 统一消息信封契约 (`src/common/messaging.js`)

- **设计规范**：所有跨运行域消息（Content ⇄ SW ⇄ Popup）必须经由统一信封组装器构造，并通过 `target` 字段进行路由过滤。
- **典型信封骨架**：
  - `target`：目标域标识（`background` / `popup` / `content`）
  - `action`：动作常量（统一在 `src/common/constants.js` 枚举，如 `TRACK_DETECTED`、`PLAY_PROGRESS`、`REQUEST_DASH_FETCH`、`REVOKE_BLOB_URL`、`MANUAL_DOWNLOAD` 等）
  - `payload`：业务载荷
  - `timestamp` / `tabId`（按需附加）

---

## 4. 🎚️ 状态机与 DASH 音质等级字典 (`src/common/constants.js`)

- **扩展工作模式枚举**：
  - `PAUSED`（待机，灰色图标）
  - `AUTO_CAPTURE`（自动捕获原流 + 统计，红色图标）
  - `STATS_ONLY`（纯听歌统计，绿色图标）
- **B 站 DASH 音质代号映射字典（真实无损/高码率权重）**：
  - 从 `/x/player/wbi/playurl` 的 `data.dash.audio` 与 `data.dash.flac` / `data.dash.dolby` 提取真实音频流：
    - `30251`：Hi-Res 无损（FLAC，权重 `500`，扩展名 `.flac` 或 `.m4a`）
    - `30250`：杜比全景声（Dolby Atmos，权重 `400`，扩展名 `.m4a`）
    - `30280`：高码率 192K（AAC，权重 `300`，扩展名 `.m4a`）
    - `30232`：标准 132K（AAC，权重 `200`，扩展名 `.m4a`）
    - `30216`：流畅 64K（AAC，权重 `100`，扩展名 `.m4a`）
  - 由于直接下载 DASH 原始音频流（零二次重编码），该权重可直接供 `preflight.js` 精确判断是否触发“高音质升级替换”。

---

## 5. 🧹 文件名清洗与归档路径规范 (`src/common/sanitizer.js`)

- **三级文件名清洗流水线**：负责清洗视频主标题、分 P 标题与 UP 主名称，剔除 Windows/macOS 系统非法字符（`\ / : * ? " < > |`）、控制字符、尾随点号/空格与保留设备名。
- **归档相对路径生成器**：生成供 `chrome.downloads.download` 使用的安全相对路径（如 `BiliMusic/UP主 - 视频标题.m4a` 或多 P 合集 `BiliMusic/UP主 - 合集名/P01 - 分P名.m4a`）。
