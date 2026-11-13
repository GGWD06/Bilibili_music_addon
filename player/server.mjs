/**
 * @fileoverview BiliMusic 独立配套音乐播放器本地 HTTP 服务（含 Range 音频流、目录实时监听与扩展双向同步接口）。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlayerStore } from './lib/store.mjs';
import { scanMusicDirectories, getDefaultMusicDirs } from './lib/scanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const ICONS_DIR = path.resolve(__dirname, '..', 'assets', 'icons');

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function safeResolveUnder(baseDir, reqPath) {
  const cleaned = decodeURIComponent(reqPath).replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, cleaned);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * 创建播放器 HTTP 服务实例。
 * @param {{ host?: string, port?: number, dataFilePath?: string, defaultMusicDirs?: string[], watchEnabled?: boolean }} [options]
 */
export function createPlayerServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port !== undefined ? Number(options.port) : 19527;
  const watchEnabled = options.watchEnabled !== false;
  const defaultMusicDirs = options.defaultMusicDirs || getDefaultMusicDirs();

  const store = createPlayerStore({
    dataFilePath: options.dataFilePath,
    defaultMusicDirs,
  });

  let server = null;
  let watchers = [];
  let rescanTimer = null;
  let lastExtensionSyncAt = null;
  let libraryRevision = 1;

  async function rescanLibrary() {
    const settings = await store.getSettings();
    const files = await scanMusicDirectories(settings.musicDirs);
    const result = await store.syncScannedFiles(files);
    libraryRevision += 1;
    return result;
  }

  function scheduleWatchRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanLibrary().catch(() => {});
    }, 450);
  }

  function closeWatchers() {
    for (const w of watchers) {
      try { w.close(); } catch (_) {}
    }
    watchers = [];
    clearTimeout(rescanTimer);
  }

  async function refreshWatchers() {
    closeWatchers();
    if (!watchEnabled) return;
    const settings = await store.getSettings();
    for (const dir of settings.musicDirs || []) {
      try {
        await fsp.mkdir(dir, { recursive: true });
        const watcher = fs.watch(dir, { recursive: true }, () => {
          scheduleWatchRescan();
        });
        watcher.on('error', () => {});
        watchers.push(watcher);
      } catch (_) {
        // 个别目录不可监听时降级，不影响手动扫描
      }
    }
  }

  async function handleAudioStream(req, res, urlObj) {
    const trackKey = urlObj.searchParams.get('trackKey') || '';
    const track = await store.getTrack(trackKey);
    if (!track || !track.filePath) {
      return sendJson(res, 404, { ok: false, error: 'Audio track or file not found' });
    }

    let stat;
    try {
      stat = await fsp.stat(track.filePath);
    } catch (_) {
      return sendJson(res, 404, { ok: false, error: 'Audio file missing on disk' });
    }

    const totalSize = stat.size;
    const ext = path.extname(track.filePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || 'audio/mp4';
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const match = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(totalSize - 1, Number(match[2])) : totalSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(track.filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': totalSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(track.filePath).pipe(res);
  }

  async function handleStatic(res, pathname) {
    if (pathname.startsWith('/assets/icons/')) {
      const rel = pathname.slice('/assets/icons/'.length);
      const file = safeResolveUnder(ICONS_DIR, rel);
      if (!file) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      try {
        const buf = await fsp.readFile(file);
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream' });
        res.end(buf);
      } catch (_) {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname;
    const file = safeResolveUnder(PUBLIC_DIR, relPath);
    if (!file) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const buf = await fsp.readFile(file);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream' });
      res.end(buf);
    } catch (_) {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  async function handleRequest(req, res) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = urlObj.pathname;

    try {
      // ---- Status & Library ----
      if (req.method === 'GET' && pathname === '/api/status') {
        const snap = await store.getSnapshot();
        return sendJson(res, 200, {
          ok: true,
          app: 'BiliMusicPlayer',
          version: '1.0.0',
          libraryRevision,
          lastExtensionSyncAt,
          summary: snap.summary,
          settings: snap.settings,
        });
      }

      if (req.method === 'GET' && pathname === '/api/library') {
        const snap = await store.getSnapshot();
        return sendJson(res, 200, {
          ok: true,
          libraryRevision,
          lastExtensionSyncAt,
          ...snap,
        });
      }

      if (req.method === 'POST' && pathname === '/api/library/rescan') {
        const scanRes = await rescanLibrary();
        const snap = await store.getSnapshot();
        return sendJson(res, 200, {
          ok: true,
          scan: scanRes,
          libraryRevision,
          ...snap,
        });
      }

      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const settings = await store.updateSettings(body);
        await refreshWatchers();
        await rescanLibrary();
        const snap = await store.getSnapshot();
        return sendJson(res, 200, { ok: true, settings, ...snap });
      }

      if (req.method === 'GET' && pathname === '/api/leaderboard') {
        const sortBy = urlObj.searchParams.get('sortBy') || 'totalPlayCount';
        const sourceFilter = urlObj.searchParams.get('sourceFilter') || 'all';
        const limit = Number(urlObj.searchParams.get('limit')) || 100;
        const board = await store.getLeaderboard({ sortBy, sourceFilter, limit });
        return sendJson(res, 200, { ok: true, ...board });
      }

      if (req.method === 'GET' && pathname === '/api/audio') {
        return await handleAudioStream(req, res, urlObj);
      }

      // ---- Player Playback & Favorites ----
      if (req.method === 'POST' && pathname === '/api/play-heartbeat') {
        const body = await readJsonBody(req);
        if (!body.trackKey) {
          return sendJson(res, 400, { ok: false, error: 'Missing trackKey' });
        }
        const resData = await store.recordPlayerHeartbeat({
          trackKey: body.trackKey,
          sessionId: body.sessionId || null,
          deltaSeconds: Number(body.deltaSeconds) || 0,
          incrementPlayCount: Boolean(body.incrementPlayCount),
        });
        if (!resData) {
          return sendJson(res, 404, { ok: false, error: 'Track not found' });
        }
        libraryRevision += 1;
        return sendJson(res, 200, { ok: true, ...resData });
      }

      if (req.method === 'POST' && pathname === '/api/tracks/favorite') {
        const body = await readJsonBody(req);
        const result = await store.toggleFavorite(body.trackKey, body.favorite);
        if (!result) {
          return sendJson(res, 404, { ok: false, error: 'Track not found' });
        }
        libraryRevision += 1;
        return sendJson(res, 200, { ok: true, ...result });
      }

      // ---- Playlists CRUD ----
      if (req.method === 'POST' && pathname === '/api/playlists') {
        const body = await readJsonBody(req);
        const playlist = await store.createPlaylist(body);
        libraryRevision += 1;
        return sendJson(res, 201, { ok: true, playlist });
      }

      const plTrackMatch = pathname.match(/^\/api\/playlists\/([^/]+)\/tracks$/);
      if (plTrackMatch && req.method === 'POST') {
        const plId = decodeURIComponent(plTrackMatch[1]);
        const body = await readJsonBody(req);
        let playlist = null;
        if (body.action === 'remove' && body.trackKey) {
          playlist = await store.removeTrackFromPlaylist(plId, body.trackKey);
        } else {
          const keys = Array.isArray(body.trackKeys) ? body.trackKeys : body.trackKey ? [body.trackKey] : [];
          playlist = await store.addTracksToPlaylist(plId, keys);
        }
        if (!playlist) return sendJson(res, 404, { ok: false, error: 'Playlist not found' });
        libraryRevision += 1;
        return sendJson(res, 200, { ok: true, playlist });
      }

      const plItemMatch = pathname.match(/^\/api\/playlists\/([^/]+)$/);
      if (plItemMatch && req.method === 'PUT') {
        const plId = decodeURIComponent(plItemMatch[1]);
        const body = await readJsonBody(req);
        const playlist = await store.updatePlaylist(plId, body);
        if (!playlist) return sendJson(res, 404, { ok: false, error: 'Playlist not found' });
        libraryRevision += 1;
        return sendJson(res, 200, { ok: true, playlist });
      }
      if (plItemMatch && req.method === 'DELETE') {
        const plId = decodeURIComponent(plItemMatch[1]);
        const removed = await store.deletePlaylist(plId);
        if (!removed) return sendJson(res, 404, { ok: false, error: 'Playlist not found' });
        libraryRevision += 1;
        return sendJson(res, 200, { ok: true });
      }

      // ---- Chrome Extension Sync APIs ----
      if (req.method === 'POST' && pathname === '/api/sync/event') {
        const body = await readJsonBody(req);
        const trackPayload = body?.payload?.track || body?.track;
        lastExtensionSyncAt = Date.now();
        if (trackPayload && trackPayload.bvid && trackPayload.cid) {
          const merged = await store.mergeExtensionTrack(trackPayload);
          if (merged.dirsChanged) {
            await refreshWatchers();
            await rescanLibrary();
          } else if (body.eventType === 'DOWNLOAD_COMPLETED') {
            await rescanLibrary();
          } else {
            libraryRevision += 1;
          }
          const latestTrack = await store.getTrack(`${trackPayload.bvid}_${trackPayload.cid}`);
          return sendJson(res, 200, {
            ok: true,
            track: latestTrack || merged.track,
            summary: merged.summary,
          });
        }
        const snap = await store.getSnapshot();
        return sendJson(res, 200, { ok: true, summary: snap.summary });
      }

      if (req.method === 'POST' && pathname === '/api/sync/full') {
        const body = await readJsonBody(req);
        const extTracks = Array.isArray(body.tracks) ? body.tracks : [];
        lastExtensionSyncAt = Date.now();
        const batchRes = await store.mergeExtensionBatch(extTracks);
        if (batchRes.dirsChanged) {
          await refreshWatchers();
        }
        await rescanLibrary();
        const snap = await store.getSnapshot();
        const syncableTracks = snap.tracks.filter((t) => t.bvid && t.cid);
        return sendJson(res, 200, {
          ok: true,
          tracks: syncableTracks,
          summary: snap.summary,
        });
      }

      // ---- Static UI & Assets ----
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        return await handleStatic(res, pathname);
      }

      return sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${pathname}` });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }

  async function start() {
    await store.init();
    await rescanLibrary();
    await refreshWatchers();

    server = http.createServer((req, res) => {
      handleRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    return {
      host,
      port: actualPort,
      url: `http://${host}:${actualPort}`,
    };
  }

  async function stop() {
    closeWatchers();
    if (!server) return;
    const s = server;
    server = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }

  return {
    store,
    start,
    stop,
    rescanLibrary,
  };
}
