# 🎧 BiliMusic - DASH 原流拉取、预检去重与落盘归档 (03_audio_and_postproc.md)

本文档归档 `probe-main.js` 页面侧 DASH 原流拉取、`src/background/preflight.js` 预检去重与 `src/background/downloader.js` 落盘归档的核心技术链路。

---

## 1. 🚀 页面侧 DASH 原流提取与防盗链拉取 (`src/content/probe-main.js`)

相比 `tabCapture` 实时重编码方案，直接提取 `/x/player/wbi/playurl` 中的 DASH 音频流具备**无损原盘、几秒极速完成、倍速/拖动/缓冲完全无损**的核心优势：

1. **最优音轨挑选**：
   - 解析 `playurl` 响应中的 `dash.flac.audio`（`30251` Hi-Res 无损）、`dash.dolby.audio`（`30250`）与 `dash.audio` 列表。
   - 按音质权重字典自动挑选当前账号权限下可获取的最高音质流，提取其主地址 `baseUrl`（或 `base_url`）与备用地址列表 `backupUrl`（或 `backup_url`）。
2. **页面侧天然 `Referer` 拉流（零 403 防盗链风险）**：
   - B 站音视频 CDN（`*.bilivideo.com` / `*.bilivideo.cn` / `*.akamaized.net`）强制校验 `Referer: https://www.bilibili.com/` 与 `Origin: https://www.bilibili.com`。
   - 当后台 `preflight.js` 判定需要下载该曲目时，SW 通知 `probe-main.js` 在 B 站页面 `MAIN` 世界直接调用 `fetch(url)` 拉取音频流：浏览器会自动附带与 B 站原生播放器完全一致的 `Referer` 与 `Origin`，无需额外配置复杂的请求头篡改规则。
3. **`backupUrl` 自动容灾切换**：
   - 若首选 `baseUrl`（有时为稳定性较弱的 PCDN/MCDN 节点）响应非 2xx 或网络超时，`probe-main.js` 自动按序轮询 `backupUrl` 重试，确保下载高可用。
4. **`Blob URL` 跨上下文移交与内存回收**：
   - 页面侧 `fetch` 完成后生成 `Blob` 并调用 `URL.createObjectURL(blob)`，将 `blob:https://www.bilibili.com/...` 传回 Service Worker 交由 `chrome.downloads.download` 落盘。
   - 落盘完成或失败后，SW 立即发送 `REVOKE_BLOB_URL` 指令通知页面执行 `URL.revokeObjectURL`，杜绝长时听歌造成页面内存泄漏。

---

## 2. 📥 下载前预检与音质升级判断 (`src/background/preflight.js`)

1. **去重查询**：根据当前曲目的 `(bvid, cid)` 查询 IndexedDB `tracks` 表是否已有归档记录。
2. **本地文件存活校验**：若数据库显示已下载且存有 `downloadId`，调用 `chrome.downloads.search({ id: downloadId })` 检查 `exists` 状态——若用户已在磁盘上手动删除该文件，则自动放行重新下载。
3. **真无损/高码率音质升级判断**：
   - 比对本次捕获的 DASH 音质代号权重（如用户刚开通大会员捕获到 `30251` Hi-Res）与历史已落盘的音质代号（如未登录时的 `30232`）。
   - 若新流音质权重更高，则标记为 `UPGRADE`，允许下载新文件并在落盘成功后清理旧版低音质文件。
4. **旧版 `durl` 视频降级保护**：
   - 针对极少数仅有 `durl`（音画合流 MP4/FLV）而无 `dash.audio` 分离音频流的远古视频，标记为“无分离音轨”，仅记录听歌统计而不拉取大体积视频流。

---

## 3. 💾 落盘归档与旧档清理 (`src/background/downloader.js`)

- **安全路径落盘**：使用经 `src/common/sanitizer.js` 清洗的相对路径（`BiliMusic/...`）与对应扩展名（`.m4a` / `.flac`）调用 `chrome.downloads.download`。
- **失败降级保底**：若因极端路径长度或系统占用导致落盘失败，自动回退至保底短文件名 `BiliMusic/${bvid}_${cid}.m4a` 重试。
- **音质升级旧档清理**：当 `UPGRADE` 任务的新文件下载完成后，调用 `chrome.downloads.removeFile(oldDownloadId)` 与 `erase` 清理旧版低音质文件，并更新 IndexedDB `tracks` 表记录。
