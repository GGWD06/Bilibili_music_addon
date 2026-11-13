---
name: memory-sync
description: >-
  Workflow for reading, auditing, and synchronizing project memory in MEMORY.md
  whenever changes, feature additions, refactorings, bug fixes, or architectural
  updates are performed in the BiliMusic Chrome Extension repository.
---

# 🧠 BiliMusic 记忆库自动化同步 Skill (memory-sync)

本 Skill 规范了在对 **BiliMusic** 仓库（`d:\music_addon`）执行任何功能开发、Bug 修复、重构、权限调整或配置变更时，如何标准化、高保真地更新项目记忆库 `MEMORY.md` 及其模块化子文档。

---

## 🎯 触发场景与时机

当在本项目中执行了以下任何操作后，**必须在任务结束前调用本流程更新记忆库**：
1. **核心公共层变更**：修改 `src/common/` 中的工作模式枚举、Action 常量、消息信封结构、IndexedDB 表结构、DASH 音质字典或文件名清洗规则。
2. **双世界探针变更**：修改 `src/content/probe-main.js` 或 `src/content/bridge-isolated.js` 的网络劫持、首屏 `__playinfo__` 读取、页面侧 DASH 拉流、路由监听或视频播放计时逻辑。
3. **后台调度与预检变更**：修改 `src/background/` 中的会话恢复、预检去重/DASH 音质升级判断、`chrome.downloads` 落盘或 `Blob URL` 释放逻辑。
4. **交互面板与全局配置变更**：修改 `src/popup/` 或 `manifest.json` 的权限声明、注入规则、CSP 或 UI 视图。

---

## 📋 执行标准流程 (Standard Procedure)

### 第 1 步：查验当前改动 (Inspect Diff)
在即将总结本次任务前，回顾本次交互修改的所有文件及核心逻辑：
- 影响了三域中的哪几个运行域？（Content 双世界 / Service Worker / Popup）
- 是否涉及消息信封契约、IndexedDB Schema 或 `manifest.json` 权限变动？

### 第 2 步：定位记忆库目标子模块 (Target Files)
根据变更类型定位更新目标：
- **涉及架构/三域拓扑/权限声明变动** ➔ 同步更新 **[memory/01_architecture.md](../../../memory/01_architecture.md)**
- **涉及 IndexedDB/Storage/消息契约/DASH 音质字典** ➔ 同步更新 **[memory/02_data_models.md](../../../memory/02_data_models.md)**
- **涉及 DASH 原流拉取/`backupUrl` 容灾/预检去重/下载归档** ➔ 同步更新 **[memory/03_audio_and_postproc.md](../../../memory/03_audio_and_postproc.md)**
- **涉及双世界探针/路由监听/真实听歌计时/SW 恢复** ➔ 同步更新 **[memory/04_probes_and_lifecycle.md](../../../memory/04_probes_and_lifecycle.md)**
- **排查并解决了隐蔽陷阱/Chrome MV3 踩坑** ➔ 增补至 **[memory/05_pitfalls.md](../../../memory/05_pitfalls.md)**（黄金避坑指南）
- **涉及 Popup 交互规范/功能路线图储备** ➔ 同步更新 **[memory/06_roadmap.md](../../../memory/06_roadmap.md)**
- **常规功能开发流水/提交记录** ➔ 增量写入 **[CHANGELOG.md](../../../CHANGELOG.md)**（保持记忆库轻量）。

### 第 3 步：执行编辑 (Edit Memory & Changelog)
使用精确文件编辑工具更新对应文档，遵循以下规范：
1. **语言风格**：专业、精炼、事实导向，包含准确的文件路径、符号名称与核心技术机理。
2. **时间戳标注**：在 `CHANGELOG.md` 中以 `YYYY-MM-DD` 记录日期。
3. **禁止空泛**：必须说明“修改了哪个文件、解决了什么具体问题、技术机理是什么”。
