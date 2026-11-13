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
import { MIME_BY_EXT, getAudioContentType, streamLocalFileWithRange } from './lib/media-stream.mjs';
import { createGdriveClient } from './lib/gdrive.mjs';
import { buildDownloadHistoryExport } from '../src/common/history-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const ICONS_DIR = path.resolve(__dirname, '..', 'assets', 'icons');

function escapeHtml(raw) {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

  const resolvedDataPath = path.resolve(
    options.dataFilePath || path.join(process.cwd(), 'player', 'data', 'library.json')
  );
  const dataDir = path.dirname(resolvedDataPath);

  const store = createPlayerStore({
    dataFilePath: resolvedDataPath,
    defaultMusicDirs,
  });

  const gdrive = createGdriveClient({
    authFilePath: path.join(dataDir, 'gdrive-auth.json'),
    cacheDir: path.join(dataDir, 'gdrive-cache'),
    ...(options.gdriveOptions || {}),
  });

  let server = null;
  let actualListeningPort = port;
  let watchers = [];
  let rescanTimer = null;
  let lastExtensionSyncAt = null;
  let libraryRevision = 1;
  let activeUploadPromise = null;

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
    if (!track) {
      return sendJson(res, 404, { ok: false, error: 'Audio track not found' });
    }

    if (track.fileExists && track.filePath) {
      try {
        const stat = await fsp.stat(track.filePath);
        const contentType = getAudioContentType(track.filePath);
        streamLocalFileWithRange(req, res, track.filePath, stat.size, contentType);
        return;
      } catch (_) {
        // 本地文件刚被移除时若存在云端备份则自动无缝兜底
      }
    }

    if (track.gdriveExists && track.gdriveFileId) {
      await gdrive.streamAudio(req, res, track);
      return;
    }

    return sendJson(res, 404, { ok: false, error: 'Audio file missing on disk and cloud' });
  }

  function renderOAuthCallbackHtml({ ok, userEmail, error }) {
    const title = ok ? 'Google Drive 授权成功' : 'Google Drive 授权失败';
    const desc = ok
      ? `已连接账号：${escapeHtml(userEmail || 'Google 用户')}。你可以关闭此页面返回 BiliMusic 播放器。`
      : `原因：${escapeHtml(error || '未知错误')}`;
    const accent = ok ? '#46c860' : '#f85149';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1116;color:#f1f4f9;font-family:"Segoe UI","PingFang SC",sans-serif}
.card{max-width:420px;background:#1a1d26;border:1px solid #2b3040;border-radius:12px;padding:24px 28px;text-align:center}
h1{font-size:18px;margin:0 0 10px;color:${accent}}p{font-size:13px;color:#9da7ba;line-height:1.6;margin:0 0 16px}
button{border:none;background:#fb7299;color:#fff;font-weight:600;border-radius:7px;padding:8px 16px;cursor:pointer}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${desc}</p><button id="close-btn">关闭标签页</button></div>
<script>
document.getElementById('close-btn').addEventListener('click',function(){window.close();});
${ok ? 'setTimeout(function(){try{window.close();}catch(_){}},1200);' : ''}
</script></body></html>`;
  }

  async function runBatchUpload(targets) {
    const totalBytes = targets.reduce((acc, t) => acc + (Number(t.fileSize) || 0), 0);
    let uploadedBeforeCurrent = 0;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let lastError = null;

    gdrive.setUploadProgress({
      active: true,
      total: targets.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      currentTitle: targets[0]?.title || '',
      bytesSent: 0,
      bytesTotal: totalBytes,
      lastError: null,
    });

    try {
      for (const track of targets) {
        const trackSize = Number(track.fileSize) || 0;
        gdrive.setUploadProgress({
          currentTitle: track.title || track.relativePath || track.trackKey,
          bytesSent: uploadedBeforeCurrent,
        });
        try {
          const res = await gdrive.uploadTrack(track, {
            onChunk: (_chunkLen, offset) => {
              gdrive.setUploadProgress({
                bytesSent: uploadedBeforeCurrent + offset,
              });
            },
          });
          await store.markTrackUploadedToDrive(track.trackKey, res);
          libraryRevision += 1;
          if (res.skippedExisting) skipped += 1;
          completed += 1;
        } catch (err) {
          failed += 1;
          lastError = String((err && err.message) || err);
        }
        uploadedBeforeCurrent += trackSize;
        gdrive.setUploadProgress({
          completed,
          failed,
          skipped,
          bytesSent: uploadedBeforeCurrent,
          lastError,
        });
      }
    } finally {
      gdrive.setUploadProgress({
        active: false,
        currentTitle: '',
        lastFinishedAt: Date.now(),
      });
    }
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
        const gdriveBrief = await gdrive.getBriefStatus();
        return sendJson(res, 200, {
          ok: true,
          app: 'BiliMusicPlayer',
          version: '1.0.0',
          libraryRevision,
          lastExtensionSyncAt,
          summary: snap.summary,
          settings: snap.settings,
          gdrive: gdriveBrief,
        });
      }

      // ---- Google Drive OAuth, Sync, Cache & Upload ----
      if (req.method === 'GET' && pathname === '/api/gdrive/status') {
        const status = await gdrive.getPublicStatus();
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (req.method === 'POST' && pathname === '/api/gdrive/config') {
        const body = await readJsonBody(req);
        const cfg = await gdrive.updateConfig(body);
        const status = await gdrive.getPublicStatus();
        return sendJson(res, 200, { ok: true, ...cfg, status });
      }

      if (req.method === 'POST' && pathname === '/api/gdrive/auth/start') {
        const body = await readJsonBody(req);
        const originHost = req.headers.host || `${host}:${actualListeningPort}`;
        const redirectUri = `http://${originHost}/api/gdrive/oauth/callback`;
        const authStart = await gdrive.startAuth({
          redirectUri,
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          folderInput: body.folderInput,
          cacheEnabled: body.cacheEnabled,
        });
        return sendJson(res, 200, authStart);
      }

      if (req.method === 'GET' && pathname === '/api/gdrive/oauth/callback') {
        const result = await gdrive.handleOAuthCallback({
          code: urlObj.searchParams.get('code') || '',
          state: urlObj.searchParams.get('state') || '',
          error: urlObj.searchParams.get('error') || '',
        });
        const html = renderOAuthCallbackHtml(result);
        res.writeHead(result.ok ? 200 : 400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/gdrive/auth/disconnect') {
        await gdrive.disconnect();
        await store.clearDrivePresence();
        libraryRevision += 1;
        const snap = await store.getSnapshot();
        const status = await gdrive.getPublicStatus();
        return sendJson(res, 200, { ok: true, gdrive: status, libraryRevision, ...snap });
      }

      if (req.method === 'POST' && pathname === '/api/gdrive/sync') {
        const scanRes = await gdrive.scanFolder();
        const mergeRes = await store.syncDriveFiles(scanRes.files);
        libraryRevision += 1;
        const snap = await store.getSnapshot();
        const status = await gdrive.getPublicStatus();
        return sendJson(res, 200, {
          ok: true,
          scan: {
            folderId: scanRes.folderId,
            folderMissing: scanRes.folderMissing,
            totalFiles: scanRes.files.length,
            added: mergeRes.added,
            matched: mergeRes.matched,
          },
          gdrive: status,
          libraryRevision,
          ...snap,
        });
      }

      if (req.method === 'POST' && pathname === '/api/gdrive/upload') {
        const body = await readJsonBody(req);
        if (activeUploadPromise) {
          return sendJson(res, 409, { ok: false, error: '当前已有 Google Drive 上传任务在进行中' });
        }

        if (body.trackKey) {
          const track = await store.getTrack(body.trackKey);
          if (!track || !track.fileExists || !track.filePath) {
            return sendJson(res, 404, { ok: false, error: '本地音频文件不存在，无法上传' });
          }
          gdrive.setUploadProgress({
            active: true,
            total: 1,
            completed: 0,
            failed: 0,
            skipped: 0,
            currentTitle: track.title || track.trackKey,
            bytesSent: 0,
            bytesTotal: Number(track.fileSize) || 0,
            lastError: null,
          });
          try {
            const upRes = await gdrive.uploadTrack(track, {
              onChunk: (_c, offset, total) => gdrive.setUploadProgress({ bytesSent: offset, bytesTotal: total }),
            });
            const updated = await store.markTrackUploadedToDrive(track.trackKey, upRes);
            libraryRevision += 1;
            gdrive.setUploadProgress({
              active: false,
              completed: 1,
              skipped: upRes.skippedExisting ? 1 : 0,
              currentTitle: '',
              lastFinishedAt: Date.now(),
            });
            const status = await gdrive.getPublicStatus();
            return sendJson(res, 200, {
              ok: true,
              skippedExisting: upRes.skippedExisting,
              track: updated?.track || track,
              summary: updated?.summary,
              gdrive: status,
              libraryRevision,
            });
          } catch (err) {
            const msg = String((err && err.message) || err);
            gdrive.setUploadProgress({ active: false, failed: 1, currentTitle: '', lastError: msg });
            return sendJson(res, 500, { ok: false, error: msg });
          }
        }

        const snap = await store.getSnapshot();
        let targets = [];
        if (Array.isArray(body.trackKeys) && body.trackKeys.length > 0) {
          const set = new Set(body.trackKeys);
          targets = snap.tracks.filter((t) => set.has(t.trackKey) && t.fileExists && t.filePath);
        } else {
          targets = snap.tracks.filter((t) => t.fileExists && t.filePath && !t.gdriveExists);
        }

        if (targets.length === 0) {
          return sendJson(res, 200, {
            ok: true,
            started: false,
            total: 0,
            message: '所有本地曲目均已备份到 Google Drive',
          });
        }

        activeUploadPromise = runBatchUpload(targets).finally(() => {
          activeUploadPromise = null;
        });

        if (body.wait) {
          await activeUploadPromise;
          const afterSnap = await store.getSnapshot();
          const status = await gdrive.getPublicStatus();
          return sendJson(res, 200, {
            ok: true,
            started: true,
            finished: true,
            total: targets.length,
            gdrive: status,
            libraryRevision,
            ...afterSnap,
          });
        }

        return sendJson(res, 202, {
          ok: true,
          started: true,
          total: targets.length,
          progress: gdrive.getUploadProgress(),
        });
      }

      if (req.method === 'POST' && pathname === '/api/gdrive/cache/clear') {
        const cleared = await gdrive.clearCache();
        const status = await gdrive.getPublicStatus();
        return sendJson(res, 200, { ok: true, ...cleared, gdrive: status });
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

      if (req.method === 'GET' && pathname === '/api/export/history') {
        const format = urlObj.searchParams.get('format') || 'md';
        const download = urlObj.searchParams.get('download') === '1' || urlObj.searchParams.get('download') === 'true';
        await rescanLibrary();
        const snap = await store.getSnapshot();
        const exported = buildDownloadHistoryExport(snap.tracks, {
          format,
          sourceLabel: 'BiliMusic 桌面播放器 (本地磁盘 + Google Drive 云端)',
        });

        if (download) {
          const asciiFallback = `BiliMusic-history.${exported.format}`;
          const buf = Buffer.from(exported.content, 'utf8');
          res.writeHead(200, {
            'Content-Type': exported.mimeType,
            'Content-Length': buf.length,
            'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
            'Cache-Control': 'no-store',
          });
          res.end(buf);
          return;
        }

        return sendJson(res, 200, {
          ok: true,
          empty: exported.count === 0,
          count: exported.count,
          format: exported.format,
          filename: exported.filename,
          mimeType: exported.mimeType,
          content: exported.content,
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
    actualListeningPort = actualPort;
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
    gdrive,
    start,
    stop,
    rescanLibrary,
  };
}
