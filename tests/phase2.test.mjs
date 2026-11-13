import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
// 1. probe-main.js 沙箱测试（SSR 绑定、防串曲、SPA 切 P、backupUrl 容灾与 Blob 释放）
// ============================================================================
test('probe-main.js: isolates preload playurl requests, handles SPA p-switch and backupUrl failover', async () => {
  const code = fs.readFileSync(new URL('../src/content/probe-main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /(?:^|\n)\s*(import|export)\s/m, 'Content script must not contain ESM import/export statements');

  const posted = [];
  const listeners = new Map();
  const revokedUrls = [];
  let blobCounter = 0;

  const xhrInstances = [];
  class FakeXHR {
    open(method, url) { this._url = url; this._listeners = []; }
    addEventListener(evt, fn) { if (evt === 'load') this._listeners.push(fn); }
    send() { xhrInstances.push(this); }
    emitLoad(jsonObj) {
      this.responseType = 'text';
      this.responseText = typeof jsonObj === 'string' ? jsonObj : JSON.stringify(jsonObj);
      this._listeners.forEach((fn) => fn.call(this));
    }
  }

  const fakeFetchCalls = [];
  const baseFetch = async (url) => {
    fakeFetchCalls.push(url);
    if (String(url).includes('/x/player/wbi/playurl')) {
      return {
        ok: true,
        clone() {
          return {
            json: async () => ({
              data: {
                dash: {
                  audio: [{ id: 30232, codecs: 'mp4a.40.2', bandwidth: 120000, baseUrl: 'https://cdn/p2-132' }],
                },
              },
            }),
          };
        },
      };
    }
    if (String(url).includes('primary-bad')) {
      return { ok: false, status: 502 };
    }
    if (String(url).includes('backup-good')) {
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' }),
      };
    }
    return { ok: false, status: 404 };
  };

  const sandboxWindow = {
    location: { origin: 'https://www.bilibili.com', pathname: '/video/BV1main/', search: '?p=1', href: 'https://www.bilibili.com/video/BV1main/?p=1' },
    document: { title: 'Test Song_哔哩哔哩_bilibili' },
    history: {
      pushState(_s, _t, url) {
        const u = new URL(url, 'https://www.bilibili.com');
        sandboxWindow.location.pathname = u.pathname;
        sandboxWindow.location.search = u.search;
        sandboxWindow.location.href = u.href;
      },
      replaceState() {},
    },
    __INITIAL_STATE__: {
      bvid: 'BV1main',
      p: 1,
      videoData: {
        bvid: 'BV1main',
        cid: 1001,
        title: 'Test Album',
        owner: { name: 'Tester' },
        pic: '//i0.hdslb.com/bfs/archive/cover.jpg',
        pages: [
          { cid: 1001, page: 1, part: 'Track One', duration: 200 },
          { cid: 1002, page: 2, part: 'Track Two', duration: 180 },
        ],
      },
    },
    __playinfo__: {
      data: {
        dash: {
          flac: { audio: { id: 30251, codecs: 'fLaC', bandwidth: 1400000, baseUrl: 'https://primary-bad/p1', backupUrl: ['https://backup-good/p1'] } },
          audio: [{ id: 30280, codecs: 'mp4a.40.2', bandwidth: 240000, baseUrl: 'https://cdn/p1-192' }],
        },
      },
    },
    fetch: baseFetch,
    XMLHttpRequest: FakeXHR,
    URL,
    Blob,
    postMessage(msg) { posted.push(msg); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  sandboxWindow.window = sandboxWindow;

  const origCreateObj = URL.createObjectURL;
  const origRevokeObj = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => `blob:https://www.bilibili.com/mock-${++blobCounter}-${blob.type}`;
  URL.revokeObjectURL = (u) => revokedUrls.push(u);

  try {
    vm.runInNewContext(code, {
      ...sandboxWindow,
      URLSearchParams,
      Map,
      Set,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Date,
      JSON,
      Promise,
    });

    // 触发 DOMContentLoaded 使首屏 __playinfo__ 立即绑定至 P1 (cid=1001)
    listeners.get('DOMContentLoaded')?.forEach((fn) => fn());
    const initMsg = posted.find((m) => m.type === 'TRACK_SNAPSHOT');
    assert.ok(initMsg, 'Should emit initial TRACK_SNAPSHOT');
    assert.equal(initMsg.payload.meta.cid, '1001');
    assert.equal(initMsg.payload.meta.cover, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
    assert.equal(initMsg.payload.matched, true);
    assert.equal(initMsg.payload.audios[0].id, 30251);

    // 模拟 B 站后台发起 2 个无关推荐视频的 playurl XHR（含一个损坏 JSON）
    const countBefore = posted.length;
    const xhr1 = new sandboxWindow.XMLHttpRequest();
    xhr1.open('GET', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1other1&cid=9991');
    xhr1.send();
    xhr1.emitLoad({ data: { dash: { audio: [{ id: 30216, baseUrl: 'https://cdn/other1' }] } } });

    const xhrBad = new sandboxWindow.XMLHttpRequest();
    xhrBad.open('GET', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1other2&cid=9992');
    xhrBad.send();
    xhrBad.emitLoad('NOT_VALID_JSON');

    assert.equal(posted.length, countBefore, 'Preload XHR for unrelated cid must NOT emit or overwrite current track');

    // 通过 history.pushState 切到 P2，再触发 P2 的 playurl fetch
    sandboxWindow.history.pushState({}, '', '/video/BV1main/?p=2');
    await sandboxWindow.fetch('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1main&cid=1002');
    await new Promise((r) => setTimeout(r, 20));
    const p2Snap = posted.filter((m) => m.type === 'TRACK_SNAPSHOT' && m.payload.meta.cid === '1002' && m.payload.matched).pop();
    assert.ok(p2Snap, 'Should switch cleanly to P2 cid=1002 and match its own playurl');
    assert.equal(p2Snap.payload.audios[0].baseUrl, 'https://cdn/p2-132');

    // 测试页面侧 FETCH_DASH_BLOB（baseUrl 502 自动切 backupUrl，且 MIME 改为 audio/x-m4a）与 REVOKE_BLOB_URL
    const msgListeners = listeners.get('message') || [];
    for (const fn of msgListeners) {
      await fn({
        source: sandboxWindow,
        data: {
          'bm-content': 'bridge',
          type: 'FETCH_DASH_BLOB',
          reqId: 'req-dl',
          payload: { urls: ['https://primary-bad/p1', 'https://backup-good/p1'], mimeType: 'audio/x-m4a' },
        },
      });
    }
    const dlRes = posted.find((m) => m.reqId === 'req-dl');
    assert.equal(dlRes.payload.ok, true);
    assert.equal(dlRes.payload.mime, 'audio/x-m4a');
    assert.equal(dlRes.payload.usedUrl, 'https://backup-good/p1');

    for (const fn of msgListeners) {
      await fn({
        source: sandboxWindow,
        data: {
          'bm-content': 'bridge',
          type: 'REVOKE_BLOB_URL',
          reqId: 'req-rev',
          payload: { blobUrl: dlRes.payload.blobUrl },
        },
      });
    }
    const revRes = posted.find((m) => m.reqId === 'req-rev');
    assert.equal(revRes.payload.revoked, true);
    assert.ok(revokedUrls.includes(dlRes.payload.blobUrl));
  } finally {
    URL.createObjectURL = origCreateObj;
    URL.revokeObjectURL = origRevokeObj;
  }
});

// ============================================================================
// 2. service-worker.js 听歌统计 MVP & 并发锁测试
// ============================================================================
test('service-worker.js: concurrent heartbeats count playCount once and update leaderboard', async () => {
  globalThis.indexedDB = createMiniMockIdb();
  const sessionStorage = createStorageArea();
  const localStorage = createStorageArea();
  await localStorage.set({ settings: { enablePlayerSync: false } });
  const badgeUpdates = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`Network disabled in unit test: ${url}`);
  };

  try {
    globalThis.chrome = {
      storage: { session: sessionStorage, local: localStorage },
      action: {
        setBadgeText: async (v) => badgeUpdates.push(v),
        setBadgeBackgroundColor: async (v) => badgeUpdates.push(v),
      },
      tabs: {
        query: async () => [{ id: 42 }],
        onRemoved: { addListener: () => {} },
      },
      runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
    };

    const sw = await import('../src/background/service-worker.js');
    const { getLeaderboard } = await import('../src/common/db.js');

    const meta = { bvid: 'BV1swTest', cid: '777', p: 1, totalParts: 1, title: 'SW Track', owner: 'Singer' };
    const sender = { tab: { id: 42 } };
    const sessionId = 'BV1swTest_777_sess1';

    // 上报检测
    const det = await sw.handleTrackDetected({
      meta,
      sessionId,
      matched: true,
      source: '__playinfo__',
      audios: [{ id: 30280, codecs: 'mp4a.40.2', bandwidth: 240000, baseUrl: 'https://cdn/a' }],
    }, sender);
    assert.equal(det.ok, true);
    assert.equal(det.tabState.qualityInfo.id, 30280);

    // 并发发送多次心跳跨越 15 秒阈值，验证 withTabQueue 防止 playCount 被计成 >1
    const [r1, r2, r3] = await Promise.all([
      sw.handlePlayHeartbeat({ meta, sessionId, deltaSeconds: 6 }, sender),
      sw.handlePlayHeartbeat({ meta, sessionId, deltaSeconds: 6 }, sender),
      sw.handlePlayHeartbeat({ meta, sessionId, deltaSeconds: 6 }, sender),
    ]);
    const thresholdTriggers = [r1, r2, r3].filter((r) => r.reachedThresholdNow);
    assert.equal(thresholdTriggers.length, 1, 'Threshold should trigger exactly once under concurrent heartbeats');
    assert.equal(r3.tabState.trackStats.playCount, 1);
    assert.equal(r3.tabState.trackStats.totalPlayedSeconds, 18);

    // 切换为暂停模式后心跳应被忽略
    const modeRes = await sw.handleSetWorkMode({ mode: 'PAUSED' });
    assert.equal(modeRes.settings.mode, 'PAUSED');
    assert.ok(badgeUpdates.some((b) => b.text === 'OFF'));

    const pausedHb = await sw.handlePlayHeartbeat({ meta, sessionId, deltaSeconds: 10 }, sender);
    assert.equal(pausedHb.ignored, 'paused');

    // Popup 恢复状态 & 排行榜校验
    const popupState = await sw.handleGetPopupState({});
    assert.equal(popupState.tabId, 42);
    assert.equal(popupState.tabState.trackStats.totalPlayedSeconds, 18);

    const board = await getLeaderboard();
    assert.equal(board.items[0].bvid, 'BV1swTest');
    assert.equal(board.items[0].playCount, 1);

    // 清空统计
    await sw.handleClearStats();
    const afterClear = await sw.handleGetPopupState({ tabId: 42 });
    assert.equal(afterClear.tabState.trackStats.playCount, 0);
  } finally {
    await new Promise((r) => setTimeout(r, 20));
    globalThis.fetch = prevFetch;
  }
});

// ============================================================================
// 3. bridge-isolated.js 沙箱测试（切歌刷盘 + Extension context invalidated 自停）
// ============================================================================
test('bridge-isolated.js: flushes previous track on switch and tears down on invalidated context', async () => {
  const code = fs.readFileSync(new URL('../src/content/bridge-isolated.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /(?:^|\n)\s*(import|export)\s/m, 'Bridge script must not contain ESM import/export statements');

  const sentToBg = [];
  const winListeners = new Map();
  let intervalCleared = false;
  let tickCallback = null;
  let fakeTime = 10000;
  const origDateNow = Date.now;
  Date.now = () => fakeTime;

  let shouldInvalidate = false;
  const fakeChrome = {
    runtime: {
      id: 'ext-1',
      onMessage: { addListener: () => {} },
      sendMessage: async (env) => {
        if (shouldInvalidate) throw new Error('Extension context invalidated.');
        sentToBg.push(env);
        return { ok: true };
      },
    },
  };

  const videoMock = { isConnected: true, paused: false, ended: false, readyState: 4, tagName: 'VIDEO' };
  const fakeTimers = new Set();
  const sandbox = {
    chrome: fakeChrome,
    location: { origin: 'https://www.bilibili.com' },
    document: {
      querySelector: () => videoMock,
      addEventListener: () => {},
    },
    window: null,
    postMessage: () => {},
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    setInterval(fn) { tickCallback = fn; return 999; },
    clearInterval(id) { if (id === 999) intervalCleared = true; },
    setTimeout(fn, ms) {
      if (ms >= 5000) {
        const id = Math.random();
        fakeTimers.add(id);
        return id;
      }
      return setTimeout(fn, ms);
    },
    clearTimeout(id) {
      fakeTimers.delete(id);
      clearTimeout(id);
    },
    Date,
    Math,
    Map,
    Promise,
    Error,
    Number,
    String,
    Boolean,
  };
  sandbox.window = sandbox;

  try {
    vm.runInNewContext(code, { ...sandbox });
    const msgListeners = winListeners.get('message') || [];

    // 推送曲目 A
    for (const fn of msgListeners) {
      fn({
        source: sandbox,
        data: { 'bm-content': 'main', type: 'TRACK_SNAPSHOT', payload: { meta: { bvid: 'BV1', cid: '1' }, audios: [] } },
      });
    }
    // 模拟播放 3 秒（每秒 tick 一次，未满 5 秒不提前发包，但切换时强制 flush）
    for (let i = 0; i < 3; i++) {
      fakeTime += 1000;
      tickCallback();
    }

    // 切换到曲目 B -> 应先 flush A 的 3 秒心跳，再发 TRACK_DETECTED B
    for (const fn of msgListeners) {
      fn({
        source: sandbox,
        data: { 'bm-content': 'main', type: 'TRACK_SNAPSHOT', payload: { meta: { bvid: 'BV2', cid: '2' }, audios: [] } },
      });
    }
    const hbA = sentToBg.find((m) => m.action === 'PLAY_HEARTBEAT' && m.payload.meta.bvid === 'BV1');
    assert.ok(hbA, 'Switching to track B must flush accumulated time for track A');
    assert.equal(hbA.payload.deltaSeconds, 3);

    // 模拟扩展重载导致 Extension context invalidated -> 必须清理心跳定时器自停
    shouldInvalidate = true;
    for (let i = 0; i < 6; i++) {
      fakeTime += 1000;
      tickCallback();
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(intervalCleared, true, 'Must clear interval timer after Extension context invalidated');
  } finally {
    Date.now = origDateNow;
  }
});
