import test from 'node:test';
import assert from 'node:assert/strict';

import { WORK_MODE, DOWNLOAD_STATUS, ACTION, MODE_UI_META } from '../src/common/constants.js';
import { evaluateDownloadCandidate } from '../src/background/preflight.js';
import { createDownloader } from '../src/background/downloader.js';

function createMiniMockIdb() {
  const dbs = new Map();
  const makeReq = (fn) => {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try { fn(req); } catch (e) { req.error = e; req.onerror?.({ target: req }); }
    });
    return req;
  };
  return {
    open(name, version) {
      return makeReq((req) => {
        let state = dbs.get(name);
        const upgrade = !state || state.version < version;
        if (!state) { state = { version, stores: new Map() }; dbs.set(name, state); }
        const db = {
          objectStoreNames: { contains: (s) => state.stores.has(s) },
          createObjectStore(sName, opts = {}) {
            const def = { keyPath: opts.keyPath, autoIncrement: Boolean(opts.autoIncrement), seq: 0, rows: new Map(), indexes: new Map() };
            state.stores.set(sName, def);
            return { createIndex(iName, k) { def.indexes.set(iName, { keyPath: k }); } };
          },
          transaction() {
            const tx = { oncomplete: null, onerror: null, onabort: null };
            let pending = 0;
            const done = () => queueMicrotask(() => { if (pending === 0) tx.oncomplete?.({ target: tx }); });
            tx.objectStore = (sName) => {
              const s = state.stores.get(sName);
              const op = (fn) => {
                pending++;
                return makeReq((r) => {
                  try { r.result = fn(); r.onsuccess?.({ target: r }); } finally { pending--; done(); }
                });
              };
              return {
                get: (k) => op(() => (s.rows.has(k) ? structuredClone(s.rows.get(k)) : undefined)),
                getAll: () => op(() => Array.from(s.rows.values()).map((v) => structuredClone(v))),
                put: (v) => op(() => { const c = structuredClone(v); s.rows.set(c[s.keyPath], c); return c[s.keyPath]; }),
                add: (v) => op(() => {
                  const c = structuredClone(v);
                  if (s.autoIncrement && c[s.keyPath] === undefined) { s.seq += 1; c[s.keyPath] = s.seq; }
                  s.rows.set(c[s.keyPath], c);
                  return c[s.keyPath];
                }),
                delete: (k) => op(() => { s.rows.delete(k); }),
                clear: () => op(() => { s.rows.clear(); }),
                index(iName) {
                  const idx = s.indexes.get(iName);
                  return {
                    get: (val) => op(() => {
                      for (const row of s.rows.values()) if (row[idx.keyPath] === val) return structuredClone(row);
                      return undefined;
                    }),
                    getAll: () => op(() => Array.from(s.rows.values()).map((v) => structuredClone(v))),
                  };
                },
              };
            };
            queueMicrotask(() => { if (pending === 0) tx.oncomplete?.({ target: tx }); });
            return tx;
          },
          close() {},
        };
        if (upgrade) { req.result = db; req.onupgradeneeded?.({ target: req }); }
        req.result = db;
        req.onsuccess?.({ target: req });
      });
    },
  };
}

function createStorageArea() {
  const store = new Map();
  return {
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: store.has(keys) ? structuredClone(store.get(keys)) : undefined };
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
        out[k] = store.has(k) ? structuredClone(store.get(k)) : undefined;
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
  };
}

// ============================================================================
// 1. preflight.js：去重、失活重下、高音质升级、durl 拦截
// ============================================================================
test('preflight: handles new track, live skip, missing file recovery, quality upgrade & durl guard', async () => {
  const baseTab = {
    trackKey: 'BV1pf_101',
    meta: { bvid: 'BV1pf', cid: '101', title: 'Test' },
    bestAudio: { id: 30251, codecs: 'flac', baseUrl: 'https://cdn/flac' },
    hasDurl: false,
    downloadStatus: DOWNLOAD_STATUS.IDLE,
  };

  // 新歌
  const dNew = await evaluateDownloadCandidate(
    { tabState: baseTab, settings: { enableQualityUpgrade: true } },
    { getTrack: async () => null }
  );
  assert.equal(dNew.shouldDownload, true);
  assert.equal(dNew.reason, 'NEW_TRACK');

  // 旧歌同音质且本地存在 -> 跳过
  const dSkip = await evaluateDownloadCandidate(
    { tabState: { ...baseTab, bestAudio: { id: 30280, codecs: 'mp4a.40.2', baseUrl: 'https://cdn/30280' } }, settings: { enableQualityUpgrade: true } },
    {
      getTrack: async () => ({ trackKey: 'BV1pf_101', downloadId: 55, qualityId: 30280, filename: 'D:\\a.m4a' }),
      searchDownloads: async () => [{ id: 55, state: 'complete', exists: true }],
    }
  );
  assert.equal(dSkip.shouldDownload, false);
  assert.equal(dSkip.reason, 'ALREADY_EXISTS');
  assert.equal(dSkip.status, DOWNLOAD_STATUS.SKIPPED);

  // 本地被删 -> 清理关联并允许重下
  let cleared = null;
  const dMissing = await evaluateDownloadCandidate(
    { tabState: baseTab, settings: { enableQualityUpgrade: false } },
    {
      getTrack: async () => ({ trackKey: 'BV1pf_101', downloadId: 55, qualityId: 30280 }),
      searchDownloads: async () => [{ id: 55, state: 'complete', exists: false }],
      clearTrackDownload: async (k) => { cleared = k; },
    }
  );
  assert.equal(cleared, 'BV1pf_101');
  assert.equal(dMissing.shouldDownload, true);
  assert.equal(dMissing.reason, 'MISSING_LOCAL_FILE');

  // 音质升级（30232 -> 30251）：关闭自动升级时不升，手动 forceManual=true 时强制升
  const dNoUp = await evaluateDownloadCandidate(
    { tabState: baseTab, settings: { enableQualityUpgrade: false }, forceManual: false },
    {
      getTrack: async () => ({ trackKey: 'BV1pf_101', downloadId: 77, qualityId: 30232 }),
      searchDownloads: async () => [{ id: 77, state: 'complete', exists: true }],
    }
  );
  assert.equal(dNoUp.shouldDownload, false);

  const dUp = await evaluateDownloadCandidate(
    { tabState: baseTab, settings: { enableQualityUpgrade: false }, forceManual: true },
    {
      getTrack: async () => ({ trackKey: 'BV1pf_101', downloadId: 77, qualityId: 30232 }),
      searchDownloads: async () => [{ id: 77, state: 'complete', exists: true }],
    }
  );
  assert.equal(dUp.shouldDownload, true);
  assert.equal(dUp.reason, 'QUALITY_UPGRADE');
  assert.equal(dUp.isUpgrade, true);
  assert.equal(dUp.oldDownloadId, 77);

  // durl 无 DASH 音轨
  const dDurl = await evaluateDownloadCandidate({
    tabState: { ...baseTab, bestAudio: null, hasDurl: true },
    settings: {},
  });
  assert.equal(dDurl.shouldDownload, false);
  assert.equal(dDurl.status, DOWNLOAD_STATUS.UNSUPPORTED_DURL);
});

// ============================================================================
// 2. downloader.js：Blob 落盘、高音质升级清理旧档、异常路径降级重下与 Blob 释放
// ============================================================================
test('downloader: upgrades file cleanly, removes old download, revokes Blob URL & falls back on FILE error', async () => {
  const sessionStorage = createStorageArea();
  const sentMessages = [];
  const statusUpdates = [];
  const removedIds = [];
  const erasedIds = [];
  const downloadCalls = [];
  const records = new Map();

  let seqId = 100;
  let failPrimaryFilenameOnce = false;
  let simulateInterruptFirstAttempt = false;

  const downloadsApi = {
    async download(opts) {
      downloadCalls.push(opts);
      if (failPrimaryFilenameOnce && opts.filename.includes('/')) {
        failPrimaryFilenameOnce = false;
        throw new Error('Invalid filename path');
      }
      seqId += 1;
      const id = seqId;
      if (simulateInterruptFirstAttempt) {
        simulateInterruptFirstAttempt = false;
        records.set(id, { id, state: 'interrupted', error: 'FILE_ACCESS_DENIED', filename: opts.filename });
      } else {
        records.set(id, { id, state: 'complete', exists: true, filename: `D:\\Downloads\\${opts.filename}` });
      }
      return id;
    },
    async search({ id }) {
      return records.has(id) ? [records.get(id)] : [];
    },
    async removeFile(id) { removedIds.push(id); },
    async erase({ id }) { erasedIds.push(id); },
  };

  let markedArgs = null;
  const dl = createDownloader({
    sessionStorage,
    downloadsApi,
    sendToTab: async (tabId, action, payload) => {
      sentMessages.push({ tabId, action, payload });
      return { ok: true, accepted: true };
    },
    upsertTrackMeta: async (m) => m,
    markTrackDownloaded: async (k, info) => {
      markedArgs = { k, info };
      return { trackKey: k, playCount: 2, totalPlayedSeconds: 45, ...info };
    },
    onStatusUpdate: async (tabId, trackKey, patch) => {
      statusUpdates.push({ tabId, trackKey, patch });
    },
  });

  // Case A: 升级下载流程（主文件名抛错时自动降级 fallbackFilename 并删除 oldDownloadId=88）
  failPrimaryFilenameOnce = true;
  const reqRes = await dl.requestDashFetch({
    tabId: 10,
    tabState: {
      trackKey: 'BV1dl_201',
      meta: { bvid: 'BV1dl', cid: '201', title: '曲目标题', owner: '歌手', p: 1, totalParts: 1 },
    },
    decision: {
      isUpgrade: true,
      oldDownloadId: 88,
      bestAudio: { id: 30251, codecs: 'flac', baseUrl: 'https://cdn/hi' },
    },
    settings: { archiveSubfolder: 'BiliMusic', groupMultiPartInSubdir: true },
  });
  assert.equal(reqRes.ok, true);
  assert.equal(await dl.hasPendingForTrack('BV1dl_201'), true);

  const fetchMsg = sentMessages.find((m) => m.action === ACTION.FETCH_DASH_BLOB);
  assert.ok(fetchMsg);

  const readyRes = await dl.handleDashBlobReady(
    { taskId: fetchMsg.payload.taskId, blobUrl: 'blob:https://www.bilibili.com/hi-res-1' },
    { tab: { id: 10 } }
  );
  assert.equal(readyRes.ok, true);
  assert.equal(downloadCalls.length, 2, 'Should retry with fallbackFilename after primary filename exception');
  assert.match(downloadCalls[1].filename, /BV1dl_201_30251\.m4a$/);
  assert.deepEqual(removedIds, [88]);
  assert.deepEqual(erasedIds, [88]);
  assert.equal(markedArgs.info.qualityId, 30251);
  assert.equal(statusUpdates.at(-1).patch.downloadStatus, DOWNLOAD_STATUS.UPGRADED);
  assert.ok(
    sentMessages.some((m) => m.action === ACTION.REVOKE_BLOB_URL && m.payload.blobUrl === 'blob:https://www.bilibili.com/hi-res-1'),
    'Must revoke Blob URL after complete'
  );

  // Case B: chrome.downloads 返回 state=interrupted (FILE_ACCESS_DENIED) 后自动使用 fallbackFilename 原地重试成功
  simulateInterruptFirstAttempt = true;
  const reqRes2 = await dl.requestDashFetch({
    tabId: 10,
    tabState: {
      trackKey: 'BV1dl_202',
      meta: { bvid: 'BV1dl', cid: '202', title: '曲目二', owner: '歌手B', p: 1, totalParts: 1 },
    },
    decision: {
      isUpgrade: false,
      oldDownloadId: null,
      bestAudio: { id: 30280, codecs: 'mp4a.40.2', baseUrl: 'https://cdn/30280' },
    },
    settings: { archiveSubfolder: 'BiliMusic', groupMultiPartInSubdir: true },
  });
  assert.equal(reqRes2.ok, true);
  const fetchMsg2 = sentMessages.filter((m) => m.action === ACTION.FETCH_DASH_BLOB).at(-1);
  await dl.handleDashBlobReady(
    { taskId: fetchMsg2.payload.taskId, blobUrl: 'blob:https://www.bilibili.com/retry-blob' },
    { tab: { id: 10 } }
  );
  assert.equal(statusUpdates.at(-1).patch.downloadStatus, DOWNLOAD_STATUS.COMPLETED);
  assert.ok(
    sentMessages.some((m) => m.action === ACTION.REVOKE_BLOB_URL && m.payload.blobUrl === 'blob:https://www.bilibili.com/retry-blob')
  );
});

// ============================================================================
// 3. service-worker.js 完整端到端联动：阈值自动下载、纯统计手工下载、三态图标切换
// ============================================================================
test('service-worker: end-to-end auto capture at threshold, manual capture in STATS_ONLY & 3-state icon sync', async () => {
  globalThis.indexedDB = createMiniMockIdb();
  const sessionStorage = createStorageArea();
  const localStorage = createStorageArea();

  const iconCalls = [];
  const badgeCalls = [];
  const tabMessages = [];
  const downloadRecords = new Map();
  let nextDlId = 500;

  globalThis.chrome = {
    storage: { session: sessionStorage, local: localStorage },
    action: {
      setIcon: async (v) => iconCalls.push(v),
      setBadgeText: async (v) => badgeCalls.push(v),
      setBadgeBackgroundColor: async (v) => badgeCalls.push(v),
    },
    downloads: {
      onChanged: { addListener: () => {} },
      async download(opts) {
        nextDlId += 1;
        const id = nextDlId;
        downloadRecords.set(id, { id, state: 'complete', exists: true, filename: `D:\\Downloads\\${opts.filename}` });
        return id;
      },
      async search({ id }) {
        return downloadRecords.has(id) ? [downloadRecords.get(id)] : [];
      },
      async removeFile() {},
      async erase() {},
    },
    tabs: {
      query: async () => [{ id: 88 }],
      onRemoved: { addListener: () => {} },
      sendMessage: async (tabId, env) => {
        tabMessages.push({ tabId, env });
        return { ok: true, accepted: true };
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: async () => ({}),
    },
  };

  const sw = await import('../src/background/service-worker.js');
  const { getTrack } = await import('../src/common/db.js');

  // 1) 三态切换校验 iconPaths 与角标
  await sw.handleSetWorkMode({ mode: WORK_MODE.STATS_ONLY });
  assert.deepEqual(iconCalls.at(-1).path, MODE_UI_META[WORK_MODE.STATS_ONLY].iconPaths);
  assert.equal(badgeCalls.at(-2).text, 'STAT');

  await sw.handleSetWorkMode({ mode: WORK_MODE.AUTO_CAPTURE });
  assert.deepEqual(iconCalls.at(-1).path, MODE_UI_META[WORK_MODE.AUTO_CAPTURE].iconPaths);

  // 2) 上报曲目并累积心跳突破 15s -> AUTO_CAPTURE 自动发 FETCH_DASH_BLOB
  const metaA = { bvid: 'BV1swP3A', cid: '9001', p: 1, totalParts: 1, title: 'Auto Song', owner: 'Singer A' };
  const sessA = 'BV1swP3A_9001_s1';
  const sender = { tab: { id: 88 } };

  await sw.handleTrackDetected({
    meta: metaA,
    sessionId: sessA,
    matched: true,
    source: '__playinfo__',
    audios: [{ id: 30280, codecs: 'mp4a.40.2', bandwidth: 192000, baseUrl: 'https://cdn/auto' }],
  }, sender);

  const hbRes = await sw.handlePlayHeartbeat({ meta: metaA, sessionId: sessA, deltaSeconds: 16 }, sender);
  assert.equal(hbRes.reachedThresholdNow, true);
  assert.equal(hbRes.tabState.downloadStatus, DOWNLOAD_STATUS.DOWNLOADING);

  const fetchCmdA = tabMessages.find((m) => m.env.action === ACTION.FETCH_DASH_BLOB && m.env.payload.trackKey === 'BV1swP3A_9001');
  assert.ok(fetchCmdA, 'AUTO_CAPTURE reaching threshold must send FETCH_DASH_BLOB to active tab');

  // 页面回传 DASH_BLOB_READY -> 自动完结并释放 Blob URL
  const readyRes = await sw.downloader.handleDashBlobReady(
    { taskId: fetchCmdA.env.payload.taskId, blobUrl: 'blob:https://www.bilibili.com/auto-done' },
    sender
  );
  assert.equal(readyRes.ok, true);

  const savedA = await getTrack('BV1swP3A_9001');
  assert.ok(savedA.downloadId);
  assert.equal(savedA.qualityId, 30280);
  assert.ok(
    tabMessages.some((m) => m.env.action === ACTION.REVOKE_BLOB_URL && m.env.payload.blobUrl === 'blob:https://www.bilibili.com/auto-done')
  );

  // 3) STATS_ONLY 下听满阈值仅统计不下载，点击手动立即下载可触发
  await sw.handleSetWorkMode({ mode: WORK_MODE.STATS_ONLY });
  const metaB = { bvid: 'BV1swP3B', cid: '9002', p: 1, totalParts: 1, title: 'Manual Song', owner: 'Singer B' };
  const sessB = 'BV1swP3B_9002_s1';

  await sw.handleTrackDetected({
    meta: metaB,
    sessionId: sessB,
    matched: true,
    source: '__playinfo__',
    audios: [{ id: 30251, codecs: 'flac', bandwidth: 1100000, baseUrl: 'https://cdn/manual-flac' }],
  }, sender);

  const hbStatsOnly = await sw.handlePlayHeartbeat({ meta: metaB, sessionId: sessB, deltaSeconds: 20 }, sender);
  assert.equal(hbStatsOnly.reachedThresholdNow, true);
  assert.equal(hbStatsOnly.tabState.downloadStatus, DOWNLOAD_STATUS.IDLE);
  assert.equal(
    tabMessages.some((m) => m.env.action === ACTION.FETCH_DASH_BLOB && m.env.payload.trackKey === 'BV1swP3B_9002'),
    false,
    'STATS_ONLY must not trigger automatic download'
  );

  const manualRes = await sw.handleManualDownload({ tabId: 88 });
  assert.equal(manualRes.ok, true);
  const fetchCmdB = tabMessages.find((m) => m.env.action === ACTION.FETCH_DASH_BLOB && m.env.payload.trackKey === 'BV1swP3B_9002');
  assert.ok(fetchCmdB, 'Manual download must dispatch FETCH_DASH_BLOB even in STATS_ONLY mode');

  await sw.downloader.handleDashBlobReady(
    { taskId: fetchCmdB.env.payload.taskId, blobUrl: 'blob:https://www.bilibili.com/manual-done' },
    sender
  );
  const popupState = await sw.handleGetPopupState({ tabId: 88 });
  assert.equal(popupState.tabState.downloadStatus, DOWNLOAD_STATUS.COMPLETED);
  assert.equal(popupState.dbTrack.qualityId, 30251);
});
