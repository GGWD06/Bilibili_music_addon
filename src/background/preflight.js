/**
 * @fileoverview 下载前预检调度：IndexedDB 去重、chrome.downloads 本地文件存活校验与 DASH 音质升级判断。
 */

import { DOWNLOAD_STATUS, getQualityInfo } from '../common/constants.js';
import { getTrack as defaultGetTrack, clearTrackDownload as defaultClearTrackDownload } from '../common/db.js';

/**
 * 评估当前标签页曲目是否应当发起 DASH 原流下载（含本地存活校验与高音质升级判断）。
 * @param {{
 *   tabState: object|null,
 *   settings: object,
 *   forceManual?: boolean,
 *   hasActiveTask?: boolean
 * }} params
 * @param {{
 *   getTrack?: typeof defaultGetTrack,
 *   clearTrackDownload?: typeof defaultClearTrackDownload,
 *   searchDownloads?: (q: chrome.downloads.DownloadQuery) => Promise<chrome.downloads.DownloadItem[]>
 * }} [deps={}]
 * @returns {Promise<{
 *   shouldDownload: boolean,
 *   reason: string,
 *   status: string,
 *   isUpgrade?: boolean,
 *   oldDownloadId?: number|null,
 *   bestAudio?: object|null,
 *   existingFilename?: string|null
 * }>}
 */
export async function evaluateDownloadCandidate(params, deps = {}) {
  const { tabState, settings, forceManual = false, hasActiveTask = false } = params || {};
  const getTrackFn = deps.getTrack || defaultGetTrack;
  const clearDownloadFn = deps.clearTrackDownload || defaultClearTrackDownload;
  const searchDownloadsFn =
    deps.searchDownloads ||
    ((query) => (globalThis.chrome?.downloads?.search ? chrome.downloads.search(query) : Promise.resolve([])));

  if (!tabState?.meta?.bvid || !tabState?.meta?.cid) {
    return { shouldDownload: false, reason: 'NO_TRACK', status: DOWNLOAD_STATUS.IDLE };
  }
  if (tabState.hasDurl && !tabState.bestAudio) {
    return { shouldDownload: false, reason: 'UNSUPPORTED_DURL', status: DOWNLOAD_STATUS.UNSUPPORTED_DURL };
  }
  if (!tabState.bestAudio || !tabState.bestAudio.baseUrl) {
    return { shouldDownload: false, reason: 'NO_DASH_AUDIO', status: DOWNLOAD_STATUS.IDLE };
  }
  if (hasActiveTask || tabState.downloadStatus === DOWNLOAD_STATUS.DOWNLOADING) {
    return { shouldDownload: false, reason: 'ALREADY_IN_PROGRESS', status: DOWNLOAD_STATUS.DOWNLOADING };
  }

  const dbTrack = await getTrackFn(tabState.trackKey);
  if (!dbTrack || dbTrack.downloadId == null) {
    return {
      shouldDownload: true,
      reason: 'NEW_TRACK',
      status: DOWNLOAD_STATUS.CHECKING,
      isUpgrade: false,
      oldDownloadId: null,
      bestAudio: tabState.bestAudio,
    };
  }

  // 校验本地磁盘文件是否仍存活（若用户手动删除或记录已失活，清理关联并允许重下）
  let downloadItem = null;
  try {
    const items = await searchDownloadsFn({ id: dbTrack.downloadId });
    downloadItem = Array.isArray(items) ? items[0] || null : null;
  } catch (_) {}

  const fileAlive = Boolean(downloadItem && downloadItem.state === 'complete' && downloadItem.exists !== false);
  if (!fileAlive) {
    await clearDownloadFn(tabState.trackKey);
    return {
      shouldDownload: true,
      reason: 'MISSING_LOCAL_FILE',
      status: DOWNLOAD_STATUS.CHECKING,
      isUpgrade: false,
      oldDownloadId: null,
      bestAudio: tabState.bestAudio,
    };
  }

  const newWeight = getQualityInfo(tabState.bestAudio.id).weight;
  const oldWeight = getQualityInfo(dbTrack.qualityId).weight;
  const canUpgrade = Boolean(forceManual || settings?.enableQualityUpgrade);

  if (canUpgrade && newWeight > oldWeight) {
    return {
      shouldDownload: true,
      reason: 'QUALITY_UPGRADE',
      status: DOWNLOAD_STATUS.CHECKING,
      isUpgrade: true,
      oldDownloadId: dbTrack.downloadId,
      bestAudio: tabState.bestAudio,
    };
  }

  return {
    shouldDownload: false,
    reason: 'ALREADY_EXISTS',
    status: forceManual ? DOWNLOAD_STATUS.COMPLETED : DOWNLOAD_STATUS.SKIPPED,
    existingFilename: downloadItem.filename || dbTrack.filename || null,
  };
}
