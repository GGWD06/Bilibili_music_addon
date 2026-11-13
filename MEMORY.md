# 🧠 BiliMusic 原流捕获与听歌统计 - 项目核心记忆总索引 (MEMORY.md)

> **文档性质**：本文档是 `BiliMusic` Chrome Manifest V3 扩展的全局总索引（Master Index）。
> 为保障大模型检索效率与 0 Token 冗余定位，核心记忆库已按领域驱动设计拆分为模块化知识库，具体细节归档至 `memory/` 目录下。

---

## 🗺️ 核心记忆库导航地图 (Memory Hub Directory)

| 序号 | 领域主题 | 文件路径 | 包含核心内容 |
| :---: | :--- | :--- | :--- |
| **01** | **系统架构与三域拓扑** | [memory/01_architecture.md](./memory/01_architecture.md) | 零构建原生 ESM 工程架构、MV3 三域通信拓扑（Content / SW / Popup）、目录职责与权限矩阵 |
| **02** | **数据模型与消息契约** | [memory/02_data_models.md](./memory/02_data_models.md) | IndexedDB (`tracks` / `play_logs`)、`storage.session` 状态快照、统一消息信封与 DASH 音质字典 |
| **03** | **DASH 原流拉取与落盘** | [memory/03_audio_and_postproc.md](./memory/03_audio_and_postproc.md) | 页面侧天然 `Referer` 拉流、`backupUrl` 容灾、`.m4a` MIME 修正、预检去重、高音质升级替换与落盘 |
| **04** | **双世界探针与生命周期** | [memory/04_probes_and_lifecycle.md](./memory/04_probes_and_lifecycle.md) | `MAIN`/`ISOLATED` 双世界注入、按 `cid` 缓存防串曲、首屏 `__playinfo__` + 动态 `playurl` 双捕获、真实听歌计时 |
| **05** | **黄金避坑指南** | [memory/05_pitfalls.md](./memory/05_pitfalls.md) | 实证避坑池：MV3 边界、推荐预加载串曲、`bilivideo.com` 403、`.m4a` 后缀被改写、`Blob URL` 释放与文件名清洗 |
| **06** | **控台交互与演进路线图** | [memory/06_roadmap.md](./memory/06_roadmap.md) | Popup 360x520 双 Tab 控台、真实音质徽章、手动/自动下载控制与四阶段实现路线图 |

---

## 🛡️ 代码安全与架构红线 (Inviolable Rules)

1. **零构建与双世界边界**：`src/content/*.js` 必须保持无依赖单文件，严禁 `import`/`export`；SW 与 Popup 统一用 ESM 共享 `src/common/`。
2. **主世界 `document_start` 抢先注入与按 `cid` 缓存防串曲**：`probe-main.js` 必须以 `world: "MAIN"` + `run_at: "document_start"` 注入，劫持 `fetch`/`XHR` 必须先 `clone()` 且静默吞异常；所有捕获的 `playurl` 必须存入 `Map<cid, PlayinfoEntry>`（首屏 `window.__playinfo__` 仅绑定初始 `cid`），严禁单变量覆盖导致推荐位预加载串曲。
3. **页面侧天然 `Referer` 拉流、`backupUrl` 容灾与 `.m4a` MIME 修正**：DASH 音频流统一在 `probe-main.js` 页面上下文中 `fetch`（主 `baseUrl` 失败自动轮询 `backupUrl`），并以音频 MIME（`audio/x-m4a` 或 `audio/mp4`）构造 `Blob URL` 交由 SW `chrome.downloads.download` 落盘；严禁在 SW 注册空 `suggest()` 的 `onDeterminingFilename`。
4. **`Blob URL` 及时释放防内存泄漏**：每次 `chrome.downloads` 落盘完成或中断后，必须通知页面执行 `URL.revokeObjectURL`（辅以页面侧超时保底释放）。
5. **SW 状态持久化**：活动标签页曲目快照与进行中的下载映射必须存入 `chrome.storage.session`，严禁只存 SW 易失内存。
6. **三级文件名清洗防穿越**：所有落盘路径必须经过 `src/common/sanitizer.js` 三级清洗，剔除 Windows 非法字符与保留字。
7. **禁止原生阻塞弹窗**：Popup 与注入脚本严禁使用 `alert()` / `confirm()` / `prompt()`。

---

## 📐 外部导航与流水日志

- **系统详细变更日志**：[CHANGELOG.md](./CHANGELOG.md)
- **扩展全局配置清单**：[manifest.json](./manifest.json)
- **AI 全局工作区规范**：[AGENTS.md](./AGENTS.md)
- **记忆库同步 Skill**：[.agents/skills/memory-sync/SKILL.md](./.agents/skills/memory-sync/SKILL.md)
