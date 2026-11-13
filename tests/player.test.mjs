import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

import { parseArchiveFilenameMeta, scanMusicDirectories, extractArchiveRootFromFilename } from '../player/lib/scanner.mjs';
import { createPlayerStore } from '../player/lib/store.mjs';
import { createPlayerServer } from '../player/server.mjs';
import { parseDriveFolderId } from '../player/lib/gdrive.mjs';
import { createPlayerSyncClient } from '../src/background/player-sync.js';
import {
  upsertTrackMeta,
  recordPlayProgress,
  getTrack,
  getAllTracks,
  mergeTracksFromPlayer,
  makeTrackKey,
} from '../src/common/db.js';

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
                delete: (k) => op(() => { s.rows.delete(keyOrVal(k)); }),
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
  function keyOrVal(k) { return k; }
}

// ============================================================================
// 1. scanner.mjs：文件名反解析与递归扫描
// ============================================================================
test('player/scanner: parses single-P, multi-P, fallback filenames and scans directories recursively', async () => {
  const single = parseArchiveFilenameMeta('一支yuuu - 南下の小曲.m4a');
  assert.equal(single.owner, '一支yuuu');
  assert.equal(single.title, '南下の小曲');
  assert.equal(single.p, 1);

  const multi = parseArchiveFilenameMeta('歌手A - 合集标题/P03 - 第三首歌.m4a');
  assert.equal(multi.owner, '歌手A');
  assert.equal(multi.title, '合集标题');
  assert.equal(multi.p, 3);
  assert.equal(multi.part, '第三首歌');

  const fallback = parseArchiveFilenameMeta('BV11jnm6bEM6_42953738891_30251.m4a');
  assert.equal(fallback.bvid, 'BV11jnm6bEM6');
  assert.equal(fallback.cid, '42953738891');
  assert.equal(fallback.qualityId, 30251);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-scan-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'UP1 - Song One.m4a'), Buffer.from('fake-m4a'));
    await fs.mkdir(path.join(tmpDir, 'UP2 - Album'), { recursive: true });
    const multiPartFile = path.join(tmpDir, 'UP2 - Album', 'P01 - Intro.m4a');
    await fs.writeFile(multiPartFile, Buffer.from('fake-p1'));
    await fs.writeFile(path.join(tmpDir, 'ignore.txt'), 'not audio');

    assert.equal(extractArchiveRootFromFilename(path.join(tmpDir, 'UP1 - Song One.m4a')), path.resolve(tmpDir));
    assert.equal(extractArchiveRootFromFilename(multiPartFile, { totalParts: 2 }), path.resolve(tmpDir));

    const scanned = await scanMusicDirectories([tmpDir]);
    assert.equal(scanned.length, 2);
    assert.ok(scanned.some((x) => x.parsedMeta.title === 'Song One' && x.parsedMeta.owner === 'UP1'));
    assert.ok(scanned.some((x) => x.parsedMeta.title === 'Album' && x.parsedMeta.part === 'Intro' && x.parsedMeta.p === 1));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. store.mjs：歌单 CRUD、收藏、播放器计数与跨端统计合并
// ============================================================================
test('player/store: manages playlists, favorites, heartbeats and merges extension stats cleanly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-store-'));
  try {
    const store = createPlayerStore({
      dataFilePath: path.join(tmpDir, 'library.json'),
      defaultMusicDirs: [tmpDir],
    });
    await store.init();

    // 先扫描一个本地文件
    await store.syncScannedFiles([
      {
        filePath: path.join(tmpDir, '歌手X - 晴天.m4a'),
        relativePath: '歌手X - 晴天.m4a',
        basename: '歌手X - 晴天.m4a',
        fileSize: 1024,
        mtimeMs: 1_700_000_000_000,
        parsedMeta: { owner: '歌手X', title: '晴天', p: 1, part: null },
      },
    ]);

    const snap1 = await store.getSnapshot();
    assert.equal(snap1.tracks.length, 1);
    const localKey = snap1.tracks[0].trackKey;
    assert.ok(localKey.startsWith('local_'));

    // 创建歌单并加入该曲目 + 红心收藏
    const pl = await store.createPlaylist({ name: '深夜循环' });
    await store.addTracksToPlaylist(pl.id, [localKey]);
    await store.toggleFavorite(localKey, true);
    await store.recordPlayerHeartbeat({
      trackKey: localKey,
      sessionId: 'pl_s1',
      deltaSeconds: 20,
      incrementPlayCount: true,
    });

    // 插件端同步同一首歌（带真实 bvid/cid 与网页端 3 次播放），应平滑迁移 local_ 记录与歌单引用
    const mergeRes = await store.mergeExtensionBatch([
      {
        bvid: 'BV1sunny',
        cid: '888',
        title: '晴天 (无损版)',
        owner: '歌手X',
        cover: 'https://i0.hdslb.com/sunny.jpg',
        qualityId: 30251,
        filename: 'D:\\Downloads\\BiliMusic\\歌手X - 晴天.m4a',
        biliPlayCount: 3,
        biliPlayedSeconds: 180,
      },
    ]);

    const canonical = mergeRes.tracks.find((t) => t.trackKey === 'BV1sunny_888');
    assert.ok(canonical);
    assert.equal(canonical.favorite, true, 'Favorite flag must survive migration');
    assert.equal(canonical.biliPlayCount, 3);
    assert.equal(canonical.playerPlayCount, 1);
    assert.equal(canonical.totalPlayCount, 4);
    assert.equal(canonical.totalPlayedSeconds, 200);
    assert.equal(canonical.fileExists, true);

    const snap2 = await store.getSnapshot();
    assert.equal(snap2.tracks.length, 1, 'Migrated local track must not duplicate');
    assert.deepEqual(snap2.playlists[0].trackKeys, ['BV1sunny_888']);

    const board = await store.getLeaderboard({ sortBy: 'totalPlayCount', sourceFilter: 'all' });
    assert.equal(board.summary.totalPlayCount, 4);
    assert.equal(board.items[0].trackKey, 'BV1sunny_888');

    // 重命名与删除歌单
    await store.updatePlaylist(pl.id, { name: '夜间主打' });
    const afterRename = await store.getSnapshot();
    assert.equal(afterRename.playlists[0].name, '夜间主打');
    await store.deletePlaylist(pl.id);
    const afterDel = await store.getSnapshot();
    assert.equal(afterDel.playlists.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. server.mjs：端到端 HTTP 接口、Range 206 流式播放与同步接口
// ============================================================================
test('player/server: serves library, playlists, sync endpoints and HTTP 206 Range audio streams', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-srv-'));
  const musicDir = path.join(tmpDir, 'music');
  await fs.mkdir(musicDir, { recursive: true });
  const audioBytes = Buffer.from('0123456789'.repeat(30)); // 300 bytes
  await fs.writeFile(path.join(musicDir, 'BV1test_101_30251.m4a'), audioBytes);

  const srv = createPlayerServer({
    port: 0,
    dataFilePath: path.join(tmpDir, 'library.json'),
    defaultMusicDirs: [musicDir],
    watchEnabled: false,
  });

  const info = await srv.start();
  try {
    // 1) /api/status
    const st = await fetch(`${info.url}/api/status`).then((r) => r.json());
    assert.equal(st.ok, true);
    assert.equal(st.summary.playableTracks, 1);

    // 2) Range 206 stream
    const rangeRes = await fetch(`${info.url}/api/audio?trackKey=${encodeURIComponent('BV1test_101')}`, {
      headers: { Range: 'bytes=0-99' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), 'bytes 0-99/300');
    const buf = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(buf.length, 100);
    assert.equal(buf.toString(), audioBytes.subarray(0, 100).toString());

    // 3) Player heartbeat
    const hb = await fetch(`${info.url}/api/play-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'BV1test_101', sessionId: 's_srv', deltaSeconds: 18, incrementPlayCount: true }),
    }).then((r) => r.json());
    assert.equal(hb.ok, true);
    assert.equal(hb.track.playerPlayCount, 1);

    // 4) Sync event & full sync from extension
    const evRes = await fetch(`${info.url}/api/sync/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'PLAY_HEARTBEAT',
        payload: {
          track: {
            bvid: 'BV1test',
            cid: '101',
            title: '服务器测试曲',
            owner: 'UP主Z',
            biliPlayCount: 2,
            biliPlayedSeconds: 90,
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(evRes.ok, true);
    assert.equal(evRes.track.totalPlayCount, 3);
    assert.equal(evRes.track.playerPlayCount, 1);
    assert.equal(evRes.track.biliPlayCount, 2);

    const fullRes = await fetch(`${info.url}/api/sync/full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [] }),
    }).then((r) => r.json());
    assert.equal(fullRes.ok, true);
    assert.equal(fullRes.tracks[0].title, '服务器测试曲');

    // 5) Playlists API
    const plRes = await fetch(`${info.url}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TestList' }),
    }).then((r) => r.json());
    assert.equal(plRes.ok, true);
    const addRes = await fetch(`${info.url}/api/playlists/${plRes.playlist.id}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKeys: ['BV1test_101'] }),
    }).then((r) => r.json());
    assert.equal(addRes.playlist.trackKeys.length, 1);

    // 6) Export download history API: includes live local file, excludes missing/un-downloaded records
    await fetch(`${info.url}/api/sync/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'TRACK_DETECTED',
        payload: {
          track: { bvid: 'BV1ghost', cid: '999', title: '未下载视频', owner: 'UP鬼' },
        },
      }),
    });

    const expMd = await fetch(`${info.url}/api/export/history?format=md`).then((r) => r.json());
    assert.equal(expMd.ok, true);
    assert.equal(expMd.count, 1);
    assert.ok(expMd.content.includes('服务器测试曲'));
    assert.ok(!expMd.content.includes('未下载视频'), 'Un-downloaded track must not appear in export');

    const expDownload = await fetch(`${info.url}/api/export/history?format=json&download=1`);
    assert.equal(expDownload.status, 200);
    assert.match(expDownload.headers.get('content-disposition') || '', /attachment;/);
    const expJsonBody = await expDownload.json();
    assert.equal(expJsonBody.totalCount, 1);
    assert.equal(expJsonBody.tracks[0].bvid, 'BV1test');

    // 删除本地磁盘文件后，再次导出必须自动排除已删文件
    await fs.unlink(path.join(musicDir, 'BV1test_101_30251.m4a'));
    const expAfterDelete = await fetch(`${info.url}/api/export/history?format=md`).then((r) => r.json());
    assert.equal(expAfterDelete.ok, true);
    assert.equal(expAfterDelete.count, 0);
    assert.equal(expAfterDelete.empty, true);
  } finally {
    await srv.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. player-sync.js + db.js：扩展侧双向同步集成测试
// ============================================================================
test('player-sync & db: syncs extension tracks with live player server and merges back player play counts', async () => {
  const prevIdb = globalThis.indexedDB;
  const idb = createMiniMockIdb();
  globalThis.indexedDB = idb;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-sync-'));
  const musicDir = path.join(tmpDir, 'music');
  await fs.mkdir(musicDir, { recursive: true });
  await fs.writeFile(path.join(musicDir, 'BV1sync_505_30280.m4a'), Buffer.from('audio-data'));

  const srv = createPlayerServer({
    port: 0,
    dataFilePath: path.join(tmpDir, 'library.json'),
    defaultMusicDirs: [musicDir],
    watchEnabled: false,
  });
  const info = await srv.start();

  try {
    // 播放器端先播放 2 次
    await fetch(`${info.url}/api/play-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'BV1sync_505', sessionId: 'p1', deltaSeconds: 20, incrementPlayCount: true }),
    });
    await fetch(`${info.url}/api/play-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: 'BV1sync_505', sessionId: 'p2', deltaSeconds: 25, incrementPlayCount: true }),
    });

    // 插件端记录 B 站网页播放 1 次
    const meta = { bvid: 'BV1sync', cid: '505', title: '双向同步曲目', owner: 'SyncUP', p: 1, totalParts: 1 };
    await upsertTrackMeta(meta, idb);
    await recordPlayProgress({ trackMeta: meta, deltaSeconds: 30, sessionId: 'b1', incrementPlayCount: true }, idb);

    const sessionStore = new Map();
    const client = createPlayerSyncClient({
      getAllTracks: () => getAllTracks(idb),
      mergeTracksFromPlayer: (list) => mergeTracksFromPlayer(list, idb),
      sessionStorage: {
        async get(k) { return { [k]: sessionStore.get(k) }; },
        async set(obj) { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
      },
    });

    const syncRes = await client.syncFull({ enablePlayerSync: true, playerApiOrigin: info.url });
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.syncState.online, true);

    const updatedExtTrack = await getTrack(makeTrackKey('BV1sync', '505'), idb);
    assert.equal(updatedExtTrack.biliPlayCount, 1);
    assert.equal(updatedExtTrack.playerPlayCount, 2);
    assert.equal(updatedExtTrack.playCount, 3);
    assert.equal(updatedExtTrack.totalPlayedSeconds, 75);
  } finally {
    await srv.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
    globalThis.indexedDB = prevIdb;
  }
});

// ============================================================================
// 5. player/public/index.html & player.js：DOM ID 契约与禁止阻塞弹窗校验
// ============================================================================
test('player/public: all element IDs match and no blocking dialogs or inline handlers exist', () => {
  const html = fsSync.readFileSync(new URL('../player/public/index.html', import.meta.url), 'utf8');
  const js = fsSync.readFileSync(new URL('../player/public/player.js', import.meta.url), 'utf8');

  assert.doesNotMatch(js, /\b(alert|confirm|prompt)\s*\(/, 'Player JS must never use blocking dialogs');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'Player HTML must not contain inline event attributes');

  const idSet = new Set();
  for (const m of html.matchAll(/id="([^"]+)"/g)) {
    idSet.add(m[1]);
  }
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(idSet.has(m[1]), `player.js references missing HTML element id: ${m[1]}`);
  }
  for (const sourceVal of ['all', 'both', 'local-only', 'cloud-only', 'missing']) {
    assert.ok(
      html.includes(`data-track-source="${sourceVal}"`),
      `index.html missing track source filter button: ${sourceVal}`
    );
  }
});

test('player/public: source filter pills count and filter local+cloud, local-only, cloud-only, and missing tracks', async () => {
  const html = fsSync.readFileSync(new URL('../player/public/index.html', import.meta.url), 'utf8');
  const js = fsSync.readFileSync(new URL('../player/public/player.js', import.meta.url), 'utf8');

  function makeFakeEl(tagName = 'div', id = '') {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      paused: true,
      ended: false,
      currentTime: 0,
      duration: 0,
      src: '',
      title: '',
      children: [],
      dataset: {},
      style: {},
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, force) => {
          const next = force === undefined ? !classes.has(c) : Boolean(force);
          if (next) classes.add(c);
          else classes.delete(c);
          return next;
        },
        contains: (c) => classes.has(c),
      },
      set className(val) {
        classes.clear();
        String(val || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      get className() {
        return Array.from(classes).join(' ');
      },
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent: async (evt) => {
        const type = typeof evt === 'string' ? evt : evt?.type;
        for (const fn of listeners.get(type) || []) {
          await fn(typeof evt === 'string' ? { type, target: el, stopPropagation() {} } : evt);
        }
      },
      append: (...nodes) => {
        for (const n of nodes) {
          if (n?.tagName === 'FRAGMENT') el.children.push(...n.children);
          else el.children.push(n);
        }
      },
      appendChild: (node) => {
        if (node?.tagName === 'FRAGMENT') el.children.push(...node.children);
        else el.children.push(node);
      },
      replaceChildren: (...nodes) => {
        el.children = [];
        el.append(...nodes);
      },
      play: async () => {},
      pause: () => {},
      focus: () => {},
    };
    return el;
  }

  const elMap = new Map();
  for (const m of html.matchAll(/id="([^"]+)"/g)) {
    elMap.set(m[1], makeFakeEl('div', m[1]));
  }
  elMap.get('volume-bar').value = '0.85';
  elMap.get('lb-sort').value = 'totalPlayCount';

  const trackSourceButtons = ['all', 'both', 'local-only', 'cloud-only', 'missing'].map((s) =>
    Object.assign(makeFakeEl('button'), { dataset: { trackSource: s } })
  );
  const navItems = ['all', 'favorites', 'leaderboard'].map((v) =>
    Object.assign(makeFakeEl('button'), { dataset: { view: v } })
  );
  const sourceButtons = ['all', 'player', 'bili'].map((s) =>
    Object.assign(makeFakeEl('button'), { dataset: { source: s } })
  );

  const docListeners = new Map();
  const fakeDocument = {
    activeElement: null,
    getElementById: (id) => elMap.get(id) || null,
    querySelectorAll: (sel) => {
      if (sel === '.track-source-btn') return trackSourceButtons;
      if (sel === '.nav-item') return navItems;
      if (sel === '.source-btn') return sourceButtons;
      return [];
    },
    createElement: (tag) => makeFakeEl(tag),
    createDocumentFragment: () => makeFakeEl('fragment'),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const sampleTracks = [
    {
      trackKey: 'BV1both_1',
      bvid: 'BV1both',
      title: '双端备份曲',
      owner: 'UP1',
      fileExists: true,
      filePath: 'D:\\BiliMusic\\UP1 - 双端备份曲.m4a',
      gdriveExists: true,
      gdriveFileId: 'drv_1',
      playable: true,
    },
    {
      trackKey: 'BV1loc_2',
      bvid: 'BV1loc',
      title: '仅本地曲',
      owner: 'UP2',
      fileExists: true,
      filePath: 'D:\\BiliMusic\\UP2 - 仅本地曲.m4a',
      gdriveExists: false,
      gdriveFileId: null,
      playable: true,
    },
    {
      trackKey: 'BV1cld_3',
      bvid: 'BV1cld',
      title: '仅云端曲',
      owner: 'UP3',
      fileExists: false,
      filePath: null,
      gdriveExists: true,
      gdriveFileId: 'drv_3',
      playable: true,
    },
    {
      trackKey: 'BV1miss_4',
      bvid: 'BV1miss',
      title: '未下载曲',
      owner: 'UP4',
      fileExists: false,
      filePath: null,
      gdriveExists: false,
      gdriveFileId: null,
      playable: false,
    },
  ];

  const exportedDownloads = [];
  const copiedTexts = [];
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/export/history')) {
      return {
        json: async () => ({
          ok: true,
          empty: false,
          count: 3,
          format: 'md',
          filename: 'BiliMusic-下载历史-2026-11-13.md',
          content: '# BiliMusic 已下载音乐清单\n| 1 | 双端备份曲 |',
        }),
      };
    }
    if (u.startsWith('/api/library')) {
      return {
        json: async () => ({
          ok: true,
          libraryRevision: 1,
          settings: { musicDirs: [], countThresholdSeconds: 15 },
          summary: { totalTracks: 4, playableTracks: 3, bothTracks: 1, localOnlyTracks: 1, cloudOnlyTracks: 1 },
          tracks: sampleTracks,
          playlists: [],
        }),
      };
    }
    return {
      json: async () => ({ ok: true, connected: true, cacheStats: { files: 0, totalBytes: 0 } }),
    };
  };

  const sandbox = {
    console,
    URL,
    Blob,
    encodeURIComponent,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Date,
    JSON,
    Promise,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    navigator: {
      clipboard: {
        writeText: async (txt) => { copiedTexts.push(txt); },
      },
    },
    document: {
      ...fakeDocument,
      body: { appendChild: () => {} },
      createElement: (tag) => {
        const node = makeFakeEl(tag);
        if (tag === 'a') {
          node.click = () => exportedDownloads.push({ href: node.href, download: node.download });
          node.remove = () => {};
        }
        return node;
      },
    },
    window: { innerWidth: 1220, innerHeight: 800, addEventListener: () => {}, open: () => {} },
    fetch: fakeFetch,
  };

  vm.runInNewContext(js, sandbox);
  for (const fn of docListeners.get('DOMContentLoaded') || []) {
    await fn();
  }
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(elMap.get('src-count-all').textContent, '4');
  assert.equal(elMap.get('src-count-both').textContent, '1');
  assert.equal(elMap.get('src-count-local-only').textContent, '1');
  assert.equal(elMap.get('src-count-cloud-only').textContent, '1');
  assert.equal(elMap.get('src-count-missing').textContent, '1');

  const tbody = elMap.get('track-list-body');
  assert.equal(tbody.children.length, 4);
  assert.equal(tbody.children[0].children[2].children[0].textContent, '本地 + ☁');
  assert.equal(tbody.children[1].children[2].children[0].textContent, '仅本地');
  assert.equal(tbody.children[2].children[2].children[0].textContent, '仅云端');
  assert.equal(tbody.children[3].children[2].children[0].textContent, '未下载');

  // 点击「本地 + 云端」筛选
  await trackSourceButtons[1].dispatchEvent('click');
  assert.equal(tbody.children.length, 1);
  assert.equal(tbody.children[0].children[2].children[0].textContent, '本地 + ☁');
  assert.equal(trackSourceButtons[1].classList.contains('is-active'), true);

  // 搜索不存在关键词后显示筛选空状态
  elMap.get('search-input').value = '不存在的歌名';
  await elMap.get('search-input').dispatchEvent('input');
  assert.equal(tbody.children.length, 0);
  assert.equal(elMap.get('tracks-empty').classList.contains('is-hidden'), false);
  assert.equal(elMap.get('tracks-empty-title').textContent, '当前筛选条件下暂无曲目');

  // 导出清单浮动菜单：复制给 AI & 导出文件
  elMap.get('export-format-select').value = 'md';
  await elMap.get('btn-export-copy').dispatchEvent('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(copiedTexts.length, 1);
  assert.ok(copiedTexts[0].includes('BiliMusic 已下载音乐清单'));

  await elMap.get('btn-export-download').dispatchEvent('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(exportedDownloads.length, 1);
  assert.equal(exportedDownloads[0].download, 'BiliMusic-下载历史-2026-11-13.md');
});

// ============================================================================
// 6. gdrive.mjs + server.mjs + store.mjs：Google Drive OAuth、扫码、Range 缓存与分片上传
// ============================================================================
function createMockGoogleDriveFetch(seedFiles = {}) {
  const files = new Map(); // id -> { id, name, mimeType, parents, bytes, modifiedTime }
  for (const [id, item] of Object.entries(seedFiles)) {
    files.set(id, { ...item, id });
  }
  const uploadSessions = new Map();
  let nextId = 100;
  let mediaGetCount = 0;

  const jsonRes = (data, status = 200, extraHeaders = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });

  const mockFetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();

    // Token exchange / refresh
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const form = new URLSearchParams(String(opts.body || ''));
      const gt = form.get('grant_type');
      if (gt === 'authorization_code') {
        return jsonRes({
          access_token: 'tok_access_1',
          refresh_token: 'tok_refresh_1',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive',
        });
      }
      if (gt === 'refresh_token') {
        return jsonRes({ access_token: 'tok_access_2', expires_in: 3600 });
      }
      return jsonRes({ error: 'unsupported_grant_type' }, 400);
    }

    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
      return new Response('', { status: 200 });
    }

    // Drive user about
    if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/about') {
      return jsonRes({ user: { displayName: 'Test Listener', emailAddress: 'listener@example.com' } });
    }

    // Resumable upload session PUT chunks
    if (u.hostname === 'upload.example.test' && method === 'PUT') {
      const sid = u.searchParams.get('sid');
      const sess = uploadSessions.get(sid);
      assert.ok(sess, 'Upload session must exist');
      const range = String(opts.headers?.['Content-Range'] || opts.headers?.get?.('Content-Range') || '');
      const m = range.match(/bytes (\d+)-(\d+)\/(\d+)/);
      assert.ok(m, 'Chunk upload must provide Content-Range');
      const end = Number(m[2]);
      const total = Number(m[3]);
      const chunkBuf = Buffer.from(opts.body);
      sess.chunks.push(chunkBuf);
      if (end + 1 < total) {
        return new Response('', { status: 308 });
      }
      const full = Buffer.concat(sess.chunks);
      const fid = sess.existingFileId || `drv_up_${++nextId}`;
      const rec = {
        id: fid,
        name: sess.name,
        mimeType: sess.mimeType || 'audio/mp4',
        parents: sess.parents || [sess.parentId],
        bytes: full,
        modifiedTime: new Date().toISOString(),
      };
      files.set(fid, rec);
      uploadSessions.delete(sid);
      return jsonRes({ id: fid, name: rec.name, size: String(full.length), modifiedTime: rec.modifiedTime }, 200);
    }

    // Resumable upload init
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/upload/drive/v3/files')) {
      const meta = JSON.parse(String(opts.body || '{}'));
      const sid = `sess_${++nextId}`;
      const existingId = method === 'PATCH' ? u.pathname.split('/').pop() : null;
      const existingRec = existingId ? files.get(existingId) : null;
      uploadSessions.set(sid, {
        existingFileId: existingId,
        name: meta.name || existingRec?.name,
        parents: meta.parents || existingRec?.parents,
        mimeType: opts.headers?.get?.('X-Upload-Content-Type') || 'audio/mp4',
        chunks: [],
      });
      return new Response('', {
        status: 200,
        headers: { Location: `https://upload.example.test/put?sid=${sid}` },
      });
    }

    // Drive list & create folder
    if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files') {
      if (method === 'POST') {
        const meta = JSON.parse(String(opts.body || '{}'));
        const id = `drv_dir_${++nextId}`;
        const rec = {
          id,
          name: meta.name,
          mimeType: meta.mimeType,
          parents: meta.parents || ['root'],
          modifiedTime: new Date().toISOString(),
        };
        files.set(id, rec);
        return jsonRes({ id: rec.id, name: rec.name });
      }

      const q = u.searchParams.get('q') || '';
      const parentMatches = Array.from(q.matchAll(/'([^']+)' in parents/g)).map((m) => m[1]);
      const nameMatch = q.match(/name = '([^']+)'/);
      const mimeMatch = q.match(/mimeType = '([^']+)'/);

      const matched = Array.from(files.values())
        .filter((f) => {
          if (parentMatches.length > 0 && !parentMatches.some((p) => (f.parents || []).includes(p))) return false;
          if (nameMatch && f.name !== nameMatch[1]) return false;
          if (mimeMatch && f.mimeType !== mimeMatch[1]) return false;
          return true;
        })
        .map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          parents: f.parents,
          size: f.bytes ? String(f.bytes.length) : undefined,
          modifiedTime: f.modifiedTime,
        }));
      return jsonRes({ files: matched });
    }

    // Drive download alt=media with Range support
    const mediaMatch = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (u.hostname === 'www.googleapis.com' && mediaMatch && u.searchParams.get('alt') === 'media') {
      mediaGetCount += 1;
      const fid = decodeURIComponent(mediaMatch[1]);
      const rec = files.get(fid);
      if (!rec || !rec.bytes) return jsonRes({ error: { message: 'Not found' } }, 404);
      const total = rec.bytes.length;
      const range = String(opts.headers?.get?.('Range') || opts.headers?.Range || '');
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        const start = m?.[1] ? Number(m[1]) : 0;
        const end = m?.[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
        return new Response(rec.bytes.subarray(start, end + 1), {
          status: 206,
          headers: {
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Type': 'application/octet-stream',
          },
        });
      }
      return new Response(rec.bytes, {
        status: 200,
        headers: { 'Content-Length': String(total), 'Content-Type': 'application/octet-stream' },
      });
    }

    throw new Error(`Unexpected mock fetch URL: ${method} ${url}`);
  };

  return {
    mockFetch,
    getMediaGetCount: () => mediaGetCount,
    getFilesMap: () => files,
  };
}

test('player/gdrive: OAuth PKCE, batched cloud scan, 206 Range cache, chunked upload and disconnect', async () => {
  assert.equal(parseDriveFolderId('https://drive.google.com/drive/u/0/folders/1AbCDef_99?usp=sharing'), '1AbCDef_99');
  assert.equal(parseDriveFolderId('https://drive.google.com/open?id=1OpenFolderId'), '1OpenFolderId');
  assert.equal(parseDriveFolderId('1PlainFolderId'), '1PlainFolderId');

  const cloudBytes = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'); // 40 bytes
  const mock = createMockGoogleDriveFetch({
    drv_root_music: {
      name: 'BiliMusic',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
    },
    drv_sub_album: {
      name: 'UP主C - 云端合集',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['drv_root_music'],
    },
    drv_song_cloud: {
      name: 'P02 - 远端风声.m4a',
      mimeType: 'audio/mp4',
      parents: ['drv_sub_album'],
      bytes: cloudBytes,
      modifiedTime: '2026-11-10T10:00:00.000Z',
    },
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-gdrive-'));
  const musicDir = path.join(tmpDir, 'local-music');
  await fs.mkdir(path.join(musicDir, '本地歌手 - 专属专辑'), { recursive: true });
  const localBytes = Buffer.from('LOCAL_AUDIO_CHUNK_1234567890_ABCDEFGHIJK'); // 40 bytes
  await fs.writeFile(path.join(musicDir, '本地歌手 - 专属专辑', 'P01 - 本地测试.m4a'), localBytes);

  const srv = createPlayerServer({
    port: 0,
    dataFilePath: path.join(tmpDir, 'library.json'),
    defaultMusicDirs: [musicDir],
    watchEnabled: false,
    gdriveOptions: {
      fetch: mock.mockFetch,
      uploadChunkBytes: 16, // 强制拆成 3 个分片 (16 + 16 + 8) 测试 308 续传
    },
  });
  const info = await srv.start();

  try {
    // 1) Start OAuth + simulate callback
    const authStart = await fetch(`${info.url}/api/gdrive/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
        folderInput: 'https://drive.google.com/drive/folders/drv_root_music?usp=sharing',
      }),
    }).then((r) => r.json());
    assert.equal(authStart.ok, true);
    const authUrl = new URL(authStart.authUrl);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    const oauthState = authUrl.searchParams.get('state');

    const cbRes = await fetch(`${info.url}/api/gdrive/oauth/callback?code=auth_code_ok&state=${oauthState}`);
    assert.equal(cbRes.status, 200);

    const status = await fetch(`${info.url}/api/gdrive/status`).then((r) => r.json());
    assert.equal(status.connected, true);
    assert.equal(status.userEmail, 'listener@example.com');
    assert.equal(status.folderId, 'drv_root_music');
    assert.equal(status.accessToken, undefined, 'Must never expose raw accessToken');
    assert.equal(status.refreshToken, undefined, 'Must never expose raw refreshToken');
    assert.equal(status.clientSecret, undefined, 'Must never expose raw clientSecret');

    // 2) Sync Drive folder -> merges cloud-only track alongside local track
    const syncRes = await fetch(`${info.url}/api/gdrive/sync`, { method: 'POST', body: '{}' }).then((r) => r.json());
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.scan.totalFiles, 1);
    assert.equal(syncRes.summary.playableTracks, 2);
    assert.equal(syncRes.summary.localOnlyTracks, 1);
    assert.equal(syncRes.summary.cloudOnlyTracks, 1);
    assert.equal(syncRes.summary.bothTracks, 0);

    const cloudTrack = syncRes.tracks.find((t) => t.gdriveFileId === 'drv_song_cloud');
    assert.ok(cloudTrack);
    assert.equal(cloudTrack.title, '云端合集');
    assert.equal(cloudTrack.owner, 'UP主C');
    assert.equal(cloudTrack.p, 2);
    assert.equal(cloudTrack.part, '远端风声');
    assert.equal(cloudTrack.playable, true);

    // 3) Stream cloud track with Range: bytes=0- -> streams AND tees to local cache
    const firstPlay = await fetch(`${info.url}/api/audio?trackKey=${encodeURIComponent(cloudTrack.trackKey)}`, {
      headers: { Range: 'bytes=0-' },
    });
    assert.equal(firstPlay.status, 206);
    assert.equal(firstPlay.headers.get('content-type'), 'audio/mp4');
    const firstBuf = Buffer.from(await firstPlay.arrayBuffer());
    assert.equal(firstBuf.toString(), cloudBytes.toString());
    assert.equal(mock.getMediaGetCount(), 1);

    // Wait briefly for server-side async tmpStream close + atomic rename into cacheDir
    let cachedReady = false;
    for (let i = 0; i < 40; i++) {
      const stAfter = await fetch(`${info.url}/api/gdrive/status`).then((r) => r.json());
      if (stAfter.cacheStats?.files === 1) {
        cachedReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(cachedReady, true, 'First full stream must finalize local cache file');

    // Second play slice should hit local disk cache without hitting mock Drive again!
    const secondPlay = await fetch(`${info.url}/api/audio?trackKey=${encodeURIComponent(cloudTrack.trackKey)}`, {
      headers: { Range: 'bytes=10-24' },
    });
    assert.equal(secondPlay.status, 206);
    assert.equal(secondPlay.headers.get('content-range'), 'bytes 10-24/40');
    const sliceBuf = Buffer.from(await secondPlay.arrayBuffer());
    assert.equal(sliceBuf.toString(), cloudBytes.subarray(10, 25).toString());
    assert.equal(mock.getMediaGetCount(), 1, 'Second request must serve straight from local disk cache');

    // Clear cache
    const clearRes = await fetch(`${info.url}/api/gdrive/cache/clear`, { method: 'POST', body: '{}' }).then((r) => r.json());
    assert.equal(clearRes.clearedFiles, 1);
    assert.equal(clearRes.freedBytes, 40);

    // 4) Resumable chunked upload of local track (creating nested album subfolder in Drive)
    const localTrack = syncRes.tracks.find((t) => t.fileExists);
    assert.ok(localTrack);
    const upRes = await fetch(`${info.url}/api/gdrive/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: localTrack.trackKey }),
    }).then((r) => r.json());
    assert.equal(upRes.ok, true);
    assert.equal(upRes.skippedExisting, false);
    assert.equal(upRes.track.gdriveExists, true);
    assert.ok(upRes.track.gdriveFileId);
    assert.equal(upRes.summary.bothTracks, 1);
    assert.equal(upRes.summary.localOnlyTracks, 0);
    assert.equal(upRes.summary.cloudOnlyTracks, 1);

    const uploadedFileRec = mock.getFilesMap().get(upRes.track.gdriveFileId);
    assert.ok(uploadedFileRec);
    assert.equal(uploadedFileRec.name, 'P01 - 本地测试.m4a');
    assert.equal(uploadedFileRec.bytes.toString(), localBytes.toString());

    // Re-uploading unchanged file skips cleanly
    const upAgain = await fetch(`${info.url}/api/gdrive/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackKey: localTrack.trackKey }),
    }).then((r) => r.json());
    assert.equal(upAgain.ok, true);
    assert.equal(upAgain.skippedExisting, true);

    // 5) Disconnect clears cloud-only availability while preserving local track
    const discRes = await fetch(`${info.url}/api/gdrive/auth/disconnect`, { method: 'POST', body: '{}' }).then((r) => r.json());
    assert.equal(discRes.ok, true);
    assert.equal(discRes.gdrive.connected, false);
    assert.equal(discRes.summary.playableTracks, 1);
    assert.equal(discRes.summary.bothTracks, 0);
    assert.equal(discRes.summary.localOnlyTracks, 1);
    assert.equal(discRes.summary.cloudOnlyTracks, 0);
  } finally {
    await srv.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
