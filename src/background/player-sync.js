/**
 * @fileoverview 桌面配套音乐播放器实时双向同步客户端（连接失败静默降级，绝不阻塞插件主流程）。
 */

import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../common/constants.js';
import {
  getAllTracks as defaultGetAllTracks,
  mergeTracksFromPlayer as defaultMergeTracksFromPlayer,
} from '../common/db.js';

const SYNC_TIMEOUT_MS = 1500;

/**
 * 规范化播放器本地 API 根地址。
 * @param {object} [settings]
 * @returns {string}
 */
function resolveOrigin(settings) {
  const raw = String(settings?.playerApiOrigin || DEFAULT_SETTINGS.playerApiOrigin || 'http://127.0.0.1:19527').trim();
  return raw.replace(/\/+$/, '');
}

/**
 * 创建与独立配套播放器通信的同步客户端。
 * @param {object} [deps]
 */
export function createPlayerSyncClient(deps = {}) {
  const fetchFn = deps.fetch || ((...args) => globalThis.fetch(...args));
  const getAllTracksFn = deps.getAllTracks || defaultGetAllTracks;
  const mergeTracksFromPlayerFn = deps.mergeTracksFromPlayer || defaultMergeTracksFromPlayer;
  const getSessionStorage = () => deps.sessionStorage || globalThis.chrome?.storage?.session;
  const timeoutMs = Number(deps.timeoutMs) || SYNC_TIMEOUT_MS;

  async function writeSyncState(nextState) {
    const storage = getSessionStorage();
    if (!storage) return nextState;
    try {
      await storage.set({ [STORAGE_KEYS.PLAYER_SYNC_STATE]: nextState });
    } catch (_) {}
    return nextState;
  }

  async function readSyncState() {
    const storage = getSessionStorage();
    if (!storage) return { online: false, lastSyncAt: null, playerSummary: null };
    try {
      const res = await storage.get(STORAGE_KEYS.PLAYER_SYNC_STATE);
      return res?.[STORAGE_KEYS.PLAYER_SYNC_STATE] || { online: false, lastSyncAt: null, playerSummary: null };
    } catch (_) {
      return { online: false, lastSyncAt: null, playerSummary: null };
    }
  }

  async function requestJson(url, options = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, {
        ...options,
        signal: controller ? controller.signal : undefined,
      });
      if (!res || !res.ok) {
        return { ok: false, status: res?.status || 0 };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 探测桌面播放器在线状态并缓存状态快照。
   * @param {object} [settings]
   * @returns {Promise<{ online: boolean, lastSyncAt: number|null, playerSummary: object|null }>}
   */
  async function getStatus(settings = {}) {
    const prev = await readSyncState();
    if (settings.enablePlayerSync === false) {
      return writeSyncState({
        ...prev,
        online: false,
        disabled: true,
      });
    }

    const origin = resolveOrigin(settings);
    const res = await requestJson(`${origin}/api/status`, { method: 'GET' });
    if (!res.ok || !res.data?.ok) {
      return writeSyncState({
        ...prev,
        online: false,
        disabled: false,
      });
    }

    return writeSyncState({
      online: true,
      disabled: false,
      lastSyncAt: prev.lastSyncAt || Date.now(),
      playerSummary: res.data.summary || null,
    });
  }

  /**
   * 实时推送单次曲目/心跳/下载完成事件给桌面播放器，并合并回传的播放器端计数。
   * @param {string} eventType
   * @param {object} payload
   * @param {object} [settings]
   */
  async function pushEvent(eventType, payload, settings = {}) {
    if (settings.enablePlayerSync === false) {
      return { ok: false, skipped: 'disabled' };
    }

    const origin = resolveOrigin(settings);
    const res = await requestJson(`${origin}/api/sync/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        payload,
        timestamp: Date.now(),
      }),
    });

    if (!res.ok || !res.data?.ok) {
      await writeSyncState({
        ...(await readSyncState()),
        online: false,
        disabled: false,
      });
      return { ok: false, offline: true };
    }

    let mergedTrack = null;
    if (res.data.track && res.data.track.bvid && res.data.track.cid) {
      const mergedList = await mergeTracksFromPlayerFn([res.data.track]);
      mergedTrack = mergedList[0] || null;
    }

    const prev = await readSyncState();
    await writeSyncState({
      online: true,
      disabled: false,
      lastSyncAt: Date.now(),
      playerSummary: res.data.summary || prev.playerSummary || null,
    });

    return { ok: true, track: mergedTrack, playerTrack: res.data.track || null };
  }

  /**
   * 执行全量双向曲库与统计同步。
   * @param {object} [settings]
   */
  async function syncFull(settings = {}) {
    if (settings.enablePlayerSync === false) {
      return { ok: false, error: '桌面播放器同步已在设置中关闭' };
    }

    const localTracks = await getAllTracksFn();
    const origin = resolveOrigin(settings);
    const res = await requestJson(`${origin}/api/sync/full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks: localTracks,
        timestamp: Date.now(),
      }),
    });

    if (!res.ok || !res.data?.ok) {
      await writeSyncState({
        ...(await readSyncState()),
        online: false,
        disabled: false,
      });
      return {
        ok: false,
        offline: true,
        error: '未检测到运行中的桌面播放器（请先启动 start-player.bat）',
      };
    }

    const remoteTracks = Array.isArray(res.data.tracks) ? res.data.tracks : [];
    const mergedTracks = await mergeTracksFromPlayerFn(remoteTracks);

    const syncState = await writeSyncState({
      online: true,
      disabled: false,
      lastSyncAt: Date.now(),
      playerSummary: res.data.summary || null,
    });

    return {
      ok: true,
      mergedCount: mergedTracks.length,
      syncState,
      summary: res.data.summary || null,
    };
  }

  /**
   * 拉取桌面播放器完整实时曲库（连接失败静默降级）。
   * @param {object} [settings]
   * @returns {Promise<{ ok: boolean, tracks: Array<object>, summary?: object|null }>}
   */
  async function fetchLibrary(settings = {}) {
    if (settings.enablePlayerSync === false) {
      return { ok: false, skipped: 'disabled', tracks: [] };
    }
    const origin = resolveOrigin(settings);
    const res = await requestJson(`${origin}/api/library`, { method: 'GET' });
    if (!res.ok || !res.data?.ok || !Array.isArray(res.data.tracks)) {
      return { ok: false, offline: true, tracks: [] };
    }
    return {
      ok: true,
      tracks: res.data.tracks,
      summary: res.data.summary || null,
    };
  }

  return {
    getStatus,
    pushEvent,
    syncFull,
    fetchLibrary,
    readSyncState,
  };
}
