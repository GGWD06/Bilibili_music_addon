# 🎛️ BiliMusic - 控制面板交互规范与演进路线图 (06_roadmap.md)

本文档记录经 Chrome 157 实测验证定案后的 **DASH 原流直下 + 本地听歌统计** Popup 控制面板 (`src/popup/`) 交互规范及分阶段实现路线图。

---

## 1. 🖥️ Popup 控制面板规范 (`360x520`)

- **视觉尺寸锁定**：固定面板宽度 `360px`、高度 `520px`，禁用整页横向滚动（`overflow-x: hidden`）。
- **双 Tab 视图架构**：
  1. **实时控台 Tab（当前曲目与捕获状态）**：
     - **顶部模式切换栏**：支持一键切换三态工作模式——「自动捕获 + 统计（红）」、「仅听歌统计（绿）」、「暂停待机（灰）」。
     - **当前曲目卡片**：展示当前 B 站标签页正在播放曲目的封面缩略图、标题、UP 主、分 P 信息（如 `P2 / 12`）。
     - **真实 DASH 音质与归档状态栏**：展示探针解析到的当前 `cid` 最高音质徽章（如 `Hi-Res 无损` / `杜比全景声` / `192K AAC`）、当前曲目在本地曲库的状态（`未下载` / `拉流归档中...` / `已归档 (.m4a)` / `已升级高音质`）。
     - **快捷操作区**：提供「立即下载当前曲目」手动触发按钮（即使在“仅统计”模式下也可随时一键收藏当前歌曲）与「自动下载阈值 / 音质升级」轻量配置项。
  2. **听歌排行榜 Tab（本地曲库与统计）**：
     - 顶部汇总卡片：累计听歌总时长、累计听歌曲目数、已归档本地曲目数。
     - 榜单列表：从 IndexedDB（`tracks` & `play_logs`）异步聚合渲染本地听歌排行榜（展示封面、歌名、UP 主、播放次数、累计时长、已存音质徽章）。
- **非阻塞反馈**：严禁使用 `window.alert()` / `confirm()` / `prompt()`，所有提示通过面板内状态栏或轻量 Toast 反馈。

---

## 2. 🗺️ 模块实现路线图 (Implementation Roadmap)

按 **“先验证底层链路 ➔ 再跑通公共层与统计 MVP ➔ 再接入 DASH 原流无损落盘 ➔ 最后完成双 Tab 控台”** 顺序推进：

- [x] **Phase 0**：工程目录骨架、`manifest.json` 搭建与 Git 仓库初始化
- [x] **Phase 0.5**：确立 **DASH 原流直下 + 听歌统计** 三域架构，移除 `tabCapture` 与 `Offscreen` 重编码链路
- [x] **Phase 0.8：下载链路与防串曲实测验证（Spike 已闭环并清理）**
  - 实测验证 `T2`（页面侧 `fetch` ➔ `Blob URL` ➔ SW `chrome.downloads.download`）在 `akamaized.net` 与 `bilivideo.com` 节点下均 100% 落入子目录（排除在 `bilivideo.com` 下会 403 的直链/DNR 方案与破坏子目录命名的 `onDeterminingFilename` 方案）
  - 实测验证 `cacheByCid` 按 `cid` 隔离缓存机制，成功拦截并隔离单页后台触发的 5 个推荐视频预加载 `playurl` 请求
- [x] **Phase 1：公共基础层 (`src/common/` + `tests/common.test.mjs`)**
  - 实现 `constants.js`（工作模式枚举、消息 Action、B 站 DASH 音质代号 `30251/30250/30280/30232/30216` 权重字典与统一 `.m4a` 扩展名）
  - 实现 `messaging.js`（三域统一消息信封与 `target` 路由过滤）
  - 实现 `sanitizer.js`（三级文件名清洗流水线与单 P / 多 P 归档路径生成）
  - 实现 `db.js`（IndexedDB `tracks` 主表与 `play_logs` 流水表 CRUD、排行榜聚合查询），并通过 `node --test` 单元测试验证
- [x] **Phase 2：双世界探针与听歌统计 MVP (`src/content/` + `service-worker.js` + `tests/phase2.test.mjs`)**
  - 实现 `probe-main.js`（`cacheByCid` 按 `cid` 隔离缓存首屏 `window.__playinfo__` 与动态 `fetch`/`XHR` `playurl`、缓存 `/view` 与 `/v2` 适配 SPA 切歌、支持 `backupUrl` 容灾拉流与 `audio/x-m4a` Blob URL 管理）
  - 实现 `bridge-isolated.js`（消息桥接、`<video>` 真实挂钟播放时长累加防拖动欺骗、扩展重载 `Extension context invalidated` 安全自停）
  - 实现 `service-worker.js` 统计与路由底座（`withTabQueue` 防并发重复计数、`storage.session` 状态持久化、三态角标同步与排行榜查询路由），并通过 3 项沙箱与集成测试
- [x] **Phase 3：DASH 原流拉取、预检去重与落盘归档 (`src/background/` + `tests/phase3.test.mjs`)**
  - 完成 `preflight.js`（IndexedDB 去重、`chrome.downloads.search` 本地存活校验、`clearTrackDownload` 断链修复、`QUALITY_UPGRADE` 与 `durl` 守卫）
  - 完成 `downloader.js`（基于 `chrome.storage.session` 持久化与 `inFlightFinalizes` 锁，支持异常/中断双段 `fallbackFilename` 重试、升级 `removeFile` + `erase` 与 `REVOKE_BLOB_URL` 回收）
  - 在 `service-worker.js` 完整挂接心跳阈值自动捕获、手动下载 `MANUAL_DOWNLOAD`、`DASH_BLOB_READY`/`FAILED` 回调与 `downloads.onChanged` 监听，并通过 `tests/phase3.test.mjs` 验证
- [x] **Phase 4：Popup 双 Tab 控台、听歌排行榜与三态图标 (`src/popup/` & `assets/icons/` & `tests/phase4.test.mjs`)**
  - 生成并绑定三态扩展栏图标（`AUTO` 粉 / `STAT` 绿 / `OFF` 灰，`16/48/128px` 抗锯齿 PNG 配合 `chrome.action.setIcon` 与 `MODE_UI_META.iconPaths`）
  - 完成 `360x520` 双 Tab Popup 控台（实时控台展示封面/分 P/真实音质徽章/归档状态/阈值进度/手动触发/参数实时保存；听歌榜展示 KPI 汇总/时间范围筛选/排序/两步内联确认清空），严禁使用阻塞弹窗与 CSP 违规内联脚本
  - 新增 `tests/phase4.test.mjs` 验证 DOM ID 契约、无阻塞弹窗规范与 UI 交互闭环
