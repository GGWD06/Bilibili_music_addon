# Bilibili_music_addon

**BiliMusic 原流捕获与听歌统计** —— 零构建依赖的 Chrome Manifest V3 扩展与配套 Node.js 独立桌面音乐播放器。

## ✨ 核心特性

- **DASH 原流直下（零二次重编码）**：在页面 `MAIN` 世界以天然 `Referer` 拉取 Bilibili DASH 音频流（支持 Hi-Res FLAC / 杜比全景声 / 高码率 AAC），自动修正音频 MIME 并按 `.m4a` 容器落盘，内置 `backupUrl` 容灾。
- **按 `cid` 隔离防串曲**：通过 `cacheByCid` 隔离后台推荐位预加载请求，兼顾首屏 `window.__playinfo__` 与 SPA 切 P / 切歌场景。
- **高音质升级与智能归档**：支持本地文件失活检测重下、更高音质自动升级替换、分 P 自动归类子目录及三级文件名安全清洗。
- **三态工作模式与本地统计**：支持 `纯统计`（默认，防普通视频误下载）、`自动捕获`（播放满 15 秒自动收歌）与 `已暂停` 三种模式，按 `sessionId` 合并真实播放时长并生成听歌排行榜。
- **独立桌面播放器联动 (`player/`)**：内置零外部依赖 Node.js 本地播放器（`http://127.0.0.1:19527`），支持 HTTP `206` Range 音频流、自定义歌单、红心收藏、4 种播放模式与插件端双向统计同步。

## 📁 项目结构

| 路径 | 说明 |
| :--- | :--- |
| `manifest.json` | Chrome MV3 清单（要求 Chrome ≥ 116，原生 ESM） |
| `src/content/` | 双世界内容脚本（`probe-main.js`、`bridge-isolated.js`） |
| `src/background/` | Service Worker 调度、预检去重、下载落盘与播放器同步 |
| `src/common/` | 公共常量、消息信封、IndexedDB 封装与文件名清洗器 |
| `src/popup/` | `360x520` 双 Tab 控制面板（实时控台 / 听歌排行榜） |
| `player/` & `start-player.bat` | 独立桌面音乐播放器服务与前端界面 |
| `tests/` | 基于 Node.js 原生 `node --test` 的单元与集成测试 |
| `memory/` & `CHANGELOG.md` | 架构文档、数据模型、避坑指南与变更日志 |

## 🚀 快速开始

### 1. 加载 Chrome 扩展
1. 打开 Chrome 访问 `chrome://extensions/`，开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本项目根目录。
3. 建议在 B 站播放音乐视频时使用，默认处于 **纯统计 (`STATS_ONLY`)** 模式，可在扩展 Popup 中手动一键下载原流或切换至 **自动捕获 (`AUTO_CAPTURE`)**。

### 2. 启动配套桌面播放器（可选）
需要本地 **Node.js** 环境：
- Windows 可直接双击根目录 `start-player.bat`；
- 或在终端执行：
  ```bash
  node player/start.mjs
  ```
启动后会自动拉起本地音频服务（`http://127.0.0.1:19527`）并打开独立桌面播放器窗口，与 Chrome 扩展实时双向同步曲目与听歌次数。

## 🧪 运行测试

```bash
node --test tests/*.test.mjs
```
