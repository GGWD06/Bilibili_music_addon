/**
 * @fileoverview 桌面播放器持久化数据库与歌单/跨端统计合并引擎。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDefaultMusicDirs, extractArchiveRootFromFilename } from './scanner.mjs';

const DEFAULT_THRESHOLD_SECONDS = 15;
const MAX_PLAY_LOGS = 5000;

function normalizePathCompare(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function makeLocalKey(relativePath) {
  const norm = normalizePathCompare(relativePath);
  return 'local_' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function sanitizeTrack(raw) {
  const biliPlayCount = Math.max(0, Number(raw.biliPlayCount ?? 0) || 0);
  const biliPlayedSeconds = Math.max(0, Number(raw.biliPlayedSeconds ?? 0) || 0);
  const playerPlayCount = Math.max(0, Number(raw.playerPlayCount ?? 0) || 0);
  const playerPlayedSeconds = Math.max(0, Number(raw.playerPlayedSeconds ?? 0) || 0);

  return {
    ...raw,
    biliPlayCount,
    biliPlayedSeconds: Number(biliPlayedSeconds.toFixed(2)),
    playerPlayCount,
    playerPlayedSeconds: Number(playerPlayedSeconds.toFixed(2)),
    totalPlayCount: biliPlayCount + playerPlayCount,
    totalPlayedSeconds: Number((biliPlayedSeconds + playerPlayedSeconds).toFixed(2)),
    favorite: Boolean(raw.favorite),
    fileExists: Boolean(raw.fileExists),
  };
}

/**
 * 创建播放器持久化存储实例。
 * @param {{ dataFilePath?: string, defaultMusicDirs?: string[] }} [options]
 */
export function createPlayerStore(options = {}) {
  const dataFilePath = path.resolve(
    options.dataFilePath || path.join(process.cwd(), 'player', 'data', 'library.json')
  );
  const hasCustomDefaultDirs = Array.isArray(options.defaultMusicDirs) && options.defaultMusicDirs.length > 0;
  const defaultDirs = hasCustomDefaultDirs
    ? options.defaultMusicDirs.map((d) => path.resolve(d))
    : getDefaultMusicDirs();

  function isDirCovered(candidateDir, dirList) {
    const candNorm = normalizePathCompare(path.resolve(candidateDir));
    return (dirList || []).some((existing) => {
      const exNorm = normalizePathCompare(path.resolve(existing));
      return candNorm === exNorm || candNorm.startsWith(exNorm.endsWith('/') ? exNorm : exNorm + '/');
    });
  }

  let state = {
    version: 1,
    settings: {
      musicDirs: defaultDirs,
      countThresholdSeconds: DEFAULT_THRESHOLD_SECONDS,
    },
    tracks: {},
    playlists: [],
    playLogs: [],
  };

  let loaded = false;
  let opChain = Promise.resolve();

  function serialized(fn) {
    const next = opChain.then(fn, fn);
    opChain = next.catch(() => {});
    return next;
  }

  async function ensureLoaded() {
    if (loaded) return;
    let needsPersist = false;
    try {
      const raw = await fs.readFile(dataFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const storedDirs = Array.isArray(parsed.settings?.musicDirs) && parsed.settings.musicDirs.length > 0
          ? parsed.settings.musicDirs.map((d) => path.resolve(d))
          : [...defaultDirs];

        // 生产环境下自动补齐系统真实存在但尚未列入的默认 BiliMusic 目录（例如重定向到 D:\BiliMusic）
        if (!hasCustomDefaultDirs) {
          for (const d of getDefaultMusicDirs()) {
            try {
              if (fsSync.existsSync(d) && !isDirCovered(d, storedDirs)) {
                storedDirs.push(d);
                needsPersist = true;
              }
            } catch (_) {}
          }
        }

        state = {
          version: 1,
          settings: {
            musicDirs: storedDirs,
            countThresholdSeconds: Math.max(
              3,
              Number(parsed.settings?.countThresholdSeconds) || DEFAULT_THRESHOLD_SECONDS
            ),
          },
          tracks: {},
          playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
          playLogs: Array.isArray(parsed.playLogs) ? parsed.playLogs : [],
        };
        if (parsed.tracks && typeof parsed.tracks === 'object') {
          for (const [k, v] of Object.entries(parsed.tracks)) {
            if (v && typeof v === 'object') {
              state.tracks[k] = sanitizeTrack({ ...v, trackKey: v.trackKey || k });
            }
          }
        }
      }
    } catch (_) {
      // 首次启动无数据文件，保持空库并在首次写入时落盘
    }
    loaded = true;
    if (needsPersist) {
      await persist().catch(() => {});
    }
  }

  async function persist() {
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    const tmpPath = `${dataFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmpPath, dataFilePath);
  }

  function findMatchingTrackKeyForExt(extTrack) {
    const key = `${extTrack.bvid}_${extTrack.cid}`;
    if (state.tracks[key]) return key;
    if (!extTrack.filename) return null;

    const extNorm = normalizePathCompare(extTrack.filename);
    const extBase = path.posix.basename(extNorm);

    for (const [existingKey, t] of Object.entries(state.tracks)) {
      if (!existingKey.startsWith('local_')) continue;
      const fpNorm = normalizePathCompare(t.filePath || '');
      const relNorm = normalizePathCompare(t.relativePath || '');
      if (
        (fpNorm && (fpNorm === extNorm || fpNorm.endsWith('/' + extNorm) || extNorm.endsWith('/' + relNorm))) ||
        (relNorm && extNorm.endsWith('/' + relNorm)) ||
        (extBase && path.posix.basename(fpNorm) === extBase)
      ) {
        return existingKey;
      }
    }
    return null;
  }

  function mergeOneExtensionTrack(extTrack) {
    if (!extTrack || !extTrack.bvid || !extTrack.cid) return { track: null, dirAdded: false };
    let dirAdded = false;
    if (!hasCustomDefaultDirs && extTrack.filename) {
      const archiveRoot = extractArchiveRootFromFilename(extTrack.filename, extTrack);
      if (archiveRoot && !isDirCovered(archiveRoot, state.settings.musicDirs)) {
        state.settings.musicDirs.push(archiveRoot);
        dirAdded = true;
      }
    }

    const canonicalKey = `${extTrack.bvid}_${extTrack.cid}`;
    const matchedKey = findMatchingTrackKeyForExt(extTrack);
    let existing = matchedKey ? state.tracks[matchedKey] : null;

    // 若之前以 local_* 入库，则平滑迁移到 canonicalKey 并更新歌单引用
    if (matchedKey && matchedKey !== canonicalKey && existing) {
      delete state.tracks[matchedKey];
      for (const pl of state.playlists) {
        if (Array.isArray(pl.trackKeys)) {
          pl.trackKeys = pl.trackKeys.map((k) => (k === matchedKey ? canonicalKey : k));
          pl.trackKeys = Array.from(new Set(pl.trackKeys));
        }
      }
      for (const log of state.playLogs) {
        if (log.trackKey === matchedKey) log.trackKey = canonicalKey;
      }
    }

    const incomingBiliCount =
      extTrack.biliPlayCount !== undefined
        ? Number(extTrack.biliPlayCount) || 0
        : Number(extTrack.playCount) || 0;
    const incomingBiliSeconds =
      extTrack.biliPlayedSeconds !== undefined
        ? Number(extTrack.biliPlayedSeconds) || 0
        : Number(extTrack.totalPlayedSeconds) || 0;

    const prevBiliCount = existing?.biliPlayCount || 0;
    const prevBiliSeconds = existing?.biliPlayedSeconds || 0;
    const playerPlayCount = existing?.playerPlayCount || 0;
    const playerPlayedSeconds = existing?.playerPlayedSeconds || 0;

    const biliPlayCount = Math.max(prevBiliCount, incomingBiliCount);
    const biliPlayedSeconds = Number(Math.max(prevBiliSeconds, incomingBiliSeconds).toFixed(2));

    const merged = sanitizeTrack({
      ...(existing || {}),
      trackKey: canonicalKey,
      bvid: String(extTrack.bvid),
      cid: String(extTrack.cid),
      p: Number(extTrack.p) || existing?.p || 1,
      totalParts: Number(extTrack.totalParts) || existing?.totalParts || 1,
      title: extTrack.title || existing?.title || String(extTrack.bvid),
      part: extTrack.part !== undefined ? extTrack.part : (existing?.part ?? null),
      owner: extTrack.owner || existing?.owner || '',
      cover: extTrack.cover || existing?.cover || null,
      qualityId: extTrack.qualityId ?? existing?.qualityId ?? null,
      codecs: extTrack.codecs ?? existing?.codecs ?? null,
      filename: extTrack.filename || existing?.filename || null,
      downloadedAt: extTrack.downloadedAt || existing?.downloadedAt || null,
      firstPlayedAt: Math.min(
        existing?.firstPlayedAt || Number.MAX_SAFE_INTEGER,
        extTrack.firstPlayedAt || Number.MAX_SAFE_INTEGER
      ),
      lastPlayedAt: Math.max(existing?.lastPlayedAt || 0, Number(extTrack.lastPlayedAt) || 0) || Date.now(),
      biliPlayCount,
      biliPlayedSeconds,
      playerPlayCount,
      playerPlayedSeconds,
    });

    if (merged.firstPlayedAt === Number.MAX_SAFE_INTEGER) {
      merged.firstPlayedAt = merged.lastPlayedAt;
    }

    state.tracks[canonicalKey] = merged;
    return { track: merged, dirAdded };
  }

  function buildSummary() {
    const list = Object.values(state.tracks);
    let playableTracks = 0;
    let favoriteTracks = 0;
    let totalPlayCount = 0;
    let totalPlayedSeconds = 0;
    let biliPlayCount = 0;
    let biliPlayedSeconds = 0;
    let playerPlayCount = 0;
    let playerPlayedSeconds = 0;

    for (const t of list) {
      if (t.fileExists && t.filePath) playableTracks += 1;
      if (t.favorite) favoriteTracks += 1;
      biliPlayCount += t.biliPlayCount || 0;
      biliPlayedSeconds += t.biliPlayedSeconds || 0;
      playerPlayCount += t.playerPlayCount || 0;
      playerPlayedSeconds += t.playerPlayedSeconds || 0;
      totalPlayCount += t.totalPlayCount || 0;
      totalPlayedSeconds += t.totalPlayedSeconds || 0;
    }

    return {
      totalTracks: list.length,
      playableTracks,
      favoriteTracks,
      totalPlaylists: state.playlists.length,
      totalPlayCount,
      totalPlayedSeconds: Number(totalPlayedSeconds.toFixed(2)),
      biliPlayCount,
      biliPlayedSeconds: Number(biliPlayedSeconds.toFixed(2)),
      playerPlayCount,
      playerPlayedSeconds: Number(playerPlayedSeconds.toFixed(2)),
    };
  }

  async function init() {
    return serialized(async () => {
      await ensureLoaded();
      return getSnapshotUnlocked();
    });
  }

  function getSnapshotUnlocked() {
    const tracks = Object.values(state.tracks).sort(
      (a, b) => (b.lastPlayedAt || b.downloadedAt || 0) - (a.lastPlayedAt || a.downloadedAt || 0)
    );
    return {
      settings: { ...state.settings },
      summary: buildSummary(),
      tracks,
      playlists: state.playlists.map((p) => ({ ...p, trackKeys: [...(p.trackKeys || [])] })),
    };
  }

  async function getSnapshot() {
    return serialized(async () => {
      await ensureLoaded();
      return getSnapshotUnlocked();
    });
  }

  async function getSettings() {
    return serialized(async () => {
      await ensureLoaded();
      return { ...state.settings };
    });
  }

  async function updateSettings(patch = {}) {
    return serialized(async () => {
      await ensureLoaded();
      if (Array.isArray(patch.musicDirs)) {
        const cleaned = patch.musicDirs
          .map((d) => String(d || '').trim())
          .filter(Boolean)
          .map((d) => path.resolve(d));
        if (cleaned.length > 0) {
          state.settings.musicDirs = Array.from(new Set(cleaned));
        }
      }
      if (patch.countThresholdSeconds !== undefined) {
        state.settings.countThresholdSeconds = Math.min(
          300,
          Math.max(3, Math.round(Number(patch.countThresholdSeconds) || DEFAULT_THRESHOLD_SECONDS))
        );
      }
      await persist();
      return { ...state.settings };
    });
  }

  /**
   * 将扫描到的本地音频文件列表同步入库（智能匹配插件已推送曲目与历史本地曲目）。
   * @param {Array<object>} scannedFiles
   */
  async function syncScannedFiles(scannedFiles = []) {
    return serialized(async () => {
      await ensureLoaded();

      // 先将所有存量曲目标记为未验证，避免已删除的磁盘文件仍显示可播
      for (const key of Object.keys(state.tracks)) {
        state.tracks[key] = { ...state.tracks[key], fileExists: false };
      }

      const entries = Object.entries(state.tracks);
      const byFilePath = new Map();
      const byRelative = new Map();
      const byBasename = new Map();

      for (const [k, t] of entries) {
        if (t.filePath) byFilePath.set(normalizePathCompare(t.filePath), k);
        if (t.relativePath) byRelative.set(normalizePathCompare(t.relativePath), k);
        if (t.filename) {
          const fnNorm = normalizePathCompare(t.filename);
          byRelative.set(fnNorm, k);
          byBasename.set(path.posix.basename(fnNorm), k);
        }
      }

      let added = 0;
      let matched = 0;
      const now = Date.now();

      for (const file of scannedFiles) {
        const fpNorm = normalizePathCompare(file.filePath);
        const relNorm = normalizePathCompare(file.relativePath);
        const baseNorm = normalizePathCompare(file.basename);

        let targetKey = byFilePath.get(fpNorm) || byRelative.get(relNorm) || null;

        if (!targetKey && file.parsedMeta?.bvid && file.parsedMeta?.cid) {
          const candidate = `${file.parsedMeta.bvid}_${file.parsedMeta.cid}`;
          if (state.tracks[candidate]) targetKey = candidate;
        }

        if (!targetKey) {
          for (const [k, t] of Object.entries(state.tracks)) {
            if (t.filename && normalizePathCompare(t.filename).endsWith('/' + relNorm)) {
              targetKey = k;
              break;
            }
          }
        }

        if (!targetKey && byBasename.has(baseNorm)) {
          const candidateKey = byBasename.get(baseNorm);
          const candidate = state.tracks[candidateKey];
          if (candidate && !candidate.fileExists) {
            targetKey = candidateKey;
          }
        }

        if (targetKey && state.tracks[targetKey]) {
          const prev = state.tracks[targetKey];
          state.tracks[targetKey] = sanitizeTrack({
            ...prev,
            filePath: file.filePath,
            relativePath: file.relativePath,
            fileSize: file.fileSize,
            fileExists: true,
            qualityId: prev.qualityId ?? file.parsedMeta?.qualityId ?? null,
            downloadedAt: prev.downloadedAt || Math.round(file.mtimeMs || now),
          });
          matched += 1;
        } else {
          const meta = file.parsedMeta || {};
          const newKey =
            meta.bvid && meta.cid ? `${meta.bvid}_${meta.cid}` : makeLocalKey(file.relativePath || file.filePath);
          const existingSameKey = state.tracks[newKey];
          state.tracks[newKey] = sanitizeTrack({
            ...(existingSameKey || {}),
            trackKey: newKey,
            bvid: meta.bvid || existingSameKey?.bvid || null,
            cid: meta.cid || existingSameKey?.cid || null,
            p: meta.p || existingSameKey?.p || 1,
            totalParts: existingSameKey?.totalParts || 1,
            title: existingSameKey?.title || meta.title || file.basename,
            part: existingSameKey?.part ?? meta.part ?? null,
            owner: existingSameKey?.owner || meta.owner || '',
            cover: existingSameKey?.cover || null,
            qualityId: existingSameKey?.qualityId ?? meta.qualityId ?? null,
            codecs: existingSameKey?.codecs ?? null,
            filename: existingSameKey?.filename || file.relativePath,
            filePath: file.filePath,
            relativePath: file.relativePath,
            fileSize: file.fileSize,
            fileExists: true,
            firstPlayedAt: existingSameKey?.firstPlayedAt || now,
            lastPlayedAt: existingSameKey?.lastPlayedAt || Math.round(file.mtimeMs || now),
            downloadedAt: existingSameKey?.downloadedAt || Math.round(file.mtimeMs || now),
          });
          added += 1;
        }
      }

      await persist();
      return {
        added,
        matched,
        summary: buildSummary(),
      };
    });
  }

  async function mergeExtensionTrack(extTrack) {
    return serialized(async () => {
      await ensureLoaded();
      const { track, dirAdded } = mergeOneExtensionTrack(extTrack);
      await persist();
      return { track, dirsChanged: dirAdded, summary: buildSummary() };
    });
  }

  async function mergeExtensionBatch(extTracks = []) {
    return serialized(async () => {
      await ensureLoaded();
      const mergedList = [];
      let dirsChanged = false;
      for (const t of extTracks) {
        const res = mergeOneExtensionTrack(t);
        if (res?.track) {
          mergedList.push(res.track);
          if (res.dirAdded) dirsChanged = true;
        }
      }
      await persist();
      return {
        mergedCount: mergedList.length,
        dirsChanged,
        tracks: Object.values(state.tracks).filter((t) => t.bvid && t.cid),
        summary: buildSummary(),
      };
    });
  }

  async function getTrack(trackKey) {
    return serialized(async () => {
      await ensureLoaded();
      return state.tracks[trackKey] || null;
    });
  }

  async function recordPlayerHeartbeat({ trackKey, sessionId, deltaSeconds = 0, incrementPlayCount = false, now = Date.now() }) {
    return serialized(async () => {
      await ensureLoaded();
      const existing = state.tracks[trackKey];
      if (!existing) {
        return null;
      }
      const delta = Math.max(0, Number(deltaSeconds) || 0);
      const nextPlayerSeconds = Number(((existing.playerPlayedSeconds || 0) + delta).toFixed(2));
      const nextPlayerCount = (existing.playerPlayCount || 0) + (incrementPlayCount ? 1 : 0);

      const updated = sanitizeTrack({
        ...existing,
        playerPlayedSeconds: nextPlayerSeconds,
        playerPlayCount: nextPlayerCount,
        lastPlayedAt: now,
      });
      state.tracks[trackKey] = updated;

      if (delta > 0 || incrementPlayCount) {
        const existingLog = sessionId
          ? state.playLogs.find((l) => l.sessionId === sessionId && l.trackKey === trackKey && l.source === 'player')
          : null;
        if (existingLog) {
          existingLog.duration = Number(((existingLog.duration || 0) + delta).toFixed(2));
          existingLog.timestamp = now;
          existingLog.counted = Boolean(existingLog.counted || incrementPlayCount);
        } else {
          state.playLogs.push({
            trackKey,
            sessionId: sessionId || null,
            source: 'player',
            timestamp: now,
            duration: Number(delta.toFixed(2)),
            counted: Boolean(incrementPlayCount),
          });
          if (state.playLogs.length > MAX_PLAY_LOGS) {
            state.playLogs = state.playLogs.slice(-MAX_PLAY_LOGS);
          }
        }
      }

      await persist();
      return { track: updated, summary: buildSummary() };
    });
  }

  async function toggleFavorite(trackKey, forceState) {
    return serialized(async () => {
      await ensureLoaded();
      const existing = state.tracks[trackKey];
      if (!existing) return null;
      const nextFav = forceState !== undefined ? Boolean(forceState) : !existing.favorite;
      state.tracks[trackKey] = { ...existing, favorite: nextFav };
      await persist();
      return { track: state.tracks[trackKey], summary: buildSummary() };
    });
  }

  async function createPlaylist({ name, description = '' }) {
    return serialized(async () => {
      await ensureLoaded();
      const safeName = String(name || '').trim();
      if (!safeName) {
        throw new Error('歌单名称不能为空');
      }
      const now = Date.now();
      const playlist = {
        id: `pl_${now}_${Math.random().toString(36).slice(2, 6)}`,
        name: safeName,
        description: String(description || '').trim(),
        trackKeys: [],
        createdAt: now,
        updatedAt: now,
      };
      state.playlists.push(playlist);
      await persist();
      return playlist;
    });
  }

  async function updatePlaylist(id, patch = {}) {
    return serialized(async () => {
      await ensureLoaded();
      const pl = state.playlists.find((p) => p.id === id);
      if (!pl) return null;
      if (patch.name !== undefined) {
        const trimmed = String(patch.name).trim();
        if (trimmed) pl.name = trimmed;
      }
      if (patch.description !== undefined) {
        pl.description = String(patch.description).trim();
      }
      if (Array.isArray(patch.trackKeys)) {
        pl.trackKeys = Array.from(new Set(patch.trackKeys.filter((k) => Boolean(state.tracks[k]))));
      }
      pl.updatedAt = Date.now();
      await persist();
      return pl;
    });
  }

  async function deletePlaylist(id) {
    return serialized(async () => {
      await ensureLoaded();
      const prevLen = state.playlists.length;
      state.playlists = state.playlists.filter((p) => p.id !== id);
      if (state.playlists.length !== prevLen) {
        await persist();
        return true;
      }
      return false;
    });
  }

  async function addTracksToPlaylist(id, trackKeys = []) {
    return serialized(async () => {
      await ensureLoaded();
      const pl = state.playlists.find((p) => p.id === id);
      if (!pl) return null;
      const set = new Set(pl.trackKeys || []);
      for (const k of trackKeys) {
        if (state.tracks[k]) set.add(k);
      }
      pl.trackKeys = Array.from(set);
      pl.updatedAt = Date.now();
      await persist();
      return pl;
    });
  }

  async function removeTrackFromPlaylist(id, trackKey) {
    return serialized(async () => {
      await ensureLoaded();
      const pl = state.playlists.find((p) => p.id === id);
      if (!pl) return null;
      pl.trackKeys = (pl.trackKeys || []).filter((k) => k !== trackKey);
      pl.updatedAt = Date.now();
      await persist();
      return pl;
    });
  }

  async function getLeaderboard({ sortBy = 'totalPlayCount', sourceFilter = 'all', limit = 100 } = {}) {
    return serialized(async () => {
      await ensureLoaded();
      const all = Object.values(state.tracks);
      const filtered = all.filter((t) => {
        if (sourceFilter === 'player') return (t.playerPlayCount || 0) > 0 || (t.playerPlayedSeconds || 0) > 0;
        if (sourceFilter === 'bili') return (t.biliPlayCount || 0) > 0 || (t.biliPlayedSeconds || 0) > 0;
        return (t.totalPlayCount || 0) > 0 || (t.totalPlayedSeconds || 0) > 0;
      });

      const pickMetric = (item) => {
        const byCount = sortBy === 'totalPlayCount' || sortBy === 'playCount';
        if (sortBy === 'lastPlayedAt') return item.lastPlayedAt || 0;
        if (sourceFilter === 'player') {
          return byCount ? item.playerPlayCount || 0 : item.playerPlayedSeconds || 0;
        }
        if (sourceFilter === 'bili') {
          return byCount ? item.biliPlayCount || 0 : item.biliPlayedSeconds || 0;
        }
        return byCount ? item.totalPlayCount || 0 : item.totalPlayedSeconds || 0;
      };

      const sorted = [...filtered].sort((a, b) => {
        const diff = pickMetric(b) - pickMetric(a);
        if (diff !== 0) return diff;
        return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
      });

      return {
        summary: buildSummary(),
        items: sorted.slice(0, Math.max(1, Number(limit) || 100)),
      };
    });
  }

  return {
    init,
    getSnapshot,
    getSettings,
    updateSettings,
    syncScannedFiles,
    mergeExtensionTrack,
    mergeExtensionBatch,
    getTrack,
    recordPlayerHeartbeat,
    toggleFavorite,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addTracksToPlaylist,
    removeTrackFromPlaylist,
    getLeaderboard,
  };
}
