# Bilibili_music_addon (BiliMusic)

**BiliMusic 原流捕获与听歌统计** —— 零构建依赖的 Chrome Manifest V3 扩展与配套 Node.js 独立桌面音乐播放器。

---

## ✨ 核心特性

### 1. Chrome 扩展（DASH 原流直下与听歌统计）
- **DASH 原流无损直下（零二次重编码）**：`MAIN` 世界探针在页面上下文以天然 `Referer` 拉取 B 站 DASH 音频流（支持 `30251` Hi-Res FLAC、`30250` 杜比全景声、`30280` 192K AAC、`30232` 132K AAC、`30216` 64K AAC），内置 `backupUrl` 容灾、显式修正 `audio/x-m4a` MIME 统一按 `.m4a` 容器落盘，并在下载完结或中断后立即回收页面 `Blob URL` 内存。
- **按 `cid` 隔离防串曲**：通过 `cacheByCid`、`viewByBvid` 与 `activePlayerCidByBvid` 三表隔离后台推荐位预加载 `playurl` 请求，兼顾首屏 `window.__playinfo__` 与 SPA 切 P / 切歌场景。
- **三态工作模式与真实听歌统计**：
  - **纯统计 (`STATS_ONLY`，默认，绿标 `STAT`)**：日常刷视频仅记录播放次数与时长，避免误下载；可随时在 Popup 中点击「立即下载 (.m4a)」手动收歌。
  - **自动捕获 (`AUTO_CAPTURE`，红标 `AUTO`)**：有效播放满设定阈值（默认 `15s`）后自动静默捕获归档。
  - **暂停 (`PAUSED`，灰标 `OFF`)**：暂停统计与捕获。
  - 采用挂钟采样（1s 检测、单步上限 2.5s）防止倍速/拖动刷时长，数据持久化至 IndexedDB，并在 `360x520` 双 Tab 控制面板展示当前音质、归档状态与听歌排行榜。
- **音质升级与安全归档**：自动校验本地磁盘文件是否仍存在（被删除后支持重下）；发现更高音质流时自动升级替换旧档。单 P 默认归档为 `BiliMusic/{UP主} - {标题}.m4a`，多 P 合集默认按 `BiliMusic/{UP主} - {标题}/P{序号} - {分P名}.m4a` 分目录归类，全程经过三级文件名安全清洗（过滤非法字符、路径穿越与 Windows 保留设备名）。

### 2. 独立桌面音乐播放器 (`player/`)
- **零外部依赖本地服务**：基于 Node.js 原生模块驱动（默认 `http://127.0.0.1:19527`），自动探测 Windows 注册表真实「下载」目录及常见盘符下的 `BiliMusic` 文件夹并开启 `fs.watch` 实时监听；支持 HTTP `206 Partial Content` Range 音频流。
- **完整曲库与播放体验**：支持 4 种播放模式（列表循环 / 单曲循环 / 列表随机 / 全部音乐随机，基于 Fisher-Yates 洗牌与历史回退栈）、自定义歌单增删改、红心收藏、倍速切换（`1.0x / 1.25x / 1.5x / 0.75x`）、播放队列抽屉，以及按 **「全部 / 本地 + 云端 / 仅本地 / 仅云端 / 未下载」** 筛选曲库。
- **插件端双向统计同步**：扩展与桌面播放器实时互推曲目元数据与播放次数，分别记录并汇总 `B站网页端` 与 `播放器软件` 听歌明细。

### 3. 可选 Google Drive 私人云端曲库
- **个人 OAuth 2.0 PKCE 授权**：零第三方依赖接入各自 Google Drive，每位用户的凭据与 Token 独立保存于本地 `player/data/gdrive-auth.json`（已被 `.gitignore` 忽略）。
- **云端混合曲库与边听边存**：支持指定或自动创建云端 `BiliMusic` 文件夹，与本地曲库智能合并去重；支持 `206 Range` 透传播放、边听边存至本地 LRU 缓存（默认上限 `2 GB`），以及单曲/批量 `4 MiB` 分片断点上传备份（自动保留多 P 子目录结构）。

### 4. 双端导出已下载音乐清单（AI 查重专用）
- Chrome 扩展 Popup 与桌面播放器顶栏（「📋 导出清单」）均支持导出 **Markdown (`.md`，自带 AI 查重提示词)**、**JSON (`.json`)**、**CSV (`.csv`，含 UTF-8 BOM)** 三种格式，支持**一键复制给 AI** 或**导出文件到电脑**。
- 严格过滤掉已在磁盘删除的文件与未下载的纯播放统计视频，仅保留当前真实存在于本地磁盘或 Google Drive 的曲目，便于快速让 AI 排查重复曲目与低音质冗余。

---

## 📁 项目结构

| 路径 | 说明 |
| :--- | :--- |
| `manifest.json` | Chrome MV3 清单（要求 Chrome ≥ 116，原生 ESM） |
| `assets/icons/` | 三态扩展栏图标（`AUTO` 粉 / `STAT` 绿 / `OFF` 灰，`16/48/128px`） |
| `src/content/` | 双世界内容脚本（`probe-main.js` 主世界拦截与拉流、`bridge-isolated.js` 桥接与真实计时） |
| `src/background/` | Service Worker 调度（`service-worker.js`、`preflight.js`、`downloader.js`、`player-sync.js`） |
| `src/common/` | 公共 ESM 模块（`constants.js`、`messaging.js`、`db.js`、`sanitizer.js`、`history-export.js`） |
| `src/popup/` | `360x520` 双 Tab 控台（实时控台 / 听歌排行榜 / 清单导出） |
| `player/` & `start-player.bat` | 独立桌面播放器：`start.mjs`、`server.mjs`、`lib/{scanner,media-stream,store,gdrive}.mjs` 及 `public/` 前端 |
| `tests/` | 基于 Node.js 原生 `node --test` 的单元与集成测试（`common`, `phase2`, `phase3`, `phase4`, `player`） |

---

## 🚀 快速开始

### 环境要求
- **Chrome 扩展**：Google Chrome **116** 及以上版本。
- **桌面播放器与自动化测试（可选）**：**Node.js 18+**。

### 1. 加载 Chrome 扩展
1. 打开 Chrome 访问 `chrome://extensions/`，开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本项目根目录（`d:\music_addon` 或克隆后的仓库根目录）。
3. 打开任意 B 站视频或合集页（若加载或重载扩展前页面已打开，请先刷新对应标签页）；扩展默认处于 **纯统计 (`STATS_ONLY`)** 模式，可在右上角 Popup 控台中手动点击 **立即下载 (.m4a)** 或切换至 **自动捕获 (`AUTO_CAPTURE`)**。

### 2. 启动配套桌面播放器（可选）
- **Windows**：直接双击根目录 `start-player.bat`。
- **命令行**（支持 `--no-open` 不自动弹窗、`--port=<端口号>` 指定端口）：
  ```bash
  node player/start.mjs
  ```
启动后会自动拉起本地音频服务（默认 `http://127.0.0.1:19527`）并以独立桌面应用窗口打开播放器，与 Chrome 扩展实时双向同步曲目与听歌统计。

### 3. 配置 Google Drive 云端曲库（可选）
1. 在桌面播放器右上角点击 **⚙ 设置**，展开 **Google Drive 私人云端曲库**。
2. 按面板内指引在 Google Cloud Console 启用 **Google Drive API**，创建 **Desktop app（桌面应用）** OAuth 客户端，填入自己的 `Client ID` 与 `Client Secret`。
3. （可选）粘贴目标 Google Drive 文件夹链接或 Folder ID；留空则自动查找/创建云端根目录 `BiliMusic`。
4. 点击 **连接 Google Drive** 完成浏览器 OAuth 授权，即可使用侧边栏「☁ 同步」与「☁↑ 上传」。
> 运行时曲库 `library.json`、个人凭据 `gdrive-auth.json` 及云端缓存 `gdrive-cache/` 均位于 `player/data/`（已列入 `.gitignore`，不会被提交到 Git）。

### 4. 导出已下载清单给 AI 查重
- **Chrome 扩展端**：打开 Popup 控台，在「导出下载音乐清单」卡片选择格式后点击 **复制给 AI** 或 **导出文件**。
- **桌面播放器端**：点击顶栏 **📋 导出清单**，选择 `.md` / `.json` / `.csv` 后点击 **复制给 AI 查重** 或 **导出文件到电脑**。

---

## 🧪 运行测试

```bash
node --test tests/*.test.mjs
```
