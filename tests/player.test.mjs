import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseArchiveFilenameMeta, scanMusicDirectories, extractArchiveRootFromFilename } from '../player/lib/scanner.mjs';
import { createPlayerStore } from '../player/lib/store.mjs';
import { createPlayerServer } from '../player/server.mjs';
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
});
