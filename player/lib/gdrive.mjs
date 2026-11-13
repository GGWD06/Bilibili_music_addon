/**
 * @fileoverview 零依赖 Google Drive API v3 客户端：OAuth 2.0 PKCE 授权、批量扫库、Range 流式代理与 2GB LRU 缓存、分片上传。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { SUPPORTED_AUDIO_EXTENSIONS, parseArchiveFilenameMeta } from './scanner.mjs';
import { getAudioContentType, streamLocalFileWithRange } from './media-stream.mjs';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB (256 KiB 的整数倍)
const AUTH_PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const QUERY_BATCH_SIZE = 25;

/**
 * 从用户粘贴的 Google Drive 文件夹链接或纯 ID 中提取 Folder ID。
 * @param {string} raw
 * @returns {string}
 */
export function parseDriveFolderId(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';

  const folderMatch = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];

  try {
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      const qId = url.searchParams.get('id');
      if (qId && /^[a-zA-Z0-9_-]+$/.test(qId)) return qId;
    }
  } catch (_) {}

  if (/^[a-zA-Z0-9_-]{6,}$/.test(input)) {
    return input;
  }
  return '';
}

function sanitizeId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unknown';
}

function escapeDriveQuery(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function defaultAuthState() {
  return {
    version: 1,
    clientId: '',
    clientSecret: '',
    folderInput: '',
    folderId: '',
    cacheEnabled: true,
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    scope: '',
    userEmail: '',
    displayName: '',
    lastSyncAt: null,
    lastError: null,
  };
}

/**
 * 创建 Google Drive 原生客户端实例。
 * @param {{ fetch?: Function, authFilePath?: string, cacheDir?: string, maxCacheBytes?: number, uploadChunkBytes?: number }} [options]
 */
export function createGdriveClient(options = {}) {
  const fetchFn = options.fetch || ((...args) => globalThis.fetch(...args));
  const authFilePath = path.resolve(
    options.authFilePath || path.join(process.cwd(), 'player', 'data', 'gdrive-auth.json')
  );
  const cacheDir = path.resolve(
    options.cacheDir || path.join(process.cwd(), 'player', 'data', 'gdrive-cache')
  );
  const maxCacheBytes = Number(options.maxCacheBytes) > 0 ? Number(options.maxCacheBytes) : DEFAULT_MAX_CACHE_BYTES;
  const uploadChunkBytes =
    Number(options.uploadChunkBytes) > 0 ? Number(options.uploadChunkBytes) : DEFAULT_UPLOAD_CHUNK_BYTES;

  let auth = defaultAuthState();
  let loaded = false;
  let stateLock = Promise.resolve();
  let inflightRefresh = null;
  let folderEnsureLock = Promise.resolve();
  const pendingStates = new Map();
  const activeCacheWrites = new Set();

  let uploadProgress = {
    active: false,
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    currentTitle: '',
    bytesSent: 0,
    bytesTotal: 0,
    lastFinishedAt: null,
    lastError: null,
  };

  function withLock(fn) {
    const next = stateLock.then(fn, fn);
    stateLock = next.catch(() => {});
    return next;
  }

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = await fsp.readFile(authFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        auth = {
          ...defaultAuthState(),
          ...parsed,
          cacheEnabled: parsed.cacheEnabled !== false,
        };
        if (auth.folderInput && !auth.folderId) {
          auth.folderId = parseDriveFolderId(auth.folderInput);
        }
      }
    } catch (_) {}
    loaded = true;
  }

  async function persist() {
    await fsp.mkdir(path.dirname(authFilePath), { recursive: true });
    const tmp = `${authFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(auth, null, 2), 'utf8');
    await fsp.rename(tmp, authFilePath);
  }

  function isConnected() {
    return Boolean(auth.clientId && (auth.refreshToken || (auth.accessToken && auth.expiresAt > Date.now())));
  }

  function prunePendingStates() {
    const now = Date.now();
    for (const [k, v] of pendingStates.entries()) {
      if (now - v.createdAt > AUTH_PENDING_TTL_MS) {
        pendingStates.delete(k);
      }
    }
  }

  async function getCacheStats() {
    let files = 0;
    let totalBytes = 0;
    try {
      const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
        try {
          const st = await fsp.stat(path.join(cacheDir, entry.name));
          files += 1;
          totalBytes += st.size;
        } catch (_) {}
      }
    } catch (_) {}
    return { files, totalBytes, maxBytes: maxCacheBytes };
  }

  async function pruneCacheLru() {
    try {
      const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
      const items = [];
      let total = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
        const full = path.join(cacheDir, entry.name);
        try {
          const st = await fsp.stat(full);
          items.push({ full, size: st.size, mtimeMs: st.mtimeMs });
          total += st.size;
        } catch (_) {}
      }
      if (total <= maxCacheBytes) return;
      items.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of items) {
        if (total <= maxCacheBytes) break;
        await fsp.unlink(item.full).catch(() => {});
        total -= item.size;
      }
    } catch (_) {}
  }

  async function clearCache() {
    let clearedFiles = 0;
    let freedBytes = 0;
    try {
      const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(cacheDir, entry.name);
        try {
          const st = await fsp.stat(full);
          await fsp.unlink(full);
          if (!entry.name.endsWith('.tmp')) {
            clearedFiles += 1;
            freedBytes += st.size;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return { ok: true, clearedFiles, freedBytes };
  }

  async function getBriefStatus() {
    return withLock(async () => {
      await ensureLoaded();
      return {
        connected: isConnected(),
        clientIdConfigured: Boolean(auth.clientId),
        hasClientSecret: Boolean(auth.clientSecret),
        folderId: auth.folderId || '',
        userEmail: auth.userEmail || '',
        displayName: auth.displayName || '',
        lastSyncAt: auth.lastSyncAt || null,
        lastError: auth.lastError || null,
        cacheEnabled: auth.cacheEnabled !== false,
        uploadProgress: { ...uploadProgress },
      };
    });
  }

  async function getPublicStatus() {
    const brief = await getBriefStatus();
    const cacheStats = await getCacheStats();
    return {
      ...brief,
      clientId: auth.clientId || '',
      folderInput: auth.folderInput || auth.folderId || '',
      cacheStats,
    };
  }

  async function updateConfig(patch = {}) {
    return withLock(async () => {
      await ensureLoaded();
      if (patch.clientId !== undefined) {
        auth.clientId = String(patch.clientId || '').trim();
      }
      if (patch.clearClientSecret) {
        auth.clientSecret = '';
      } else if (patch.clientSecret !== undefined) {
        const nextSecret = String(patch.clientSecret || '').trim();
        if (nextSecret) {
          auth.clientSecret = nextSecret;
        }
      }
      if (patch.folderInput !== undefined) {
        const raw = String(patch.folderInput || '').trim();
        auth.folderInput = raw;
        auth.folderId = parseDriveFolderId(raw);
      }
      if (patch.cacheEnabled !== undefined) {
        auth.cacheEnabled = Boolean(patch.cacheEnabled);
      }
      await persist();
      return {
        connected: isConnected(),
        clientId: auth.clientId,
        clientIdConfigured: Boolean(auth.clientId),
        hasClientSecret: Boolean(auth.clientSecret),
        folderInput: auth.folderInput,
        folderId: auth.folderId,
        cacheEnabled: auth.cacheEnabled,
      };
    });
  }

  async function startAuth({ redirectUri, clientId, clientSecret, folderInput, cacheEnabled } = {}) {
    if (
      clientId !== undefined ||
      clientSecret !== undefined ||
      folderInput !== undefined ||
      cacheEnabled !== undefined
    ) {
      await updateConfig({ clientId, clientSecret, folderInput, cacheEnabled });
    }
    return withLock(async () => {
      await ensureLoaded();
      if (!auth.clientId) {
        throw new Error('请先在设置中填写 Google OAuth Client ID');
      }
      if (!redirectUri) {
        throw new Error('Missing redirectUri');
      }

      prunePendingStates();
      const state = crypto.randomBytes(24).toString('hex');
      const codeVerifier = base64Url(crypto.randomBytes(32));
      const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());

      pendingStates.set(state, {
        codeVerifier,
        redirectUri,
        createdAt: Date.now(),
      });

      const params = new URLSearchParams({
        client_id: auth.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: DRIVE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      });

      return {
        ok: true,
        state,
        authUrl: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
      };
    });
  }

  async function fetchUserProfile(accessToken) {
    try {
      const res = await fetchFn(`${GOOGLE_DRIVE_API}/about?fields=user(displayName,emailAddress)`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res || !res.ok) return null;
      const json = await res.json();
      return json?.user || null;
    } catch (_) {
      return null;
    }
  }

  async function handleOAuthCallback({ code, state, error } = {}) {
    if (error) {
      await withLock(async () => {
        await ensureLoaded();
        auth.lastError = `授权被拒绝或失败: ${error}`;
        await persist();
      });
      return { ok: false, error: auth.lastError };
    }

    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (!pending) {
      return { ok: false, error: '无效或已过期的授权 state，请从播放器重新发起登录' };
    }
    if (!code) {
      return { ok: false, error: '未收到 Google 返回的授权码 (code)' };
    }

    await withLock(() => ensureLoaded());

    const form = new URLSearchParams({
      client_id: auth.clientId,
      code: String(code),
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri,
      grant_type: 'authorization_code',
    });
    if (auth.clientSecret) {
      form.set('client_secret', auth.clientSecret);
    }

    const tokenRes = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      const errMsg = tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`;
      await withLock(async () => {
        auth.lastError = `换取令牌失败: ${errMsg}`;
        await persist();
      });
      return { ok: false, error: auth.lastError };
    }

    const profile = await fetchUserProfile(tokenJson.access_token);
    await withLock(async () => {
      auth.accessToken = tokenJson.access_token;
      if (tokenJson.refresh_token) {
        auth.refreshToken = tokenJson.refresh_token;
      }
      auth.expiresAt = Date.now() + (Number(tokenJson.expires_in) || 3600) * 1000;
      auth.scope = tokenJson.scope || DRIVE_SCOPE;
      auth.userEmail = profile?.emailAddress || auth.userEmail || '';
      auth.displayName = profile?.displayName || auth.displayName || '';
      auth.lastError = null;
      await persist();
    });

    return {
      ok: true,
      userEmail: auth.userEmail,
      displayName: auth.displayName,
    };
  }

  async function disconnect() {
    const tokenToRevoke = await withLock(async () => {
      await ensureLoaded();
      const tok = auth.refreshToken || auth.accessToken || '';
      auth.accessToken = '';
      auth.refreshToken = '';
      auth.expiresAt = 0;
      auth.scope = '';
      auth.userEmail = '';
      auth.displayName = '';
      auth.lastError = null;
      await persist();
      return tok;
    });

    if (tokenToRevoke) {
      try {
        await fetchFn(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(tokenToRevoke)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch (_) {}
    }
    return { ok: true };
  }

  async function refreshAccessToken() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
      await withLock(() => ensureLoaded());
      if (!auth.clientId || !auth.refreshToken) {
        throw new Error('Google Drive 未授权或缺少 Refresh Token，请重新登录');
      }

      const form = new URLSearchParams({
        client_id: auth.clientId,
        refresh_token: auth.refreshToken,
        grant_type: 'refresh_token',
      });
      if (auth.clientSecret) {
        form.set('client_secret', auth.clientSecret);
      }

      const res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        const errCode = json.error || `HTTP ${res.status}`;
        const msg =
          errCode === 'invalid_grant'
            ? 'Google Drive 授权已过期或被撤销，请重新点击「连接 Google Drive」'
            : `刷新 Google 令牌失败: ${json.error_description || errCode}`;
        await withLock(async () => {
          if (res.status === 400 || res.status === 401 || errCode === 'invalid_grant') {
            auth.accessToken = '';
            auth.refreshToken = '';
            auth.expiresAt = 0;
          }
          auth.lastError = msg;
          await persist();
        });
        throw new Error(msg);
      }

      await withLock(async () => {
        auth.accessToken = json.access_token;
        auth.expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
        if (json.refresh_token) auth.refreshToken = json.refresh_token;
        auth.lastError = null;
        await persist();
      });
      return auth.accessToken;
    })();

    try {
      return await inflightRefresh;
    } finally {
      inflightRefresh = null;
    }
  }

  async function getValidAccessToken(forceRefresh = false) {
    await withLock(() => ensureLoaded());
    if (!forceRefresh && auth.accessToken && auth.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return auth.accessToken;
    }
    if (auth.refreshToken) {
      return refreshAccessToken();
    }
    if (!forceRefresh && auth.accessToken) {
      return auth.accessToken;
    }
    throw new Error('请先连接 Google Drive 账号');
  }

  async function driveFetch(url, reqOptions = {}, { retryOn401 = true } = {}) {
    const token = await getValidAccessToken(false);
    const headers = new Headers(reqOptions.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    let res = await fetchFn(url, { ...reqOptions, headers });
    if (res.status === 401 && retryOn401 && auth.refreshToken) {
      const nextToken = await getValidAccessToken(true);
      const retryHeaders = new Headers(reqOptions.headers || {});
      retryHeaders.set('Authorization', `Bearer ${nextToken}`);
      res = await fetchFn(url, { ...reqOptions, headers: retryHeaders });
    }
    return res;
  }

  async function driveListQuery(q) {
    const collected = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,md5Checksum)',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await driveFetch(`${GOOGLE_DRIVE_API}/files?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.error?.message || `Google Drive API 错误 (HTTP ${res.status})`;
        throw new Error(msg);
      }
      if (Array.isArray(json.files)) {
        collected.push(...json.files);
      }
      pageToken = json.nextPageToken || '';
    } while (pageToken);
    return collected;
  }

  async function findRootBiliMusicFolder(createIfMissing = false) {
    const q = `name = 'BiliMusic' and mimeType = '${DRIVE_FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const found = await driveListQuery(q);
    if (found.length > 0) {
      return found[0].id;
    }
    if (!createIfMissing) return '';

    const res = await driveFetch(`${GOOGLE_DRIVE_API}/files?supportsAllDrives=true&fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'BiliMusic',
        mimeType: DRIVE_FOLDER_MIME,
        parents: ['root'],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.id) {
      throw new Error(json?.error?.message || `创建 BiliMusic 云端目录失败 (HTTP ${res.status})`);
    }
    return json.id;
  }

  async function resolveTargetFolderId({ createIfMissing = false } = {}) {
    await withLock(() => ensureLoaded());
    let targetId = auth.folderId || parseDriveFolderId(auth.folderInput);
    if (!targetId) {
      targetId = await findRootBiliMusicFolder(createIfMissing);
      if (targetId) {
        await withLock(async () => {
          auth.folderId = targetId;
          if (!auth.folderInput) auth.folderInput = targetId;
          await persist();
        });
      }
    }
    return targetId;
  }

  /**
   * 递归扫描配置好的 Google Drive 文件夹（采用父目录批查询，极速拉取元数据）。
   */
  async function scanFolder() {
    const rootFolderId = await resolveTargetFolderId({ createIfMissing: false });
    if (!rootFolderId) {
      await withLock(async () => {
        auth.lastSyncAt = Date.now();
        auth.lastError = null;
        await persist();
      });
      return { ok: true, folderId: '', folderMissing: true, files: [] };
    }

    const prefixByFolderId = new Map([[rootFolderId, '']]);
    const visitedFolders = new Set([rootFolderId]);
    let frontier = [rootFolderId];
    const audioFiles = [];

    while (frontier.length > 0) {
      const nextFrontier = [];
      for (let i = 0; i < frontier.length; i += QUERY_BATCH_SIZE) {
        const batch = frontier.slice(i, i + QUERY_BATCH_SIZE);
        const parentExpr = batch.map((id) => `'${escapeDriveQuery(id)}' in parents`).join(' or ');
        const items = await driveListQuery(`(${parentExpr}) and trashed = false`);

        for (const item of items) {
          const parentId = Array.isArray(item.parents) ? item.parents.find((p) => prefixByFolderId.has(p)) : null;
          const parentPrefix = parentId ? prefixByFolderId.get(parentId) : '';
          const relPath = parentPrefix ? `${parentPrefix}/${item.name}` : item.name;

          if (item.mimeType === DRIVE_FOLDER_MIME) {
            if (!visitedFolders.has(item.id)) {
              visitedFolders.add(item.id);
              prefixByFolderId.set(item.id, relPath);
              nextFrontier.push(item.id);
            }
            continue;
          }

          const ext = path.extname(item.name || '').toLowerCase();
          if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) continue;

          const size = Number(item.size) || 0;
          const mtimeMs = item.modifiedTime ? Date.parse(item.modifiedTime) || Date.now() : Date.now();
          audioFiles.push({
            source: 'gdrive',
            gdriveFileId: item.id,
            gdriveMd5: item.md5Checksum || null,
            gdriveModifiedTime: mtimeMs,
            relativePath: relPath,
            basename: item.name,
            ext,
            fileSize: size,
            mtimeMs,
            parsedMeta: parseArchiveFilenameMeta(relPath),
          });
        }
      }
      frontier = nextFrontier;
    }

    await withLock(async () => {
      auth.lastSyncAt = Date.now();
      auth.lastError = null;
      await persist();
    });

    return { ok: true, folderId: rootFolderId, folderMissing: false, files: audioFiles };
  }

  /**
   * 播放 Google Drive 音频（优先命中本地 2GB LRU 缓存；未命中时透传 206 Range 并零额外带宽落盘缓存）。
   */
  async function streamAudio(req, res, track) {
    const fileId = track?.gdriveFileId;
    if (!fileId) {
      res.writeHead(404);
      res.end('Missing gdriveFileId');
      return;
    }

    await withLock(() => ensureLoaded());
    const nameHint = track.gdriveRelativePath || track.relativePath || track.filename || `${fileId}.m4a`;
    const ext = path.extname(nameHint).toLowerCase() || '.m4a';
    const contentType = getAudioContentType(nameHint);
    const safeId = sanitizeId(fileId);
    const cachePath = path.join(cacheDir, `${safeId}${ext}`);

    if (auth.cacheEnabled) {
      try {
        const st = await fsp.stat(cachePath);
        const expectedSize = Number(track.gdriveSize) || 0;
        if (st.size > 0 && (!expectedSize || st.size === expectedSize)) {
          fsp.utimes(cachePath, new Date(), new Date()).catch(() => {});
          streamLocalFileWithRange(req, res, cachePath, st.size, contentType);
          return;
        }
      } catch (_) {}
    }

    const rangeHeader = req.headers.range;
    const isFullFromStart = !rangeHeader || /^bytes=0-$/i.test(String(rangeHeader).trim());
    const controller = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientClosed = true;
        controller.abort();
      }
    });

    const upstreamHeaders = {};
    if (rangeHeader) upstreamHeaders.Range = rangeHeader;

    let upstream;
    try {
      upstream = await driveFetch(
        `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
        { headers: upstreamHeaders, signal: controller.signal }
      );
    } catch (err) {
      if (clientClosed) return;
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
      return;
    }

    if (!upstream.ok && upstream.status !== 206) {
      const errText = await upstream.text().catch(() => '');
      if (!res.headersSent) {
        res.writeHead(upstream.status || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: errText || `Drive HTTP ${upstream.status}` }));
      }
      return;
    }

    const outHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    };
    const upLength = upstream.headers.get('content-length');
    const upRange = upstream.headers.get('content-range');
    if (upLength) outHeaders['Content-Length'] = upLength;
    if (upRange) outHeaders['Content-Range'] = upRange;

    let expectedTotalBytes = Number(track.gdriveSize) || null;
    if (upRange) {
      const m = upRange.match(/\/(\d+)$/);
      if (m) expectedTotalBytes = Number(m[1]) || expectedTotalBytes;
    } else if (upLength && upstream.status === 200) {
      expectedTotalBytes = Number(upLength) || expectedTotalBytes;
    }

    res.writeHead(upstream.status === 206 ? 206 : 200, outHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    const shouldCache = auth.cacheEnabled && isFullFromStart && !activeCacheWrites.has(safeId);
    let tmpPath = '';
    let tmpStream = null;
    let bytesWritten = 0;

    if (shouldCache) {
      try {
        activeCacheWrites.add(safeId);
        await fsp.mkdir(cacheDir, { recursive: true });
        tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
        tmpStream = fs.createWriteStream(tmpPath);
        tmpStream.on('error', () => {
          try { tmpStream.destroy(); } catch (_) {}
          tmpStream = null;
        });
      } catch (_) {
        activeCacheWrites.delete(safeId);
        tmpStream = null;
        tmpPath = '';
      }
    }

    const cleanupTmp = async () => {
      if (tmpStream) {
        try { tmpStream.destroy(); } catch (_) {}
        tmpStream = null;
      }
      if (tmpPath) {
        await fsp.unlink(tmpPath).catch(() => {});
        tmpPath = '';
      }
      if (shouldCache) activeCacheWrites.delete(safeId);
    };

    try {
      const nodeStream = typeof upstream.body.getReader === 'function' ? Readable.fromWeb(upstream.body) : upstream.body;
      for await (const chunk of nodeStream) {
        if (clientClosed) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesWritten += buf.length;
        if (!res.write(buf)) {
          await once(res, 'drain', { signal: controller.signal });
        }
        if (tmpStream) {
          if (!tmpStream.write(buf)) {
            await once(tmpStream, 'drain', { signal: controller.signal });
          }
        }
      }

      const streamComplete = !clientClosed && bytesWritten > 0 && (!expectedTotalBytes || bytesWritten === expectedTotalBytes);
      if (tmpStream && streamComplete) {
        await new Promise((resolve) => tmpStream.end(resolve));
        tmpStream = null;
        await fsp.rename(tmpPath, cachePath);
        tmpPath = '';
        activeCacheWrites.delete(safeId);
        pruneCacheLru().catch(() => {});
      } else {
        await cleanupTmp();
      }

      if (!clientClosed && !res.writableEnded) {
        res.end();
      }
    } catch (_) {
      await cleanupTmp();
      if (!res.writableEnded) {
        try { res.end(); } catch (_) {}
      }
    }
  }

  async function ensureChildFolder(parentId, folderName) {
    const run = async () => {
      const q = `name = '${escapeDriveQuery(folderName)}' and mimeType = '${DRIVE_FOLDER_MIME}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`;
      const existing = await driveListQuery(q);
      if (existing.length > 0) return existing[0].id;

      const res = await driveFetch(`${GOOGLE_DRIVE_API}/files?supportsAllDrives=true&fields=id,name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: folderName,
          mimeType: DRIVE_FOLDER_MIME,
          parents: [parentId],
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.id) {
        throw new Error(json?.error?.message || `创建云端文件夹 ${folderName} 失败`);
      }
      return json.id;
    };

    const next = folderEnsureLock.then(run, run);
    folderEnsureLock = next.catch(() => {});
    return next;
  }

  async function ensureFolderHierarchy(rootFolderId, segments) {
    let currId = rootFolderId;
    for (const seg of segments) {
      if (!seg || seg === '.' || seg === '..') continue;
      currId = await ensureChildFolder(currId, seg);
    }
    return currId;
  }

  async function uploadFileResumable({ localPath, totalSize, mimeType, fileName, parentId, existingFileId, onChunk }) {
    const isUpdate = Boolean(existingFileId);
    const endpoint = isUpdate
      ? `${GOOGLE_DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,modifiedTime,md5Checksum`
      : `${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,modifiedTime,md5Checksum`;

    const initMeta = isUpdate ? { name: fileName } : { name: fileName, parents: [parentId] };
    const initRes = await driveFetch(endpoint, {
      method: isUpdate ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(totalSize),
      },
      body: JSON.stringify(initMeta),
    });

    if (!initRes.ok) {
      const errJson = await initRes.json().catch(() => ({}));
      throw new Error(errJson?.error?.message || `初始化上传会话失败 (HTTP ${initRes.status})`);
    }

    const sessionUri = initRes.headers.get('location');
    if (!sessionUri) {
      throw new Error('Google Drive 未返回上传会话地址 (Location)');
    }

    const fh = await fsp.open(localPath, 'r');
    let offset = 0;
    let uploadedMeta = null;
    try {
      while (offset < totalSize) {
        const len = Math.min(uploadChunkBytes, totalSize - offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead <= 0) break;
        const slice = bytesRead === len ? buf : buf.subarray(0, bytesRead);
        const end = offset + bytesRead - 1;

        const putRes = await driveFetch(
          sessionUri,
          {
            method: 'PUT',
            headers: {
              'Content-Length': String(bytesRead),
              'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
            },
            body: slice,
          },
          { retryOn401: false }
        );

        offset += bytesRead;
        onChunk?.(bytesRead, offset, totalSize);

        if (putRes.status === 308) {
          continue;
        }
        if (putRes.ok) {
          uploadedMeta = await putRes.json().catch(() => ({}));
          break;
        }
        const errJson = await putRes.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || `分片上传失败 (HTTP ${putRes.status})`);
      }
    } finally {
      await fh.close();
    }

    if (!uploadedMeta || !uploadedMeta.id) {
      throw new Error('上传完成但未返回 Drive 文件元信息');
    }
    return uploadedMeta;
  }

  /**
   * 将单个本地曲目上传到 Google Drive（保留单P/多P子目录结构）。
   */
  async function uploadTrack(track, { onChunk } = {}) {
    if (!track || !track.filePath || !track.fileExists) {
      throw new Error('本地音频文件不存在，无法上传');
    }

    const stat = await fsp.stat(track.filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('本地音频文件无效或为空文件');
    }

    const rootFolderId = await resolveTargetFolderId({ createIfMissing: true });
    if (!rootFolderId) {
      throw new Error('无法定位或创建 Google Drive 目标目录');
    }

    const relNorm = String(track.relativePath || path.basename(track.filePath))
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    const segments = relNorm.split('/').filter(Boolean);
    const fileName = segments.pop() || path.basename(track.filePath);
    const parentId = await ensureFolderHierarchy(rootFolderId, segments);
    const mimeType = getAudioContentType(fileName);

    const existingList = await driveListQuery(
      `name = '${escapeDriveQuery(fileName)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`
    );
    const existing = existingList.find((item) => item.mimeType !== DRIVE_FOLDER_MIME);

    if (existing && Number(existing.size) === stat.size) {
      onChunk?.(stat.size, stat.size, stat.size);
      const mtimeMs = existing.modifiedTime ? Date.parse(existing.modifiedTime) || Date.now() : Date.now();
      return {
        ok: true,
        skippedExisting: true,
        gdriveFileId: existing.id,
        gdriveRelativePath: segments.length > 0 ? `${segments.join('/')}/${fileName}` : fileName,
        gdriveSize: Number(existing.size) || stat.size,
        gdriveModifiedTime: mtimeMs,
        folderId: rootFolderId,
      };
    }

    const meta = await uploadFileResumable({
      localPath: track.filePath,
      totalSize: stat.size,
      mimeType,
      fileName,
      parentId,
      existingFileId: existing?.id || null,
      onChunk,
    });

    const mtimeMs = meta.modifiedTime ? Date.parse(meta.modifiedTime) || Date.now() : Date.now();
    return {
      ok: true,
      skippedExisting: false,
      gdriveFileId: meta.id,
      gdriveRelativePath: segments.length > 0 ? `${segments.join('/')}/${fileName}` : fileName,
      gdriveSize: Number(meta.size) || stat.size,
      gdriveModifiedTime: mtimeMs,
      folderId: rootFolderId,
    };
  }

  function getUploadProgress() {
    return { ...uploadProgress };
  }

  function setUploadProgress(patch) {
    uploadProgress = { ...uploadProgress, ...patch };
  }

  return {
    getBriefStatus,
    getPublicStatus,
    updateConfig,
    startAuth,
    handleOAuthCallback,
    disconnect,
    scanFolder,
    streamAudio,
    uploadTrack,
    getUploadProgress,
    setUploadProgress,
    clearCache,
  };
}
