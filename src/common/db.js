/**
 * @fileoverview IndexedDB 本地曲库与听歌流水封装（tracks 主表与 play_logs 流水表）。
 */

const DB_NAME = 'bilimusic_db';
const DB_VERSION = 1;
const STORE_TRACKS = 'tracks';
const STORE_PLAY_LOGS = 'play_logs';

let cachedDbPromise = null;

/**
 * 组装曲目复合主键（bvid + cid）。
 * @param {string} bvid
 * @param {string|number} cid
 * @returns {string}
 */
export function makeTrackKey(bvid, cid) {
  const safeBvid = String(bvid || '').trim();
  const safeCid = String(cid ?? '').trim();
  if (!safeBvid || !safeCid) {
    throw new TypeError('makeTrackKey requires non-empty bvid and cid');
  }
  return `${safeBvid}_${safeCid}`;
}

/**
 * 将 IDBRequest 包装为 Promise。
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * 等待事务完成或报错。
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * 初始化数据库 Schema。
 * @param {IDBDatabase} db
 */
function upgradeSchema(db) {
  if (!db.objectStoreNames.contains(STORE_TRACKS)) {
    const tracks = db.createObjectStore(STORE_TRACKS, { keyPath: 'trackKey' });
    tracks.createIndex('bvid', 'bvid', { unique: false });
    tracks.createIndex('cid', 'cid', { unique: false });
    tracks.createIndex('lastPlayedAt', 'lastPlayedAt', { unique: false });
    tracks.createIndex('playCount', 'playCount', { unique: false });
    tracks.createIndex('totalPlayedSeconds', 'totalPlayedSeconds', { unique: false });
    tracks.createIndex('downloadedAt', 'downloadedAt', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_PLAY_LOGS)) {
    const logs = db.createObjectStore(STORE_PLAY_LOGS, { keyPath: 'id', autoIncrement: true });
    logs.createIndex('trackKey', 'trackKey', { unique: false });
    logs.createIndex('timestamp', 'timestamp', { unique: false });
    logs.createIndex('sessionId', 'sessionId', { unique: false });
  }
}

/**
 * 打开（并复用）IndexedDB 连接；当传入自定义 factory 时用于隔离测试不走全局缓存。
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(idbFactory) {
  const useDefault = !idbFactory;
  const factory = idbFactory || globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new Error('IndexedDB is not available in this context'));
  }
  if (useDefault && cachedDbPromise) {
    return cachedDbPromise;
  }

  const promise = new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => upgradeSchema(event.target.result);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if (useDefault) cachedDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (useDefault) cachedDbPromise = null;
      reject(req.error || new Error('Failed to open IndexedDB'));
    };
  });

  if (useDefault) cachedDbPromise = promise;
  return promise;
}

/**
 * 合并曲目元数据与已有记录（保留已累积统计和已落盘信息）。
 * @param {object|undefined} existing
 * @param {object} meta
 * @param {number} now
 * @returns {object}
 */
function buildMergedTrack(existing, meta, now) {
  const trackKey = makeTrackKey(meta.bvid, meta.cid);
  const base = existing || {
    trackKey,
    bvid: String(meta.bvid),
    cid: String(meta.cid),
    p: 1,
    totalParts: 1,
    title: '',
    part: null,
    owner: '',
    cover: null,
    playCount: 0,
    totalPlayedSeconds: 0,
    firstPlayedAt: now,
    lastPlayedAt: now,
    qualityId: null,
    codecs: null,
    downloadId: null,
    filename: null,
    downloadedAt: null,
  };

  return {
    ...base,
    bvid: String(meta.bvid),
    cid: String(meta.cid),
    p: Number(meta.p) || base.p || 1,
    totalParts: Number(meta.totalParts) || base.totalParts || 1,
    title: meta.title || base.title || String(meta.bvid),
    part: meta.part !== undefined ? meta.part : base.part,
    owner: meta.owner || base.owner || '',
    cover: meta.cover || base.cover || null,
  };
}

/**
 * 按主键查询单首曲目记录。
 * @param {string} trackKey
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<object|null>}
 */
export async function getTrack(trackKey, idbFactory) {
  const db = await openDatabase(idbFactory);
  const tx = db.transaction(STORE_TRACKS, 'readonly');
  const record = await reqToPromise(tx.objectStore(STORE_TRACKS).get(trackKey));
  await txDone(tx);
  return record || null;
}

/**
 * 插入或刷新曲目基础元数据（不影响播放统计与下载记录）。
 * @param {object} trackMeta
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<object>}
 */
export async function upsertTrackMeta(trackMeta, idbFactory) {
  const db = await openDatabase(idbFactory);
  const trackKey = makeTrackKey(trackMeta.bvid, trackMeta.cid);
  const tx = db.transaction(STORE_TRACKS, 'readwrite');
  const store = tx.objectStore(STORE_TRACKS);
  const existing = await reqToPromise(store.get(trackKey));
  const merged = buildMergedTrack(existing, trackMeta, Date.now());
  store.put(merged);
  await txDone(tx);
  return merged;
}

/**
 * 在单一原子事务中累计有效听歌时长、播放次数并写入/更新 play_logs 会话流水。
 * @param {{ trackMeta: object, deltaSeconds?: number, sessionId?: string, incrementPlayCount?: boolean, now?: number }} params
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<object>} 更新后的曲目记录
 */
export async function recordPlayProgress(params, idbFactory) {
  const { trackMeta, deltaSeconds = 0, sessionId = null, incrementPlayCount = false, now = Date.now() } = params || {};
  const delta = Math.max(0, Number(deltaSeconds) || 0);
  const db = await openDatabase(idbFactory);
  const trackKey = makeTrackKey(trackMeta.bvid, trackMeta.cid);

  const tx = db.transaction([STORE_TRACKS, STORE_PLAY_LOGS], 'readwrite');
  const trackStore = tx.objectStore(STORE_TRACKS);
  const logStore = tx.objectStore(STORE_PLAY_LOGS);

  const existing = await reqToPromise(trackStore.get(trackKey));
  const updated = buildMergedTrack(existing, trackMeta, now);
  updated.totalPlayedSeconds = Number(((updated.totalPlayedSeconds || 0) + delta).toFixed(2));
  updated.lastPlayedAt = now;
  if (incrementPlayCount) {
    updated.playCount = (updated.playCount || 0) + 1;
  }
  trackStore.put(updated);

  if (delta > 0) {
    const roundedDelta = Number(delta.toFixed(2));
    const existingLog = sessionId ? await reqToPromise(logStore.index('sessionId').get(sessionId)) : null;
    if (existingLog && existingLog.trackKey === trackKey) {
      existingLog.duration = Number(((existingLog.duration || 0) + roundedDelta).toFixed(2));
      existingLog.timestamp = now;
      existingLog.counted = Boolean(existingLog.counted || incrementPlayCount);
      logStore.put(existingLog);
    } else {
      logStore.add({
        trackKey,
        sessionId: sessionId || null,
        timestamp: now,
        duration: roundedDelta,
        counted: Boolean(incrementPlayCount),
      });
    }
  }

  await txDone(tx);
  return updated;
}

/**
 * 记录或升级更新曲目的本地落盘状态。
 * @param {string} trackKey
 * @param {{ qualityId: number, codecs?: string|null, downloadId: number, filename: string, downloadedAt?: number }} info
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<object|null>}
 */
export async function markTrackDownloaded(trackKey, info, idbFactory) {
  const db = await openDatabase(idbFactory);
  const tx = db.transaction(STORE_TRACKS, 'readwrite');
  const store = tx.objectStore(STORE_TRACKS);
  const existing = await reqToPromise(store.get(trackKey));
  if (!existing) {
    await txDone(tx);
    return null;
  }
  const updated = {
    ...existing,
    qualityId: Number(info.qualityId),
    codecs: info.codecs ?? existing.codecs ?? null,
    downloadId: info.downloadId,
    filename: info.filename,
    downloadedAt: info.downloadedAt || Date.now(),
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

/**
 * 清除曲目记录中的本地下载关联（例如用户手动删除磁盘文件后允许重新下载）。
 * @param {string} trackKey
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<object|null>}
 */
export async function clearTrackDownload(trackKey, idbFactory) {
  const db = await openDatabase(idbFactory);
  const tx = db.transaction(STORE_TRACKS, 'readwrite');
  const store = tx.objectStore(STORE_TRACKS);
  const existing = await reqToPromise(store.get(trackKey));
  if (!existing) {
    await txDone(tx);
    return null;
  }
  const updated = {
    ...existing,
    qualityId: null,
    codecs: null,
    downloadId: null,
    filename: null,
    downloadedAt: null,
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

/**
 * 对曲目列表按指定维度排序（供排行榜与单元测试直接调用）。
 * @param {Array<object>} items
 * @param {'totalPlayedSeconds'|'playCount'|'lastPlayedAt'} [sortBy='totalPlayedSeconds']
 * @returns {Array<object>}
 */
export function sortLeaderboardItems(items, sortBy = 'totalPlayedSeconds') {
  const validKey = ['totalPlayedSeconds', 'playCount', 'lastPlayedAt'].includes(sortBy)
    ? sortBy
    : 'totalPlayedSeconds';
  return [...items].sort((a, b) => {
    const diff = (Number(b[validKey]) || 0) - (Number(a[validKey]) || 0);
    if (diff !== 0) return diff;
    return (Number(b.lastPlayedAt) || 0) - (Number(a.lastPlayedAt) || 0);
  });
}

/**
 * 异步聚合查询听歌排行榜及总体汇总统计（支持全量或近 N 天筛选）。
 * @param {{ sortBy?: 'totalPlayedSeconds'|'playCount'|'lastPlayedAt', days?: number, limit?: number, now?: number }} [options={}]
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<{ summary: { totalTracks: number, downloadedTracks: number, totalPlayCount: number, totalPlayedSeconds: number }, items: Array<object> }>}
 */
export async function getLeaderboard(options = {}, idbFactory) {
  const { sortBy = 'totalPlayedSeconds', days = 0, limit = 50, now = Date.now() } = options;
  const db = await openDatabase(idbFactory);
  const tx = db.transaction([STORE_TRACKS, STORE_PLAY_LOGS], 'readonly');
  const tracks = await reqToPromise(tx.objectStore(STORE_TRACKS).getAll());

  if (days > 0) {
    const since = now - days * 86400000;
    const range = globalThis.IDBKeyRange ? globalThis.IDBKeyRange.lowerBound(since) : null;
    const logs = range
      ? await reqToPromise(tx.objectStore(STORE_PLAY_LOGS).index('timestamp').getAll(range))
      : (await reqToPromise(tx.objectStore(STORE_PLAY_LOGS).getAll())).filter((l) => l.timestamp >= since);
    await txDone(tx);

    const trackMap = new Map(tracks.map((t) => [t.trackKey, t]));
    const periodMap = new Map();
    let downloadedTracks = 0;
    let totalPlayCount = 0;
    let totalPlayedSeconds = 0;

    for (const log of logs) {
      const base = trackMap.get(log.trackKey);
      if (!base) continue;
      let agg = periodMap.get(log.trackKey);
      if (!agg) {
        agg = { ...base, playCount: 0, totalPlayedSeconds: 0, lastPlayedAt: 0 };
        periodMap.set(log.trackKey, agg);
        if (base.downloadId != null) downloadedTracks++;
      }
      if (log.counted !== false) {
        agg.playCount += 1;
        totalPlayCount += 1;
      }
      agg.totalPlayedSeconds = Number((agg.totalPlayedSeconds + (Number(log.duration) || 0)).toFixed(2));
      agg.lastPlayedAt = Math.max(agg.lastPlayedAt, Number(log.timestamp) || 0);
      totalPlayedSeconds += Number(log.duration) || 0;
    }

    const sorted = sortLeaderboardItems(Array.from(periodMap.values()), sortBy);
    return {
      summary: {
        totalTracks: sorted.length,
        downloadedTracks,
        totalPlayCount,
        totalPlayedSeconds: Number(totalPlayedSeconds.toFixed(2)),
      },
      items: sorted.slice(0, Math.max(1, limit)),
    };
  }

  await txDone(tx);
  const summary = {
    totalTracks: 0,
    downloadedTracks: 0,
    totalPlayCount: 0,
    totalPlayedSeconds: 0,
  };
  const playedItems = [];

  for (const t of tracks) {
    if (t.downloadId != null) summary.downloadedTracks += 1;
    if ((t.totalPlayedSeconds || 0) > 0 || (t.playCount || 0) > 0) {
      summary.totalTracks += 1;
      summary.totalPlayCount += t.playCount || 0;
      summary.totalPlayedSeconds += t.totalPlayedSeconds || 0;
      playedItems.push(t);
    }
  }
  summary.totalPlayedSeconds = Number(summary.totalPlayedSeconds.toFixed(2));

  const sorted = sortLeaderboardItems(playedItems, sortBy);
  return {
    summary,
    items: sorted.slice(0, Math.max(1, limit)),
  };
}

/**
 * 仅清空听歌流水与播放计数，保留 tracks 表中的已下载归档与音质记录避免重复下载。
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<void>}
 */
export async function clearListeningStats(idbFactory) {
  const db = await openDatabase(idbFactory);
  const tx = db.transaction([STORE_TRACKS, STORE_PLAY_LOGS], 'readwrite');
  const trackStore = tx.objectStore(STORE_TRACKS);
  const logStore = tx.objectStore(STORE_PLAY_LOGS);

  logStore.clear();
  const allTracks = await reqToPromise(trackStore.getAll());
  for (const t of allTracks) {
    if (t.downloadId != null) {
      trackStore.put({ ...t, playCount: 0, totalPlayedSeconds: 0 });
    } else {
      trackStore.delete(t.trackKey);
    }
  }
  await txDone(tx);
}
