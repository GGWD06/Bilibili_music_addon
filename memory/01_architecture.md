# 🏛️ BiliMusic - 系统架构与三域拓扑 (01_architecture.md)

本文档归档了 `BiliMusic`（`d:\music_addon`）Chrome Manifest V3 扩展的宏观技术选型、三域运行拓扑、工程目录职责边界与权限矩阵。

---

## 1. 📌 项目宏观概览 (Project Overview)

- **产品定位**：自动解析并捕获 Bilibili 音乐视频 **DASH 原始音频流**（无损 Hi-Res FLAC / 杜比全景声 / 高码率 AAC 直下，fMP4 容器 `.m4a` 落盘，零二次重编码损耗），支持音质升级自动替换、分 P 自动归档与本地听歌排行榜统计的 Chrome 扩展（MV3，`minimum_chrome_version: 116`）。
- **构建哲学**：**原生 ES Modules 零构建依赖**。无需 Webpack 或 Vite 打包，写完代码即可在 Chrome 开发者模式通过“加载已解压的扩展程序”直接调试。
- **捕获路线（经 Chrome 157 实测验证定案）**：采用 **页面侧 `MAIN` 世界天然 `Referer` 拉流（含 `backupUrl` 容灾）➔ 修正音频 MIME 生成 `Blob URL` ➔ SW `chrome.downloads.download` 落盘** 方案。
  - 实测排除项：直接由 SW 调用 `chrome.downloads.download` 下载 `*.bilivideo.com` 源站链接（即使配合 `declarativeNetRequest` 注入 `Referer`）仍会触发 `SERVER_FORBIDDEN`（403）；而页面侧拉流转 `Blob URL` 交由 SW 下载则在所有 CDN 节点下均 100% 稳定落入目标子目录。

---

## 2. 🏛️ 三域运行时拓扑 (MV3 Three-Domain Architecture)

```mermaid
flowchart LR
    subgraph Page ["🌐 B站页面上下文 (Content Scripts)"]
        ProbeMain["probe-main.js<br/>(world: MAIN, document_start)<br/>按 cid 缓存 playurl & 首屏 __playinfo__<br/>读取 __INITIAL_STATE__ & 页面侧拉流转 BlobURL"]
        BridgeIso["bridge-isolated.js<br/>(world: ISOLATED, document_idle)<br/>绑定 video 播放统计事件 & 双向消息桥接"]
        ProbeMain <-->|"window.postMessage"| BridgeIso
    end

    subgraph SW ["⚙️ 后台调度域 (Service Worker, type=module)"]
        ServiceWorker["service-worker.js<br/>全局路由 / 听歌计时汇总 / 状态快照"]
        Preflight["preflight.js<br/>DB 去重 / 本地文件校验 / DASH 音质升级判断"]
        Downloader["downloader.js<br/>chrome.downloads 落盘 / 释放 BlobURL / 旧档清理"]
        ServiceWorker --> Preflight
        ServiceWorker --> Downloader
    end

    subgraph Popup ["🎛️ 瞬态控台域 (Popup 360x520, type=module)"]
        PopupUI["popup.html / popup.css / popup.js<br/>当前曲目与真实音质徽章 / 模式切换 / 听歌排行榜"]
    end

    Common["📦 src/common/ (ESM 共享核心)<br/>constants.js / messaging.js / db.js / sanitizer.js"]

    BridgeIso <-->|"chrome.runtime.sendMessage"| ServiceWorker
    PopupUI <-->|"chrome.runtime.sendMessage"| ServiceWorker
    SW -.-> Common
    Popup -.-> Common
```

---

## 3. 📂 目录结构与模块边界

| 目录 / 文件 | 运行上下文 | 模块规范 | 核心职责 |
| :--- | :--- | :--- | :--- |
| `manifest.json` | 全局清单 | JSON (MV3) | 声明精简权限（`downloads`, `storage`, `tabs`）、主机白名单（含 `127.0.0.1`/`localhost`）与双世界注入规则 |
| `assets/icons/` | 扩展图标 | PNG (16/48/128) | 插件三态图标（待机灰、自动捕获红、纯统计绿） |
| `src/common/` | SW / Popup | ES Modules | `constants.js`、`messaging.js`、`db.js`、`sanitizer.js` |
| `src/content/` | B站页面 (`video/*`, `list/*`) | **独立单文件（禁止 ESM）** | `probe-main.js`（主世界拦截、按 `cid` 缓存与拉流）与 `bridge-isolated.js`（隔离世界桥接与播放统计） |
| `src/background/` | Service Worker | ES Modules | 消息中枢、听歌时长结算、预检去重、音质升级判断、下载落盘、旧文件清理与 `player-sync.js` 桌面端同步 |
| `src/popup/` | Extension Popup | ES Modules | `360x520` 双 Tab 控台（Tab 1 曲目音质/下载控制/播放器联机同步 / Tab 2 本地听歌排行榜） |
| `player/` & `start-player.bat` | 独立桌面软件 (Node.js) | ES Modules | `server.mjs`（本地 HTTP 服务 + `206` Range 音频流 + `fs.watch` 目录监听）、`lib/scanner.mjs`、`lib/store.mjs`（歌单/收藏/跨端计数合并）、`public/`（桌面播放器前端）、`start.mjs`（独立 `--app` 窗口启动器） |

---

## 4. 🔐 权限与配置职责矩阵

| 配置项 / 权限 | 所属分类 | 核心用途 |
| :--- | :--- | :--- |
| `downloads` | API 权限 | 将 DASH 音频 `Blob URL` 按清洗后的子目录归档落盘，并查询校验本地文件是否被误删 |
| `storage` | API 权限 | 访问 `local` 用户配置（工作模式、自动下载开关）与 `session` 当前标签页曲目快照 |
| `tabs` | API 权限 | 获取当前激活 B 站标签页状态、向指定 `tabId` 下发拉流与释放 `Blob URL` 指令 |
| `*://*.bilibili.com/*` | 主机权限 | 允许扩展侧识别与交互 B 站视频页、歌单/合集页接口 |
| `*://*.hdslb.com/*` | 主机权限 | 允许 Popup 控台与排行榜稳定加载 B 站视频封面缩略图 |
| `http://127.0.0.1/*`, `http://localhost/*` | 主机权限 | 允许扩展 Service Worker 与独立桌面播放器 (`player/server.mjs`) 进行本地 HTTP 实时双向同步 |
| `world: "MAIN"` | 注入配置 | 允许 `probe-main.js` 在 `document_start` 劫持 `playurl` 请求、读取 `__INITIAL_STATE__` 并以原站天然 `Referer` 拉取 CDN 音频流 |
