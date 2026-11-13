/**
 * @fileoverview Service Worker 入口：调度曲目检测与状态快照、有效听歌流水入库、模式切换与后续下载管线入口。
 */

import {
  WORK_MODE,
  DOWNLOAD_STATUS,
  MSG_TARGET,
  ACTION,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  MODE_UI_META,
  pickBestAudioTrack,
  getQualityInfo,
} from '../common/constants.js';
import { createMessageRouter, notifyPopup } from '../common/messaging.js';
import {
  makeTrackKey,
  getTrack,
  upsertTrackMeta,
  recordPlayProgress,
  getLeaderboard,
  clearListeningStats,
} from '../common/db.js';

/** 串行化 session 状态写入，避免并发心跳与探测互相覆盖 */
let sessionWriteChain = Promise.resolve();
const tabOperationChains = new Map();

function withSessionLock(fn) {
  const next = sessionWriteChain.then(fn, fn);
  sessionWriteChain = next.catch(() => {});
  return next;
}

/** 按 tabId 串行化曲目切换与心跳结算，防止并发心跳重复计入 playCount */
function withTabQueue(tabId, fn) {
  const prev = tabOperationChains.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.catch(() => {}).finally(() => {
    if (tabOperationChains.get(tabId) === cleanup) {
      tabOperationChains.delete(tabId);
    }
  });
  tabOperationChains.set(tabId, cleanup);
  return next;
}

/** 读取用户持久配置（合并默认值） */
export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
}

/** 写入用户持久配置并同步图标角标 */
async function saveSettings(nextSettings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: nextSettings });
  await syncActionBadge(nextSettings.mode);
  return nextSettings;
}

/** 同步扩展栏三态角标（红 AUTO / 绿 STAT / 灰 OFF） */
export async function syncActionBadge(mode) {
  const meta = MODE_UI_META[mode] || MODE_UI_META[WORK_MODE.AUTO_CAPTURE];
  try {
    await chrome.action.setBadgeText({ text: meta.badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: meta.badgeColor });
  } catch (_) {}
}

/** 读取全部标签页实时状态快照 */
async function getTabStates() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.TAB_STATES);
  return stored[STORAGE_KEYS.TAB_STATES] || {};
}

/** 保存单个标签页实时状态快照并通知 Popup */
async function updateTabState(tabId, updater) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  let updatedState = null;

  await withSessionLock(async () => {
    const states = await getTabStates();
    const prev = states[tabId] || null;
    updatedState = typeof updater === 'function' ? updater(prev) : updater;
    if (updatedState === null) {
      delete states[tabId];
    } else {
      states[tabId] = updatedState;
    }
    await chrome.storage.session.set({ [STORAGE_KEYS.TAB_STATES]: states });
  });

  if (updatedState) {
    notifyPopup(ACTION.POPUP_STATE_UPDATED, { tabId, tabState: updatedState });
  }
  return updatedState;
}

/** 解析当前激活标签页 ID */
async function resolveTargetTabId(explicitTabId) {
  if (Number.isInteger(explicitTabId) && explicitTabId >= 0) return explicitTabId;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] && Number.isInteger(tabs[0].id) ? tabs[0].id : null;
}

/** 处理探针上报的当前在播曲目与 DASH 音轨信息 */
export async function handleTrackDetected(payload, sender) {
  const tabId = sender?.tab?.id;
  const meta = payload?.meta;
  if (!Number.isInteger(tabId) || !meta?.bvid || !meta?.cid) {
    return { ok: false, error: 'Missing tabId or track bvid/cid' };
  }

  return withTabQueue(tabId, async () => {
    const settings = await getSettings();
    const trackKey = makeTrackKey(meta.bvid, meta.cid);
    const bestAudio = pickBestAudioTrack(payload.audios);
    const qualityInfo = bestAudio ? getQualityInfo(bestAudio.id, bestAudio.codecs) : null;

    let dbTrack = await getTrack(trackKey);
    if (settings.mode !== WORK_MODE.PAUSED) {
      dbTrack = await upsertTrackMeta(meta);
    }

    const tabState = await updateTabState(tabId, (prev) => {
      const sameTrack = prev && prev.trackKey === trackKey;
      const sameSession = sameTrack && prev.sessionId === payload.sessionId;
      let downloadStatus = DOWNLOAD_STATUS.IDLE;

      if (payload.hasDurl && !bestAudio) {
        downloadStatus = DOWNLOAD_STATUS.UNSUPPORTED_DURL;
      } else if (sameTrack && prev.downloadStatus === DOWNLOAD_STATUS.DOWNLOADING) {
        downloadStatus = DOWNLOAD_STATUS.DOWNLOADING;
      } else if (dbTrack && dbTrack.downloadId != null) {
        downloadStatus = DOWNLOAD_STATUS.COMPLETED;
      }

      return {
        tabId,
        trackKey,
        sessionId: payload.sessionId || '',
        meta,
        matched: Boolean(payload.matched),
        source: payload.source || null,
        audios: Array.isArray(payload.audios) ? payload.audios : [],
        bestAudio,
        qualityInfo,
        hasDurl: Boolean(payload.hasDurl),
        downloadStatus,
        downloadError: null,
        sessionAccumulatedSeconds: sameSession ? prev.sessionAccumulatedSeconds || 0 : 0,
        sessionCounted: sameSession ? Boolean(prev.sessionCounted) : false,
        trackStats: {
          playCount: dbTrack ? dbTrack.playCount || 0 : 0,
          totalPlayedSeconds: dbTrack ? dbTrack.totalPlayedSeconds || 0 : 0,
          downloadedQualityId: dbTrack ? dbTrack.qualityId : null,
          filename: dbTrack ? dbTrack.filename : null,
        },
        updatedAt: Date.now(),
      };
    });

    return { ok: true, trackKey, tabState };
  });
}

/** 处理真实听歌时长心跳，合并入库并在达阈值时计数（Phase 3 将在此挂接自动捕获） */
export async function handlePlayHeartbeat(payload, sender) {
  const tabId = sender?.tab?.id;
  const meta = payload?.meta;
  const deltaSeconds = Number(payload?.deltaSeconds) || 0;
  if (!Number.isInteger(tabId) || !meta?.bvid || !meta?.cid || deltaSeconds <= 0) {
    return { ok: false, error: 'Invalid heartbeat payload' };
  }

  return withTabQueue(tabId, async () => {
    const settings = await getSettings();
    if (settings.mode === WORK_MODE.PAUSED) {
      return { ok: true, ignored: 'paused' };
    }

    const trackKey = makeTrackKey(meta.bvid, meta.cid);
    const sessionId = payload.sessionId || null;
    let incrementPlayCount = false;
    let reachedThresholdNow = false;

    const states = await getTabStates();
    const prev = states[tabId];
    const sameSession = prev && prev.trackKey === trackKey && prev.sessionId === sessionId;
    const nextAccum = (sameSession ? prev.sessionAccumulatedSeconds || 0 : 0) + deltaSeconds;
    const alreadyCounted = sameSession ? Boolean(prev.sessionCounted) : false;

    if (!alreadyCounted && nextAccum >= (Number(settings.autoCaptureThresholdSeconds) || 15)) {
      incrementPlayCount = true;
      reachedThresholdNow = true;
    }

    const updatedDb = await recordPlayProgress({
      trackMeta: meta,
      deltaSeconds,
      sessionId,
      incrementPlayCount,
    });

    const tabState = await updateTabState(tabId, (latest) => {
      const base = latest && latest.trackKey === trackKey
        ? latest
        : {
            tabId,
            trackKey,
            sessionId: sessionId || '',
            meta,
            matched: false,
            audios: [],
            bestAudio: null,
            qualityInfo: null,
            hasDurl: false,
            downloadStatus: DOWNLOAD_STATUS.IDLE,
            downloadError: null,
          };

      return {
        ...base,
        sessionId: sessionId || base.sessionId,
        sessionAccumulatedSeconds: Number(nextAccum.toFixed(2)),
        sessionCounted: Boolean(alreadyCounted || incrementPlayCount),
        trackStats: {
          playCount: updatedDb.playCount || 0,
          totalPlayedSeconds: updatedDb.totalPlayedSeconds || 0,
          downloadedQualityId: updatedDb.qualityId ?? null,
          filename: updatedDb.filename ?? null,
        },
        updatedAt: Date.now(),
      };
    });

    // Phase 3 接入点：当 reachedThresholdNow && settings.mode === WORK_MODE.AUTO_CAPTURE 时触发 preflight 自动拉流归档
    return {
      ok: true,
      reachedThresholdNow,
      mode: settings.mode,
      tabState,
    };
  });
}

/** 组装 Popup 首屏所需状态 */
export async function handleGetPopupState(payload) {
  const settings = await getSettings();
  const tabId = await resolveTargetTabId(payload?.tabId);
  const states = await getTabStates();
  const tabState = tabId != null ? states[tabId] || null : null;
  const dbTrack = tabState?.trackKey ? await getTrack(tabState.trackKey) : null;

  return {
    settings,
    tabId,
    tabState,
    dbTrack,
  };
}

/** 切换三态工作模式 */
export async function handleSetWorkMode(payload) {
  const mode = payload?.mode;
  if (!Object.values(WORK_MODE).includes(mode)) {
    return { ok: false, error: `Invalid work mode: ${mode}` };
  }
  const current = await getSettings();
  const settings = await saveSettings({ ...current, mode });
  notifyPopup(ACTION.POPUP_STATE_UPDATED, { settings });
  return { ok: true, settings };
}

/** 更新配置项 */
async function handleUpdateSettings(payload) {
  const current = await getSettings();
  const next = { ...current, ...(payload || {}) };
  if (!Object.values(WORK_MODE).includes(next.mode)) {
    next.mode = current.mode;
  }
  const settings = await saveSettings(next);
  notifyPopup(ACTION.POPUP_STATE_UPDATED, { settings });
  return { ok: true, settings };
}

/** 清空本地听歌统计并刷新会话快照计数 */
export async function handleClearStats() {
  await clearListeningStats();
  await withSessionLock(async () => {
    const states = await getTabStates();
    for (const key of Object.keys(states)) {
      if (states[key]?.trackStats) {
        states[key].trackStats.playCount = 0;
        states[key].trackStats.totalPlayedSeconds = 0;
        states[key].sessionAccumulatedSeconds = 0;
        states[key].sessionCounted = false;
      }
    }
    await chrome.storage.session.set({ [STORAGE_KEYS.TAB_STATES]: states });
  });
  notifyPopup(ACTION.POPUP_STATE_UPDATED, { statsCleared: true });
  return { ok: true };
}

// ---- 路由注册 ----
export const messageRouter = createMessageRouter(MSG_TARGET.BACKGROUND, {
  [ACTION.TRACK_DETECTED]: handleTrackDetected,
  [ACTION.PLAY_HEARTBEAT]: handlePlayHeartbeat,
  [ACTION.GET_POPUP_STATE]: handleGetPopupState,
  [ACTION.SET_WORK_MODE]: handleSetWorkMode,
  [ACTION.UPDATE_SETTINGS]: handleUpdateSettings,
  [ACTION.GET_LEADERBOARD]: (payload) => getLeaderboard(payload || {}),
  [ACTION.CLEAR_STATS]: handleClearStats,
});

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener(messageRouter);

  chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    await syncActionBadge(settings.mode);
  });

  chrome.runtime.onStartup.addListener(async () => {
    const settings = await getSettings();
    await syncActionBadge(settings.mode);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    updateTabState(tabId, null);
  });
}
