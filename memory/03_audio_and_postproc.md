# 🎧 BiliMusic - DASH 原流拉取、预检去重与落盘归档 (03_audio_and_postproc.md)

本文档归档经 Chrome 157 实测定案的 `probe-main.js` 页面侧 DASH 原流拉取、`src/background/preflight.js` 预检去重与 `src/background/downloader.js` 落盘归档核心技术链路。

---

## 1. 🚀 页面侧 DASH 原流提取与防盗链拉取 (`src/content/probe-main.js`)

经 Spike 实测对比（T0 直链 / T1 DNR 补 `Referer` / T2 页面 `Blob URL` 移交 SW / T3 页面 `<a download>`），`*.bilivideo.com` 源站节点对 `chrome.downloads` 发起的直链请求（即使挂有 DNR `Referer` 规则）仍会返回 `SERVER_FORBIDDEN`（403 HTML 错误页），而 **T2（页面侧 `fetch` ➔ `Blob URL` ➔ SW `chrome.downloads.download`）** 在所有 CDN 节点下均 100% 稳定落入目标子目录：

1. **最优音轨挑选**：
   - 解析当前在播 `cid` 对应的 `dash.flac.audio`（`30251` Hi-Res 无损）、`dash.dolby.audio`（`30250`）与 `dash.audio` 列表。
   - 按 `DASH_QUALITY_MAP` 权重从高到低排序，自动挑选当前账号权限下可获取的最高音质流，提取其主地址 `baseUrl`（或 `base_url`）与备用地址列表 `backupUrl`（或 `backup_url`）。
2. **页面侧天然 `Referer` 拉流与 `backupUrl` 自动容灾**：
   - 当后台 `preflight.js` 判定需要下载该曲目时，SW 向对应标签页下发拉流指令，由 `probe-main.js` 在 B 站页面 `MAIN` 世界调用原生 `fetch(url)` 拉取音频流（天然携带与 B 站播放器一致的 `Referer`、`Origin` 与会话上下文）。
   - 若首选 `baseUrl` 响应非 2xx 或网络异常，自动按序遍历 `backupUrl` 数组重试，直至拉流成功。
3. **音频 MIME 修正与 `Blob URL` 移交**：
   - B 站 CDN 响应头默认返回 `Content-Type: video/mp4`，若直接用原始响应构造 `Blob`，Chrome `downloads.download` 会强制把 `.m4a` 扩展名改写为 `.mp4`（导致部分本地音乐软件忽略该文件）。
   - 因此在构造 `Blob` 时显式声明音频 MIME：`new Blob([rawBlob], { type: 'audio/x-m4a' })`（零内存拷贝），再调用 `URL.createObjectURL` 生成 `blob:https://www.bilibili.com/...` 传回 Service Worker 落盘。
4. **`Blob URL` 内存双保险回收**：
   - 落盘完成（`complete`）或中断（`interrupted`）后，SW 立即发送 `REVOKE_BLOB_URL` 指令通知页面执行 `URL.revokeObjectURL`；同时页面侧为每个 `Blob URL` 挂载 10 分钟超时自动释放定时器，杜绝长时听歌造成页面内存泄漏。

---

## 2. 📥 下载前预检与音质升级判断 (`src/background/preflight.js`)

1. **前置与去重查询**：`evaluateDownloadCandidate` 检查曲目 `bvid/cid`、有效 DASH `baseUrl`、`hasActiveTask` 及当前标签页下载锁；命中历史记录时根据 `trackKey`（`${bvid}_${cid}`）查询 IndexedDB `tracks` 表。
2. **本地文件存活校验**：若数据库存有 `downloadId`，调用 `chrome.downloads.search({ id: downloadId })` 检查记录是否 `complete` 且 `exists !== false`——若用户已在磁盘删除文件，则先调用 `clearTrackDownload` 清理失活下载字段，再返回 `MISSING_LOCAL_FILE` 放行重下。
3. **真无损/高码率音质升级判断**：
   - 比对本次捕获的 DASH 音质权重与已落盘的 `qualityId` 权重。
   - 当启用自动升级（`settings.enableQualityUpgrade`）或处于手动点击（`forceManual`）且新流权重更高时，返回 `QUALITY_UPGRADE`（附带 `isUpgrade: true` 与 `oldDownloadId`）。若已存在同级/更高音质文件，则返回 `ALREADY_EXISTS`（手动返回 `COMPLETED` 提示，自动返回 `SKIPPED`）。
4. **旧版 `durl` 视频降级保护**：
   - 针对仅有 `durl` 而无 `dash.audio` 的老视频返回 `UNSUPPORTED_DURL`，仅记录听歌统计而不拉取大体积视频流。

---

## 3. 💾 落盘归档与旧档清理 (`src/background/downloader.js`)

- **状态持久化防休眠**：待拉取与进行中下载映射表写入 `chrome.storage.session`（`PENDING_DOWNLOADS`，5 分钟 TTL），并通过 `inFlightFinalizes` 锁消除 `chrome.downloads.download` 秒级完成时与 `chrome.downloads.onChanged` 的竞态重复结算。
- **安全路径落盘**：使用经 `src/common/sanitizer.js` 清洗的相对路径（`BiliMusic/.../*.m4a`）调用 `chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false })`。
- **严禁注册全局空 `onDeterminingFilename`**：避免覆盖扩展自身传入的 `filename` 子目录路径或干扰用户浏览器的其他下载任务。
- **双段失败降级保底**：不仅在 `chrome.downloads.download` 直接抛错时回退至保底短文件名（`BiliMusic/${bvid}_${cid}_${qualityId}.m4a`），在异步收到 `state === 'interrupted'` 且错误匹配 `/FILE_|PATH/i` 时也会原地复用同一 `Blob URL` 降级重下。
- **音质升级旧档清理与内存释放**：下载 `complete` 后写入 `markTrackDownloaded`；若为升级任务则调用 `chrome.downloads.removeFile(oldDownloadId)` 与 `erase({ id: oldDownloadId })` 清理旧版低音质文件；无论完成或最终失败均下发 `REVOKE_BLOB_URL` 回收页面 `Blob` 内存。
