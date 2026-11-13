/**
 * @fileoverview 下载落盘调度：下发页面侧 DASH 拉流、chrome.downloads 落盘、降级保底重试、清理旧低音质文件并及时释放 Blob URL。
 * 严禁注册全局无差别空 suggest() 的 onDeterminingFilename 监听器。
 */

import { ACTION, DOWNLOAD_STATUS, STORAGE_KEYS } from '../common/constants.js';
import { sendToTab as defaultSendToTab } from '../common/messaging.js';
import { buildArchiveFilename, buildFallbackFilename } from '../common/sanitizer.js';
import {
  upsertTrackMeta as defaultUpsertTrackMeta,
  markTrackDownloaded as defaultMarkTrackDownloaded,
} from '../common/db.js';

const PENDING_FETCH_TTL_MS = 5 * 60 * 1000;
const inFlightFinalizes = new Map();
let downloadStoreChain = Promise.resolve();

function withDownloadStoreLock(fn) {
  const next = downloadStoreChain.then(fn, fn);
  downloadStoreChain = next.catch(() => {});
  return next;
}

/** 创建下载调度器实例（支持依赖注入便于单元测试） */
export function createDownloader(deps = {}) {
  const sendToTabFn = deps.sendToTab || defaultSendToTab;
  const upsertTrackMetaFn = deps.upsertTrackMeta || defaultUpsertTrackMeta;
  const markTrackDownloadedFn = deps.markTrackDownloaded || defaultMarkTrackDownloaded;
  const onStatusUpdate = deps.onStatusUpdate || (() => {});

  const getDownloadsApi = () => deps.downloadsApi || globalThis.chrome?.downloads;
  const getSessionStorage = () => deps.sessionStorage || globalThis.chrome?.storage?.session;

  async function readPendingMap() {
    const storage = getSessionStorage();
    if (!storage) return {};
    const res = await storage.get(STORAGE_KEYS.PENDING_DOWNLOADS);
    return res?.[STORAGE_KEYS.PENDING_DOWNLOADS] || {};
  }

  async function writePendingMap(map) {
    const storage = getSessionStorage();
    if (!storage) return;
    await storage.set({ [STORAGE_KEYS.PENDING_DOWNLOADS]: map });
  }

  async function savePendingEntry(key, value) {
    await withDownloadStoreLock(async () => {
      const map = await readPendingMap();
      map[key] = value;
      await writePendingMap(map);
    });
  }

  async function takePendingEntry(key) {
    let taken = null;
    await withDownloadStoreLock(async () => {
      const map = await readPendingMap();
      if (Object.hasOwn(map, key)) {
        taken = map[key];
        delete map[key];
        await writePendingMap(map);
      }
    });
    return taken;
  }

  async function hasPendingForTrack(trackKey) {
    const map = await readPendingMap();
    const now = Date.now();
    return Object.values(map).some(
      (entry) => entry && entry.trackKey === trackKey && now - (entry.createdAt || 0) < PENDING_FETCH_TTL_MS
    );
  }

  async function revokePageBlob(tabId, blobUrl) {
    if (!Number.isInteger(tabId) || !blobUrl) return;
    await sendToTabFn(tabId, ACTION.REVOKE_BLOB_URL, { blobUrl });
  }

  /** 第 1 步：由 SW 下发 FETCH_DASH_BLOB 给页面 MAIN 世界执行拉流 */
  async function requestDashFetch({ tabId, tabState, decision, settings }) {
    const best = decision.bestAudio;
    const taskId = `task_${tabState.trackKey}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const filename = buildArchiveFilename(tabState.meta, {
      baseDir: settings.archiveSubfolder,
      groupMultiPartInSubdir: settings.groupMultiPartInSubdir,
      ext: 'm4a',
    });
    const fallbackFilename = buildFallbackFilename(
      { bvid: tabState.meta.bvid, cid: tabState.meta.cid, qualityId: best.id },
      { baseDir: settings.archiveSubfolder, ext: 'm4a' }
    );
    const urls = Array.from(new Set([best.baseUrl, ...(best.backupUrl || [])].filter(Boolean)));

    const taskCtx = {
      kind: 'fetch',
      taskId,
      tabId,
      trackKey: tabState.trackKey,
      qualityId: best.id,
      codecs: best.codecs || '',
      filename,
      fallbackFilename,
      isUpgrade: Boolean(decision.isUpgrade),
      oldDownloadId: decision.oldDownloadId || null,
      meta: tabState.meta,
      createdAt: Date.now(),
    };
    await savePendingEntry(taskId, taskCtx);

    await onStatusUpdate(tabId, tabState.trackKey, {
      downloadStatus: DOWNLOAD_STATUS.DOWNLOADING,
      downloadError: null,
    });

    const sendRes = await sendToTabFn(tabId, ACTION.FETCH_DASH_BLOB, {
      taskId,
      trackKey: tabState.trackKey,
      qualityId: best.id,
      codecs: best.codecs || '',
      filename,
      fallbackFilename,
      oldDownloadId: decision.oldDownloadId || null,
      meta: tabState.meta,
      urls,
      mimeType: settings.audioMimeType || 'audio/x-m4a',
    });

    if (!sendRes?.ok) {
      await takePendingEntry(taskId);
      const errMsg = sendRes?.error || '无法连接页面探针，请刷新 B 站标签页';
      await onStatusUpdate(tabId, tabState.trackKey, {
        downloadStatus: DOWNLOAD_STATUS.ERROR,
        downloadError: errMsg,
      });
      return { ok: false, error: errMsg };
    }

    return { ok: true, taskId, filename };
  }

  /** 第 2 步：收到页面生成的 Blob URL，调用 chrome.downloads.download 落盘（含降级保底） */
  async function handleDashBlobReady(payload, sender) {
    const tabId = sender?.tab?.id ?? payload?.tabId;
    const taskId = payload?.taskId;
    const task = taskId ? await takePendingEntry(taskId) : null;

    const blobUrl = payload?.blobUrl;
    const trackKey = task?.trackKey || payload?.trackKey;
    const filename = task?.filename || payload?.filename;
    const fallbackFilename = task?.fallbackFilename || payload?.fallbackFilename || filename;
    const qualityId = task?.qualityId ?? payload?.qualityId;
    const codecs = task?.codecs ?? payload?.codecs ?? '';
    const isUpgrade = Boolean(task?.isUpgrade);
    const oldDownloadId = task?.oldDownloadId ?? payload?.oldDownloadId ?? null;
    const meta = task?.meta || payload?.meta;

    const downloads = getDownloadsApi();
    if (!blobUrl || !downloads?.download) {
      if (Number.isInteger(tabId) && blobUrl) await revokePageBlob(tabId, blobUrl);
      await onStatusUpdate(tabId, trackKey, {
        downloadStatus: DOWNLOAD_STATUS.ERROR,
        downloadError: 'Missing blobUrl or downloads API',
      });
      return { ok: false, error: 'Missing blobUrl or downloads API' };
    }

    let downloadId = null;
    let usedFallback = false;
    let chosenFilename = filename;

    try {
      downloadId = await downloads.download({
        url: blobUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (primaryErr) {
      try {
        usedFallback = true;
        chosenFilename = fallbackFilename;
        downloadId = await downloads.download({
          url: blobUrl,
          filename: fallbackFilename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
      } catch (fallbackErr) {
        await revokePageBlob(tabId, blobUrl);
        const errMsg = String((fallbackErr && fallbackErr.message) || fallbackErr || primaryErr);
        await onStatusUpdate(tabId, trackKey, {
          downloadStatus: DOWNLOAD_STATUS.ERROR,
          downloadError: errMsg,
        });
        return { ok: false, error: errMsg };
      }
    }

    await savePendingEntry(String(downloadId), {
      kind: 'download',
      downloadId,
      tabId,
      trackKey,
      qualityId,
      codecs,
      filename: chosenFilename,
      fallbackFilename,
      usedFallback,
      blobUrl,
      isUpgrade,
      oldDownloadId,
      meta,
      createdAt: Date.now(),
    });

    // 防止内存 Blob 秒级落盘时 onChanged 早于 savePendingEntry 触发
    await finalizeDownload(downloadId);
    return { ok: true, downloadId };
  }

  /** 页面侧拉流全部节点失败时的回调处理 */
  async function handleDashBlobFailed(payload, sender) {
    const tabId = sender?.tab?.id ?? payload?.tabId;
    const task = payload?.taskId ? await takePendingEntry(payload.taskId) : null;
    const trackKey = task?.trackKey || payload?.trackKey;
    const errMsg = payload?.error || 'DASH stream fetch failed';

    await onStatusUpdate(tabId, trackKey, {
      downloadStatus: DOWNLOAD_STATUS.ERROR,
      downloadError: errMsg,
    });
    return { ok: true };
  }

  /** 第 3 步：监听下载完结，写入曲库、升级删旧档、失败降级重试并释放 Blob URL */
  async function finalizeDownload(downloadId) {
    if (inFlightFinalizes.has(downloadId)) {
      await inFlightFinalizes.get(downloadId);
      const remaining = await readPendingMap();
      if (!remaining[String(downloadId)]) return;
    }

    const work = (async () => {
      const downloads = getDownloadsApi();
      if (!downloads?.search) return;

      const items = await downloads.search({ id: downloadId });
      const item = Array.isArray(items) ? items[0] : null;
      if (!item || (item.state !== 'complete' && item.state !== 'interrupted')) return;

      const pending = await takePendingEntry(String(downloadId));
      if (!pending || pending.kind !== 'download') return;

      if (item.state === 'complete') {
        if (pending.meta?.bvid && pending.meta?.cid) {
          await upsertTrackMetaFn(pending.meta);
        }
        const savedPath = item.filename || pending.filename;
        const updatedTrack = await markTrackDownloadedFn(pending.trackKey, {
          qualityId: pending.qualityId,
          codecs: pending.codecs,
          downloadId,
          filename: savedPath,
        });

        if (pending.isUpgrade && pending.oldDownloadId != null && pending.oldDownloadId !== downloadId) {
          try { await downloads.removeFile(pending.oldDownloadId); } catch (_) {}
          try { await downloads.erase({ id: pending.oldDownloadId }); } catch (_) {}
        }

        await revokePageBlob(pending.tabId, pending.blobUrl);
        await onStatusUpdate(pending.tabId, pending.trackKey, {
          downloadStatus: pending.isUpgrade ? DOWNLOAD_STATUS.UPGRADED : DOWNLOAD_STATUS.COMPLETED,
          downloadError: null,
          trackStats: updatedTrack
            ? {
                playCount: updatedTrack.playCount || 0,
                totalPlayedSeconds: updatedTrack.totalPlayedSeconds || 0,
                downloadedQualityId: updatedTrack.qualityId,
                filename: updatedTrack.filename,
              }
            : undefined,
        });
        return;
      }

      // 下载被中断：若尚未用保底短名重试且属路径/文件类失败，则原地用同一个 Blob URL 降级重试
      const errCode = item.error || 'INTERRUPTED';
      if (!pending.usedFallback && /FILE_|PATH/i.test(errCode) && downloads.download) {
        try {
          const retryId = await downloads.download({
            url: pending.blobUrl,
            filename: pending.fallbackFilename,
            conflictAction: 'uniquify',
            saveAs: false,
          });
          await savePendingEntry(String(retryId), {
            ...pending,
            downloadId: retryId,
            filename: pending.fallbackFilename,
            usedFallback: true,
            createdAt: Date.now(),
          });
          await finalizeDownload(retryId);
          return;
        } catch (_) {}
      }

      await revokePageBlob(pending.tabId, pending.blobUrl);
      await onStatusUpdate(pending.tabId, pending.trackKey, {
        downloadStatus: DOWNLOAD_STATUS.ERROR,
        downloadError: errCode,
      });
    })();

    inFlightFinalizes.set(downloadId, work);
    try {
      await work;
    } finally {
      if (inFlightFinalizes.get(downloadId) === work) {
        inFlightFinalizes.delete(downloadId);
      }
    }
  }

  return {
    hasPendingForTrack,
    requestDashFetch,
    handleDashBlobReady,
    handleDashBlobFailed,
    finalizeDownload,
  };
}
