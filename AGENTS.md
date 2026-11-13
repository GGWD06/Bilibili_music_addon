# 🤖 BiliMusic - 工作区全局规则 (AGENTS.md)

本文档定义了 AI 智能体在 `BiliMusic`（`d:\music_addon`）Chrome Manifest V3 原流音频捕获与听歌统计扩展代码库中工作时，必须无条件遵守的全局行为准则与自动化操作规范。

---

## ⚡ 核心强制法则：记忆库自动同步 (Continuous Memory Sync)

> **最高优先级规则 (P0)**：
> 只要在本项目中执行了**任何**代码编写、功能增删、Bug 修复、数据模型修改、权限/注入配置调整或工程文档变更，**必须在任务完成前自动将本次变更细节与技术机理同步记录到 [MEMORY.md](./MEMORY.md) 及其对应的 `memory/` 子模块与 [CHANGELOG.md](./CHANGELOG.md)**。

### 1. 记忆库同步触发条件
- 修改了 `src/common/*`（工作模式枚举、消息信封路由、IndexedDB 封装、DASH 音质字典、三级文件名清洗器）。
- 修改了 `src/content/*`（`probe-main.js` 主世界探针与页面侧 DASH 拉流、`bridge-isolated.js` 隔离世界桥接与真实播放计时）。
- 修改了 `src/background/*`（`service-worker.js` 路由与会话恢复、`preflight.js` 预检去重与音质升级判断、`downloader.js` 落盘、清理与通知释放 `Blob URL`）。
- 修改了 `src/popup/*` 或 `manifest.json`（360x520 双 Tab 控台、音质与归档状态展示、权限声明或双世界注入规则）。

### 2. 同步与更新规范 (模块化精准定位法则)
1. **模块化分层定位**：
   - 架构/三域拓扑/目录结构/权限声明变动 ➔ 更新 **[memory/01_architecture.md](./memory/01_architecture.md)**
   - IndexedDB 表结构/Storage 状态快照/消息信封/DASH 音质字典变化 ➔ 更新 **[memory/02_data_models.md](./memory/02_data_models.md)**
   - 页面侧 DASH 拉流/`backupUrl` 容灾/预检去重/音质升级/落盘归档 ➔ 更新 **[memory/03_audio_and_postproc.md](./memory/03_audio_and_postproc.md)**
   - 双世界探针劫持/首屏 `__playinfo__`/切 P 路由追踪/真实听歌计时/SW 状态恢复 ➔ 更新 **[memory/04_probes_and_lifecycle.md](./memory/04_probes_and_lifecycle.md)**
   - 发现并避开隐患/Chrome MV3 踩坑 ➔ 追加至 **[memory/05_pitfalls.md](./memory/05_pitfalls.md)**（避坑指南）
   - Popup 交互规范/功能演进路线图 ➔ 更新 **[memory/06_roadmap.md](./memory/06_roadmap.md)**
   - 具体代码修改流水与时间线 ➔ 增量写入 **[CHANGELOG.md](./CHANGELOG.md)**（严禁在记忆库中堆砌冗长流水账）。
2. **轻量索引守则**：
   - 根目录 **[MEMORY.md](./MEMORY.md)** 仅作为全局速查 Master Index，保持轻量（<100 行），若新增核心安全与架构红线可增量同步。
3. **禁止遗漏**：
   - 涉及核心消息契约、IndexedDB Schema 变更或 Chrome MV3 踩坑时，任务完成前必须增量同步至对应子模块。

### 3. 每周记忆库健康巡检机制 (Weekly Memory Audit Ritual)
- **触发准则**：建议每周固定周期（或用户发送指令*“帮我做一下本周的记忆库对账与全面巡检”*）执行一次全库健康度体检；
- **执行 4 步标准作业程序 (SOP)**：
  1. **代码与提交对账**：扫描近 7 天 Git Commit / [CHANGELOG.md](./CHANGELOG.md)，检查是否有未归档到 `memory/` 的新消息 Action、新字段或新文件；
  2. **核心模型与消息契约检查**：抽查 [memory/02_data_models.md](./memory/02_data_models.md) 与 `src/common/constants.js`、`src/common/db.js`、`src/common/messaging.js` 实际定义的一致性；
  3. **Manifest、权限与双世界探针活性检查**：验证 [memory/01_architecture.md](./memory/01_architecture.md) 与 `manifest.json` 的权限、`host_permissions`、注入时机（`document_start` / `document_idle`）是否完全对齐；
  4. **避坑经验精炼与去重**：整理 [memory/05_pitfalls.md](./memory/05_pitfalls.md)，合并相似踩坑记录，剔除已被新架构彻底淘汰的过时规避手段；
- **输出交付物**：必须向用户出具标准化的《记忆库健康度巡检报告》，并原地修复任何发现的知识漂移。

---

## 🛡️ 代码安全与架构红线 (Inviolable Rules)

1. **零构建依赖与双世界模块边界红线**：本项目采用原生 ES Modules（零 Webpack/Vite 构建依赖）。`src/content/probe-main.js` 与 `src/content/bridge-isolated.js` 必须保持为无外部依赖的独立单文件，**严禁在 Content Script 中使用 ES Module `import`/`export` 语法**；后台 `service-worker.js` 与 `popup.js` 统一通过 `"type": "module"` 共享 `src/common/` 工具库。
2. **主世界探针 `document_start` 抢先注入与双源捕获红线**：`manifest.json` 中 `probe-main.js` 必须锁定 `"run_at": "document_start"` 与 `"world": "MAIN"`，同时兼顾首屏 SSR 内联 `window.__playinfo__` 读取与后续动态 `/x/player/wbi/playurl`（`fetch`/`XHR`）拦截；读取 `window.__INITIAL_STATE__` 时必须配合 `DOMContentLoaded` 或轮询等待其挂载完毕，严禁直接裸读引发空引用异常。
3. **页面侧天然 `Referer` 拉流与 `backupUrl` 容灾红线**：禁止在 Service Worker 中直接将 `*.bilivideo.com` 裸链接塞给 `chrome.downloads.download`（会因缺失 `Referer` 触发 403），且 SW 中无 `URL.createObjectURL`；必须由 `probe-main.js` 在 B 站页面上下文调用 `fetch` 拉取音频流（主 `baseUrl` 失败时自动切换 `backupUrl`）并生成 `Blob URL` 移交后台下载。
4. **`Blob URL` 内存及时释放红线**：每次通过 `chrome.downloads.download` 下载页面生成的 `Blob URL` 后，必须在下载完成（`complete`）或中断（`interrupted`）时通知对应标签页执行 `URL.revokeObjectURL`，严禁长期驻留导致 B 站页面内存泄漏。
5. **SW 休眠防丢失与 Session 状态持久化红线**：当前活动标签页曲目快照、工作模式与进行中的下载任务映射必须持久化写入 `chrome.storage.session`（用户持久设置存入 `chrome.storage.local`），严禁仅存在易失的 Service Worker 内存变量中导致 SW 休眠唤醒后上下文丢失。
6. **三级文件名清洗与防路径穿越红线**：所有传给 `chrome.downloads.download` 的文件名与归档子路径必须强制经过 `src/common/sanitizer.js` 三级清洗流水线，彻底剔除非法字符（`\ / : * ? " < > |`）、控制字符、尾随点号/空格、路径穿越片段（`..`）及 Windows 保留设备名，杜绝扩展下载落盘崩溃。
7. **禁止原生阻塞弹窗红线**：严禁在 `src/popup/popup.js` 或注入页面脚本中调用 `window.alert()` / `window.prompt()` / `window.confirm()`，所有操作反馈与错误提示必须通过非阻塞 UI 状态栏或轻量 Toast 组件呈现。

---

## 🤝 交互与沟通规范 (Interaction Protocol)

1. **故障排查反馈机制 (Feedback & Execution Confirmation)**：
   - 当用户反馈任何 Bug 或提出代码问题时，**严禁直接进行代码修改**。
   - 你必须遵循三步流程：
     1. 首先向用户明确指出问题的根源在哪里（Where the problem is）。
     2. 给出你的具体修复/解决思路或方案（Proposed solution）。
     3. 询问用户是否同意。**只有在用户明确同意（如回复“同意”、“去执行”、“ok”等）后，才能使用工具实际执行代码修改。**

---

## 📐 控制面板 UI 与文档排版规范 (UI & Documentation Guidelines)

1. **Popup 实时控台设计规范 (`360x520`)**：
   - **高密度双 Tab 结构**：严格区分「实时控台（当前曲目/音质徽章/模式与下载）」与「听歌排行榜」双视图，固定面板尺寸 `360x520` 避免出现整页横向滚动条（`overflow-x: hidden`）。
   - **非阻塞状态反馈**：状态图标（待机灰、自动捕获红、纯统计绿）与归档进度必须与后台状态保持一致，所有提示通过面板内非阻塞 Toast 呈现。
2. **文档与记忆库排版规范**：
   - 保持表格结构清晰、列宽合理、核心专有名词使用反引号包裹；代码路径统一使用相对路径或标准 Markdown 链接，确保高可读性与零冗余检索。
