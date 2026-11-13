# 📜 BiliMusic 变更日志 (CHANGELOG.md)

本文件按时间线记录 `BiliMusic` 扩展的代码演进、核心修复与架构变更流水。

---

### [2026-11-13] - 架构重构：全面切换至 DASH 原流直下 + 本地听歌统计三域架构
- **所属模块**：全局架构、Manifest 配置与记忆库 (`manifest.json`, `src/`, `AGENTS.md`, `MEMORY.md`, `memory/01~06`)
- **核心变更**：
  1. 废弃有损重编码的 `tabCapture` + `Offscreen` Web Audio + `ebml-fixer` 四域录音方案，移除 `src/offscreen/` 与 `src/vendor/` 冗余模块，初始化本地 Git 仓库。
  2. 确立 **Content 双世界 (`probe-main` + `bridge-isolated`) ⇄ Service Worker ⇄ Popup** 轻量三域拓扑：由 `probe-main.js` 兼顾首屏 `window.__playinfo__` 与动态 `/x/player/wbi/playurl` 拦截提取真实 DASH 音频流（`30251` Hi-Res / `30250` 杜比 / `30280` 192K AAC），并在页面上下文以原站天然 `Referer` 拉流（支持 `backupUrl` 自动容灾）生成 `Blob URL` 移交 `chrome.downloads` 落盘。
  3. 精简 `manifest.json` 权限为 `["downloads", "storage", "tabs"]`，移除 `tabCapture`、`offscreen`、`activeTab` 与 `'wasm-unsafe-eval'` CSP。
  4. 更新 `memory/06_roadmap.md` 四阶段实施计划，确立“Phase 1 公共层 ➔ Phase 2 探针与听歌统计 MVP ➔ Phase 3 DASH 原流拉取与音质升级落盘 ➔ Phase 4 Popup 双 Tab 控台”路线。
- **原因与机理**：针对个人日常自用场景，DASH 原流直下相比 `tabCapture` 录音具备真无损原盘、几秒极速完成、不受倍速/拖动/卡顿影响、无需首次点击手势即可全自动静默运行等绝对优势，同时使“高音质升级替换”逻辑真正成立并大幅降低工程复杂度。
- **后续注意事项**：开发 `downloader.js` 时需确保每次下载完成或中断后向页面发送 `REVOKE_BLOB_URL` 释放内存；开发 `probe-main.js` 时需同时处理首屏 `window.__playinfo__` 与切歌时的 `fetch`/`XHR` 响应。

### [2026-11-13] - 初始化 Agent 规则体系与模块化记忆库
- **所属模块**：工程治理与记忆库 (`AGENTS.md`, `MEMORY.md`, `memory/`, `.agents/skills/memory-sync/`)
- **核心变更**：建立 `BiliMusic` 专属的全局 Agent 行为规则 `AGENTS.md`、记忆库自动同步 Skill、轻量索引 `MEMORY.md` 及 `memory/01~06` 六大领域记忆模块。
- **原因与机理**：通过“P0 强制记忆同步 + 模块化精准定位 + 故障排查三步确认 + MV3 架构红线”保障零构建 Chrome 扩展在多上下文协同开发中的一致性与可维护性。
- **后续注意事项**：后续实现各模块时，同步更新对应 `memory/*.md` 中的实际符号名、字段定义与坑点记录。

### [2026-11-13] - 搭建零构建 ES Modules 工程目录骨架与 manifest.json
- **所属模块**：全局配置与目录骨架 (`manifest.json`, `assets/icons/`, `src/`)
- **核心变更**：在 `d:\music_addon` 根目录创建 `manifest.json`（MV3, `minimum_chrome_version: 116`）、生成占位图标 `icon-16/48/128.png`，并初始化 `src/` 模块目录。
- **原因与机理**：确立原生 ES Modules 零打包架构，规避 Content Script 无法直接 `import` 的限制。
- **后续注意事项**：图标当前为占位纯色圆点 PNG，后续需替换为三态正式图标。
