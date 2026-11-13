# 🧠 BiliMusic - 模块化项目记忆库 (Memory Hub)

欢迎查阅 `BiliMusic` 模块化记忆知识库。为了实现高效检索与低 Token 冗余定位，核心记忆库按领域拆分归档为以下 6 个专注主题：

---

## 🗂️ 记忆模块导航表 (Directory Index)

| 序号 | 模块文件 | 核心内容与关注领域 | 适用查阅场景 |
| :---: | :--- | :--- | :--- |
| **01** | [01_architecture.md](./01_architecture.md) | **MV3 三域架构、目录职责与权限矩阵**<br>Content / Service Worker / Popup 拓扑与零构建 ESM 约束 | 模块联调、权限审查、新增模块边界划分 |
| **02** | [02_data_models.md](./02_data_models.md) | **数据模型、状态机与消息信封契约**<br>IndexedDB `tracks` 与 `play_logs`、`chrome.storage` 快照、Action 与 DASH 音质字典 | 表结构修改、跨上下文消息对接、预检去重开发 |
| **03** | [03_audio_and_postproc.md](./03_audio_and_postproc.md) | **DASH 原流拉取、预检去重与落盘归档**<br>页面侧防盗链拉流、`backupUrl` 容灾、音质升级判断、`Blob URL` 释放与 `downloads` 落盘 | 原流提取、CDN 403 排查、音质升级替换、文件落盘 |
| **04** | [04_probes_and_lifecycle.md](./04_probes_and_lifecycle.md) | **双世界页面探针与 MV3 生命周期管理**<br>`probe-main.js`、`bridge-isolated.js`、SPA 切 P 监听、真实听歌计时与 SW 状态恢复 | B 站接口适配、切歌事件捕获、听歌时长统计 |
| **05** | [05_pitfalls.md](./05_pitfalls.md) | **黄金避坑指南与踩坑经验池 (Pitfalls & Gotchas)**<br>覆盖 MV3 限制、B 站首屏 `__playinfo__` 竞态、CDN 防盗链、`Blob URL` 回收与文件名安全 | **Bug 排查、架构重构前必读、开发自检** |
| **06** | [06_roadmap.md](./06_roadmap.md) | **控制面板 UI 规范与演进路线图**<br>Popup 360x520 双 Tab 控台、音质徽章、下载控制与四阶段开发路线图 | Popup UI 开发、交互优化、开发进度跟进 |

---

## 🔄 常态化维护：每周记忆库巡检机制 (Weekly Audit)

为防止高频开发带来的知识漂移与跨模块不一致，系统确立了**每周健康对账 SOP**：
- **触发方式**：向 AI 发送指令：*“帮我做一下本周的记忆库对账与全面巡检”*；
- **巡检范围**：近期变更对账、数据模型与消息契约抽查、`manifest.json` 权限与探针活性核验、避坑指南精简去重；
- **健康保障**：AI 自动输出标准化《记忆库健康度巡检报告》并就地修正漂移。

---

> 💡 **流水账查阅**：关于具体的每日提交、时间线明细及功能迭代日志，请查阅根目录 **[CHANGELOG.md](../CHANGELOG.md)**。
