# 📜 BiliMusic 变更日志 (CHANGELOG.md)

本文件按时间线记录 `BiliMusic` 扩展的代码演进、核心修复与架构变更流水。

---

### [2026-11-13] - 调整默认工作模式为 `STATS_ONLY`（防普通视频误触发自动下载）
- **所属模块**：默认配置、图标预设、Popup 与测试 (`src/common/constants.js`, `manifest.json`, `src/background/service-worker.js`, `src/popup/popup.{html,js}`, `tests/phase3.test.mjs`)
- **核心变更**：
  1. 将 `DEFAULT_SETTINGS.mode` 从 `WORK_MODE.AUTO_CAPTURE` 改为 `WORK_MODE.STATS_ONLY`（`syncActionBadge` 与 `popup.js` 兜底默认亦同步切换为 `STATS_ONLY`）。
  2. 为 `manifest.json` 的 `action.default_icon` 配置默认绿色统计图标 `icon-stats-{16,48,128}.png`，并将 Popup 顶部开关顺序调整为「纯统计」置首（同步更新默认胶囊 `STAT`、阈值说明与引导提示文案）。
  3. 保留「自动捕获」作为可选工作模式开关，供专注听歌合集批量收歌时手动开启；日常播放视频仅统计听歌时长，需在 Popup 点击「立即下载原流 (.m4a)」才触发落盘。
- **原因与机理**：用户反馈 B 站日常也会浏览大量非音乐视频，若默认开箱即自动捕获会导致误下载；方案 A 既避免日常误下，又保留批量自动收歌能力。
- **后续注意事项**：若此前已加载扩展并手动切换保存在本地过模式，在 Popup 顶部切换回「纯统计」即可永久生效。

### [2026-11-13] - 完成 Phase 3~4 预检落盘调度、三态扩展图标与双 Tab Popup 控制台
- **所属模块**：Background 下载管线、图标资源与 Popup 控台 (`src/common/constants.js`, `src/background/preflight.js`, `downloader.js`, `service-worker.js`, `src/popup/popup.{html,css,js}`, `assets/icons/*`, `tests/phase3.test.mjs`, `tests/phase4.test.mjs`)
- **核心变更**：
  1. 实现 `preflight.js` 与 `downloader.js` 并接入 `service-worker.js`：打通 `AUTO_CAPTURE` 播放阈值自动触发、`STATS_ONLY` 下 `MANUAL_DOWNLOAD` 手动一键捕获、`chrome.downloads.search` 本地失活清理重下、更高音质替换（`removeFile` + `erase` 旧档）、`FILE_`/`PATH` 中断降级保底文件名重试、`inFlightFinalizes` 锁消除状态竞态，以及完结/失败后通过 `REVOKE_BLOB_URL` 回收页面 `Blob` 内存。
  2. 生成 9 张抗锯齿三态图标（`icon-{16,48,128}.png` 粉 / `icon-stats-*.png` 绿 / `icon-paused-*.png` 灰），在 `MODE_UI_META` 增加 `iconPaths` 并在 `syncActionBadge` 与 Popup 顶部同步切换图标与角标。
  3. 实现 `src/popup/popup.html`、`popup.css` 与 `popup.js`（`360x520`、`overflow-x: hidden`、MV3 CSP 零内联脚本、XSS 安全纯文本 DOM 构建与非阻塞 Toast + 两步内联确认清空统计）：提供「实时控台」与「听歌排行榜」双视图。
  4. 新增 `tests/phase3.test.mjs` 与 `tests/phase4.test.mjs`，全套 `node --test` 12/12 用例与全量 `node --check` 全部通过。
- **原因与机理**：补齐“探针感知 ➔ 预检去重/升格 ➔ 页面侧防盗链拉流与 MIME 修正 ➔ 落盘释放内存 ➔ 用户双 Tab 控台实时观测与手动控制”的完整业务闭环。
- **后续注意事项**：可直接在 Chrome `chrome://extensions/` 加载已解压扩展 `d:\music_addon` 进行真机实听与归档验收；若扩展重新加载前 B 站标签页已打开，需刷新对应 B 站标签页注入最新双世界探针。

### [2026-11-13] - 完成 Phase 2 双世界探针与 Service Worker 听歌统计 MVP
- **所属模块**：Content 双世界探针与 Background 后台 (`src/content/probe-main.js`, `src/content/bridge-isolated.js`, `src/background/service-worker.js`, `tests/phase2.test.mjs`)
- **核心变更**：
  1. 实现 `probe-main.js`：`document_start` 无损劫持 `fetch`/`XHR`，建立 `cacheByCid`、`viewByBvid` 与 `activePlayerCidByBvid` 三表隔离缓存以兼顾首屏 `__playinfo__`、推荐预加载隔离与 SPA 切 P/切歌；同步内置页面侧 `fetchDashBlob`（`backupUrl` 容灾 + `audio/x-m4a` MIME 修正）与 `revokeBlobUrl`。
  2. 实现 `bridge-isolated.js`：以 `1s` 挂钟采样（单步上限 `2.5s`）统计 `<video>`/`<bwp-video>` 真实播放时长，支持切歌/`pause`/`ended`/`pagehide` 刷盘、异步中转 `FETCH_DASH_BLOB` 及 `Extension context invalidated` 安全自停。
  3. 实现 `service-worker.js`：打通 `TRACK_DETECTED`、`PLAY_HEARTBEAT`、`GET_POPUP_STATE`、`SET_WORK_MODE`、`UPDATE_SETTINGS`、`GET_LEADERBOARD`、`CLEAR_STATS` 路由；使用 `withTabQueue` + `withSessionLock` 杜绝并发心跳重复计数，并支持三态角标同步与标签页关闭清理。
  4. 新增 `tests/phase2.test.mjs` 沙箱与集成测试（捕获并顺手修复了 `DOMContentLoaded` 时首屏 `__playinfo__` 尚未等待 250ms 轮询即触发快照的竞态）。
- **原因与机理**：先跑通零音频下载风险的“探针识别 + 防串曲 + 真实听歌计时 + IndexedDB 统计”闭环，再于 Phase 3 挂接预检去重与落盘下载。
- **后续注意事项**：进入 Phase 3（`preflight.js` 与 `downloader.js` 实现，并挂接至 `service-worker.js` 心跳阈值与手动下载入口）。

### [2026-11-13] - 完成 Phase 1 公共基础层 (`src/common/`) 与单元测试
- **所属模块**：Common 公共层与测试 (`src/common/constants.js`, `messaging.js`, `sanitizer.js`, `db.js`, `tests/common.test.mjs`)
- **核心变更**：
  1. 实现 `constants.js`：定义 `WORK_MODE`、`DOWNLOAD_STATUS`、`MSG_TARGET`、`ACTION`、`STORAGE_KEYS`、`DEFAULT_SETTINGS`、`DASH_QUALITY_MAP` 及 `getQualityInfo`/`compareQuality`/`pickBestAudioTrack`。
  2. 实现 `messaging.js`：定义版本化消息信封 `createEnvelope`、`isEnvelopeFor`、`createMessageRouter` 与 `sendToBackground`/`notifyPopup`/`sendToTab`。
  3. 实现 `sanitizer.js`：实现防控制符、非法字符、`..` 穿越、Windows 保留设备名、Emoji 代理对拆断及路径长度控制的 `sanitizeSegment`/`sanitizeArchiveDir`/`buildArchiveFilename`/`buildFallbackFilename`。
  4. 实现 `db.js`：建立 `bilimusic_db`（`tracks` 主表 + `play_logs` 流水表，支持按 `sessionId` 合并同次播放心跳与 `counted` 阈值防虚增），提供 `recordPlayProgress`/`markTrackDownloaded`/`clearTrackDownload`/`getLeaderboard`/`clearListeningStats`。
  5. 新增零依赖 `tests/common.test.mjs`（含轻量内存 `IDBFactory`），5/5 用例全部通过。
- **原因与机理**：先打牢零外部依赖原生 ESM 公共层并通过自动化单元测试验证，消除核心算法与数据库聚合边界隐患。
- **后续注意事项**：进入 Phase 2（`probe-main.js`、`bridge-isolated.js` 与 `service-worker.js` 听歌统计 MVP）。

### [2026-11-13] - 完成下载链路与防串曲 Spike 实测验证，锁定最终架构并更新全套规范文档
- **所属模块**：全局架构设计、避坑指南与演进路线图 (`AGENTS.md`, `MEMORY.md`, `memory/01~06`)
- **核心变更**：
  1. 完成两轮 Chrome 157 真机实测验证并清理临时目录 `spikes/download-test/`。
  2. **锁定下载主路径（T2）**：实测证实 `upos-sz-mirrorcosov.bilivideo.com` 节点下 SW 直链下载（T0）与 DNR 补 `Referer` 直链下载（T1）均返回 `SERVER_FORBIDDEN`（403），而页面侧 `probe-main.js` 执行 `fetch` 生成 `Blob URL` 移交 SW `chrome.downloads.download`（T2）可 100% 稳定落盘至目标子目录并正常释放内存。
  3. **锁定按 `cid` 隔离缓存防串曲机制（`cacheByCid`）**：实测发现单个 B 站视频页后台会静默触发多达 5 个其他推荐视频的 `playurl` XHR 请求，已在架构规范与红线中强制要求按 `cid` 建表缓存并与当前页面在播 `cid` 严格比对。
  4. **锁定 `.m4a` 容器扩展名与音频 MIME 修正**：针对 CDN 返回 `Content-Type: video/mp4` 导致 Chrome 将 `.m4a` 自动改写为 `.mp4` 的现象，在设计中明确构造 `Blob` 时重写 MIME 为 `audio/x-m4a`，且严禁在 SW 注册空 `suggest()` 的 `onDeterminingFilename` 监听器。
- **原因与机理**：在编写正式业务代码前通过实测彻底消除架构盲区，确保 Phase 1~4 零返工推进。
- **后续注意事项**：进入 Phase 1（`src/common/` 四个核心基础模块）正式开发。

### [2026-11-13] - 升级下载链路验证 Spike 至 v2（淘汰 T3 + 按 `cid` 缓存防串曲）
- **所属模块**：一次性验证工具 (`spikes/download-test/`)
- **核心变更**：移除 `onDeterminingFilename` 全局监听器与 T3 逻辑；将 `main.js` 改为 `cacheByCid` 按 `cid` 索引缓存 `playurl` 响应，隔离推荐位/预加载触发的非当前 `cid` 请求。
- **原因与机理**：第 1 轮实测暴露出 `onDeterminingFilename` 空 `suggest()` 覆盖子目录命名，以及推荐预加载 `playurl` 覆盖当前曲目的串曲隐患。
- **后续注意事项**：已完成第 2 轮实测验证并归档清理。

### [2026-11-13] - 新增下载链路验证 Spike（`spikes/download-test/`）
- **所属模块**：一次性验证工具（不属于正式 `src/`）
- **核心变更**：新增独立 MV3 测试扩展，在真实 B 站页面对比 T0 直链 / T1 DNR 补 `Referer` / T2 页面 `Blob URL` 交 SW / T3 页面 `<a download>` + `onDeterminingFilename` 四种 DASH 音频落盘方式。
- **原因与机理**：在正式编码前实测验证跨上下文 `Blob URL` 下载与 CDN 防盗链行为。
- **后续注意事项**：已完成实测并清理目录。

### [2026-11-13] - 架构重构：全面切换至 DASH 原流直下 + 本地听歌统计三域架构
- **所属模块**：全局架构、Manifest 配置与记忆库 (`manifest.json`, `src/`, `AGENTS.md`, `MEMORY.md`, `memory/01~06`)
- **核心变更**：废弃有损重编码的 `tabCapture` + `Offscreen` Web Audio + `ebml-fixer` 四域录音方案，移除 `src/offscreen/` 与 `src/vendor/` 冗余模块，初始化本地 Git 仓库，精简 `manifest.json` 权限为 `["downloads", "storage", "tabs"]`。
- **原因与机理**：针对个人日常自用场景，DASH 原流直下相比 `tabCapture` 录音具备真无损原盘、几秒极速完成、不受倍速/拖动/卡顿影响、无需首次点击手势即可全自动静默运行等优势。
- **后续注意事项**：按四阶段计划推进开发。

### [2026-11-13] - 初始化 Agent 规则体系与模块化记忆库
- **所属模块**：工程治理与记忆库 (`AGENTS.md`, `MEMORY.md`, `memory/`, `.agents/skills/memory-sync/`)
- **核心变更**：建立 `BiliMusic` 专属的全局 Agent 行为规则 `AGENTS.md`、记忆库自动同步 Skill、轻量索引 `MEMORY.md` 及 `memory/01~06` 六大领域记忆模块。
- **原因与机理**：保障零构建 Chrome 扩展在多上下文协同开发中的一致性与可维护性。
- **后续注意事项**：后续实现各模块时，同步更新对应 `memory/*.md` 中的实际符号名、字段定义与坑点记录。

### [2026-11-13] - 搭建零构建 ES Modules 工程目录骨架与 manifest.json
- **所属模块**：全局配置与目录骨架 (`manifest.json`, `assets/icons/`, `src/`)
- **核心变更**：在 `d:\music_addon` 根目录创建 `manifest.json`（MV3, `minimum_chrome_version: 116`）、生成占位图标 `icon-16/48/128.png`，并初始化 `src/` 模块目录。
- **原因与机理**：确立原生 ES Modules 零打包架构，规避 Content Script 无法直接 `import` 的限制。
- **后续注意事项**：图标当前为占位纯色圆点 PNG，后续需替换为三态正式图标。
