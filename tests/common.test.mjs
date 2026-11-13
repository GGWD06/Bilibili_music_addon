import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORK_MODE,
  DOWNLOAD_STATUS,
  MSG_TARGET,
  ACTION,
  DASH_QUALITY_MAP,
  getQualityInfo,
  compareQuality,
  pickBestAudioTrack,
} from '../src/common/constants.js';
import {
  createEnvelope,
  isEnvelopeFor,
  createMessageRouter,
} from '../src/common/messaging.js';
import {
  sanitizeSegment,
  sanitizeArchiveDir,
  buildArchiveFilename,
  buildFallbackFilename,
} from '../src/common/sanitizer.js';
import {
  makeTrackKey,
  sortLeaderboardItems,
  upsertTrackMeta,
  recordPlayProgress,
  markTrackDownloaded,
  clearTrackDownload,
  getTrack,
  getLeaderboard,
  clearListeningStats,
} from '../src/common/db.js';

/**
 * 极简内存版 IDBFactory（仅覆盖 db.js 所需 Store / Index / KeyRange / Transaction 子集），
 * 让原生零依赖仓库无需 npm 安装即可用 node --test 实测全部 db.js 事务逻辑。
 */
function createMockIdbFactory() {
  const dbs = new Map();

  function makeReq(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        executor(req);
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }

  return {
    open(name, version) {
      return makeReq((req) => {
        let dbState = dbs.get(name);
        const needUpgrade = !dbState || dbState.version < version;
        if (!dbState) {
          dbState = { version, stores: new Map() };
          dbs.set(name, dbState);
        } else {
          dbState.version = version;
        }

        const apiDb = {
          objectStoreNames: {
            contains: (s) => dbState.stores.has(s),
          },
          createObjectStore(storeName, opts = {}) {
            const storeDef = {
              keyPath: opts.keyPath,
              autoIncrement: Boolean(opts.autoIncrement),
              seq: 0,
              rows: new Map(),
              indexes: new Map(),
            };
            dbState.stores.set(storeName, storeDef);
            return {
              createIndex(idxName, keyPath, idxOpts = {}) {
                storeDef.indexes.set(idxName, { keyPath, unique: Boolean(idxOpts.unique) });
              },
            };
          },
          transaction(names) {
            const storeNames = Array.isArray(names) ? names : [names];
            void storeNames;
            const tx = { oncomplete: null, onerror: null, onabort: null };
            let pending = 0;
            const scheduleComplete = () => {
              queueMicrotask(() => {
                if (pending === 0) tx.oncomplete?.({ target: tx });
              });
            };

            tx.objectStore = (storeName) => {
              const s = dbState.stores.get(storeName);
              const wrapOp = (fn) => {
                pending++;
                return makeReq((r) => {
                  try {
                    r.result = fn();
                    r.onsuccess?.({ target: r });
                  } finally {
                    pending--;
                    scheduleComplete();
                  }
                });
              };
              return {
                get: (key) => wrapOp(() => (s.rows.has(key) ? structuredClone(s.rows.get(key)) : undefined)),
                getAll: (range) =>
                  wrapOp(() => {
                    const vals = Array.from(s.rows.values()).map((v) => structuredClone(v));
                    if (range && range.__lower !== undefined) {
                      return vals.filter((v) => v[s.keyPath] >= range.__lower);
                    }
                    return vals;
                  }),
                put: (val) =>
                  wrapOp(() => {
                    const copy = structuredClone(val);
                    const k = copy[s.keyPath];
                    s.rows.set(k, copy);
                    return k;
                  }),
                add: (val) =>
                  wrapOp(() => {
                    const copy = structuredClone(val);
                    if (s.autoIncrement && copy[s.keyPath] === undefined) {
                      s.seq += 1;
                      copy[s.keyPath] = s.seq;
                    }
                    const k = copy[s.keyPath];
                    s.rows.set(k, copy);
                    return k;
                  }),
                delete: (key) => wrapOp(() => { s.rows.delete(key); }),
                clear: () => wrapOp(() => { s.rows.clear(); }),
                index(idxName) {
                  const idx = s.indexes.get(idxName);
                  return {
                    get: (val) =>
                      wrapOp(() => {
                        for (const row of s.rows.values()) {
                          if (row[idx.keyPath] === val) return structuredClone(row);
                        }
                        return undefined;
                      }),
                    getAll: (range) =>
                      wrapOp(() => {
                        const all = Array.from(s.rows.values()).map((v) => structuredClone(v));
                        if (range && range.__lower !== undefined) {
                          return all.filter((row) => row[idx.keyPath] >= range.__lower);
                        }
                        return all;
                      }),
                  };
                },
              };
            };

            queueMicrotask(() => {
              if (pending === 0) tx.oncomplete?.({ target: tx });
            });
            return tx;
          },
          close() {},
          onversionchange: null,
        };

        if (needUpgrade) {
          req.result = apiDb;
          req.onupgradeneeded?.({ target: req });
        }
        req.result = apiDb;
        req.onsuccess?.({ target: req });
      });
    },
  };
}

// ============================================================================
// constants.js
// ============================================================================
test('constants: quality lookup, comparison and best track selection', () => {
  assert.equal(WORK_MODE.AUTO_CAPTURE, 'AUTO_CAPTURE');
  assert.equal(DOWNLOAD_STATUS.COMPLETED, 'completed');
  assert.equal(DASH_QUALITY_MAP[30251].ext, 'm4a');
  assert.equal(DASH_QUALITY_MAP[30251].codecLabel, 'FLAC');

  assert.equal(getQualityInfo(30250).label, '杜比全景声');
  assert.equal(getQualityInfo(99999, 'fLaC').codecLabel, 'FLAC');
  assert.equal(getQualityInfo(null).shortLabel, 'N/A');

  assert.ok(compareQuality({ id: 30251, bandwidth: 100 }, { id: 30280, bandwidth: 999999 }) > 0);
  assert.ok(compareQuality({ id: 30280, bandwidth: 250000 }, { id: 30280, bandwidth: 190000 }) > 0);

  const best = pickBestAudioTrack([
    { id: 30216, bandwidth: 65000, baseUrl: 'https://cdn/64' },
    { id: 30280, bandwidth: 248000, baseUrl: 'https://cdn/192' },
    { id: 30251, bandwidth: 1400000, baseUrl: 'https://cdn/hires' },
    { id: 30251, bandwidth: 9999999, baseUrl: '' }, // 无 baseUrl 应被忽略
  ]);
  assert.equal(best.id, 30251);
  assert.equal(best.baseUrl, 'https://cdn/hires');
  assert.equal(pickBestAudioTrack([]), null);
});

// ============================================================================
// messaging.js
// ============================================================================
test('messaging: envelope construction, target check and router dispatch', async () => {
  const env = createEnvelope(MSG_TARGET.BACKGROUND, ACTION.TRACK_DETECTED, { bvid: 'BV1xx' }, { tabId: 7 });
  assert.equal(env.__bm, 1);
  assert.equal(env.target, MSG_TARGET.BACKGROUND);
  assert.equal(env.action, ACTION.TRACK_DETECTED);
  assert.equal(env.tabId, 7);
  assert.ok(isEnvelopeFor(env, MSG_TARGET.BACKGROUND));
  assert.equal(isEnvelopeFor(env, MSG_TARGET.POPUP), false);
  assert.equal(isEnvelopeFor({ target: MSG_TARGET.BACKGROUND, action: 'X' }, MSG_TARGET.BACKGROUND), false);

  const router = createMessageRouter(MSG_TARGET.BACKGROUND, {
    [ACTION.TRACK_DETECTED]: async (payload) => ({ saved: payload.bvid }),
    FAIL: () => { throw new Error('boom'); },
  });

  // 非目标消息应返回 false 忽略
  assert.equal(router(createEnvelope(MSG_TARGET.POPUP, ACTION.TRACK_DETECTED), {}, () => {}), false);
  // 未注册 action 应返回 false 忽略
  assert.equal(router(createEnvelope(MSG_TARGET.BACKGROUND, 'UNKNOWN'), {}, () => {}), false);

  // 正常异步响应
  const okRes = await new Promise((resolve) => {
    const keepOpen = router(env, { tab: { id: 7 } }, resolve);
    assert.equal(keepOpen, true);
  });
  assert.deepEqual(okRes, { ok: true, data: { saved: 'BV1xx' } });

  // 异常封装
  const errRes = await new Promise((resolve) => {
    router(createEnvelope(MSG_TARGET.BACKGROUND, 'FAIL'), {}, resolve);
  });
  assert.equal(errRes.ok, false);
  assert.match(errRes.error, /boom/);
});

// ============================================================================
// sanitizer.js
// ============================================================================
test('sanitizer: 3-stage pipeline prevents illegal chars, reserved names, traversal and surrogate splits', () => {
  assert.equal(sanitizeSegment('a\\b/c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeSegment('  ..hello\u0000..world...  '), 'hello_world');
  assert.equal(sanitizeSegment('CON'), '_CON_');
  assert.equal(sanitizeSegment('lpt3.txt'), '_lpt3.txt_');
  assert.equal(sanitizeSegment('...   ...'), 'untitled');
});

test('sanitizer: fallback, emoji surrogates, archive dir and relative paths', () => {
  assert.equal(sanitizeSegment('...   ...', 'fallback_name'), 'fallback_name');

  // 截断不能拆断 4 字节 Emoji 代理对
  const emojis = '🎵'.repeat(20);
  const sliced = sanitizeSegment(emojis, 'u', 5);
  assert.equal(Array.from(sliced).length, 5);
  assert.equal(sliced, '🎵'.repeat(5));

  // 目录防路径穿越
  assert.equal(sanitizeArchiveDir('../../Windows/System32'), 'Windows/System32');
  assert.equal(sanitizeArchiveDir('..\\..'), 'BiliMusic');
  assert.equal(sanitizeArchiveDir('BiliMusic\\MyMusic'), 'BiliMusic/MyMusic');

  // 单 P
  const single = buildArchiveFilename({
    bvid: 'BV11jnm6bEM6',
    cid: '42953738891',
    p: 1,
    totalParts: 1,
    title: '“南下の小曲.”|《Montagem Nada》',
    owner: '一支yuuu',
  });
  assert.equal(single, 'BiliMusic/一支yuuu - “南下の小曲.”_《Montagem Nada》.m4a');
  assert.ok(!single.includes('..'));

  // 多 P 分目录补零
  const multi = buildArchiveFilename({
    bvid: 'BV1xx',
    cid: '123',
    p: 3,
    totalParts: 12,
    title: 'CON',
    part: 'AUX: 第三首...',
    owner: 'UP/主',
  });
  assert.equal(multi, 'BiliMusic/UP_主 - _CON_/P03 - AUX_ 第三首.m4a');

  // 超长标题长度上限保护
  const giant = buildArchiveFilename({
    bvid: 'BV1long',
    cid: '999',
    p: 1,
    totalParts: 20,
    title: '歌'.repeat(120),
    part: '分'.repeat(120),
    owner: '作者'.repeat(40),
  });
  assert.ok(giant.length <= 185);

  assert.equal(
    buildFallbackFilename({ bvid: 'BV1xx', cid: 99, qualityId: 30251 }),
    'BiliMusic/BV1xx_99_30251.m4a'
  );
});

// ============================================================================
// db.js
// ============================================================================
test('db: track upsert, session play_logs coalescing, download upgrade & leaderboard', async () => {
  const idb = createMockIdbFactory();
  globalThis.IDBKeyRange = { lowerBound: (v) => ({ __lower: v }) };

  const trackA = { bvid: 'BV1A', cid: '101', p: 1, totalParts: 1, title: 'Song A', owner: 'U1', cover: 'https://img/a' };
  const trackB = { bvid: 'BV1B', cid: '202', p: 1, totalParts: 2, title: 'Song B', part: 'P1', owner: 'U2' };
  const keyA = makeTrackKey(trackA.bvid, trackA.cid);
  const keyB = makeTrackKey(trackB.bvid, trackB.cid);

  await upsertTrackMeta(trackA, idb);

  // 同一个 sessionId 两次心跳应合并为一条 play_logs
  const now = 1_700_000_000_000;
  await recordPlayProgress({ trackMeta: trackA, deltaSeconds: 10, sessionId: 's1', incrementPlayCount: false, now }, idb);
  await recordPlayProgress({ trackMeta: trackA, deltaSeconds: 8, sessionId: 's1', incrementPlayCount: true, now: now + 8000 }, idb);

  // 未达播放计数阈值的 4 秒切歌流水不应虚增 playCount
  await recordPlayProgress({ trackMeta: trackA, deltaSeconds: 4, sessionId: 's_short', incrementPlayCount: false, now: now + 20000 }, idb);

  // 老播放流水（10 天前）
  await recordPlayProgress({ trackMeta: trackB, deltaSeconds: 60, sessionId: 's_old', incrementPlayCount: true, now: now - 10 * 86400000 }, idb);

  await markTrackDownloaded(keyA, { qualityId: 30280, codecs: 'mp4a.40.2', downloadId: 55, filename: 'BiliMusic/U1 - Song A.m4a', downloadedAt: now }, idb);

  const fetchedA = await getTrack(keyA, idb);
  assert.equal(fetchedA.totalPlayedSeconds, 22);
  assert.equal(fetchedA.playCount, 1);
  assert.equal(fetchedA.qualityId, 30280);
  assert.equal(fetchedA.downloadId, 55);

  // 全量榜：B (60s) 排在 A (22s) 前面
  const allBoard = await getLeaderboard({ sortBy: 'totalPlayedSeconds', days: 0, now: now + 20000 }, idb);
  assert.equal(allBoard.summary.totalTracks, 2);
  assert.equal(allBoard.summary.downloadedTracks, 1);
  assert.equal(allBoard.summary.totalPlayedSeconds, 82);
  assert.equal(allBoard.items[0].trackKey, keyB);

  // 近 7 天榜：只包含 A，且短播放未计入 playCount
  const recentBoard = await getLeaderboard({ sortBy: 'totalPlayedSeconds', days: 7, now: now + 20000 }, idb);
  assert.equal(recentBoard.summary.totalTracks, 1);
  assert.equal(recentBoard.items[0].trackKey, keyA);
  assert.equal(recentBoard.items[0].totalPlayedSeconds, 22);
  assert.equal(recentBoard.items[0].playCount, 1);

  // 清空听歌统计但保留已下载归档状态
  await clearListeningStats(idb);
  const afterClearA = await getTrack(keyA, idb);
  const afterClearB = await getTrack(keyB, idb);
  assert.equal(afterClearA.playCount, 0);
  assert.equal(afterClearA.totalPlayedSeconds, 0);
  assert.equal(afterClearA.downloadId, 55);
  assert.equal(afterClearB, null); // 未下载的纯统计曲目被清理

  await clearTrackDownload(keyA, idb);
  const clearedDl = await getTrack(keyA, idb);
  assert.equal(clearedDl.downloadId, null);
  assert.equal(clearedDl.qualityId, null);

  assert.deepEqual(
    sortLeaderboardItems([{ id: 1, playCount: 2 }, { id: 2, playCount: 5 }], 'playCount').map((x) => x.id),
    [2, 1]
  );
});
