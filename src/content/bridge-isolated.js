/**
 * @fileoverview [ISOLATED 世界] 独立无依赖桥接探针（严禁使用 import/export）：
 * 1. 双向桥接 MAIN 世界 probe-main.js 与 Service Worker 消息通信。
 * 2. 监听页面 <video> 真实挂钟播放秒数，防止拖动进度条或倍速虚增听歌时长，并同步曲目心跳。
 * 3. 安全检测 Extension context invalidated，在扩展重载后自动静默停机。
 */
(() => {
  'use strict';

  const TAG = 'bm-content';
  const ENVELOPE_VERSION = 1;
  const TARGET_BG = 'background';
  const TARGET_CONTENT = 'content';

  const ACTION = {
    TRACK_DETECTED: 'TRACK_DETECTED',
    PLAY_HEARTBEAT: 'PLAY_HEARTBEAT',
    FETCH_DASH_BLOB: 'FETCH_DASH_BLOB',
    DASH_BLOB_READY: 'DASH_BLOB_READY',
    DASH_BLOB_FAILED: 'DASH_BLOB_FAILED',
    REVOKE_BLOB_URL: 'REVOKE_BLOB_URL',
  };

  const TICK_INTERVAL_MS = 1000;
  const FLUSH_INTERVAL_SECONDS = 5;
  const MAX_TICK_STEP_SECONDS = 2.5;

  let isDead = false;
  let currentSnapshot = null;
  let currentTrackKey = '';
  let currentSessionId = '';
  let lastTickMs = Date.now();
  let unflushedSeconds = 0;
  let videoEl = null;
  let tickTimerId = null;

  const pendingMainReqs = new Map();

  function createSessionId(bvid, cid) {
    return `${bvid}_${cid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function teardown() {
    if (isDead) return;
    isDead = true;
    if (tickTimerId !== null) {
      clearInterval(tickTimerId);
      tickTimerId = null;
    }
    pendingMainReqs.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error('Bridge torn down'));
    });
    pendingMainReqs.clear();
  }

  function safeSendToBg(action, payload) {
    if (isDead || !chrome.runtime || !chrome.runtime.id) {
      teardown();
      return Promise.resolve({ ok: false, invalidated: true });
    }
    const envelope = {
      __bm: ENVELOPE_VERSION,
      target: TARGET_BG,
      action,
      payload,
      timestamp: Date.now(),
    };
    return chrome.runtime.sendMessage(envelope).catch((err) => {
      const msg = String((err && err.message) || err);
      if (/Extension context invalidated/i.test(msg)) {
        teardown();
      }
      return { ok: false, error: msg };
    });
  }

  function askMain(type, payload = {}, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      if (isDead) {
        reject(new Error('Bridge context invalidated'));
        return;
      }
      const reqId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingMainReqs.delete(reqId);
        reject(new Error(`MAIN ${type} timeout`));
      }, timeoutMs);

      pendingMainReqs.set(reqId, { resolve, reject, timer });
      window.postMessage({ [TAG]: 'bridge', type, payload, reqId }, location.origin);
    });
  }

  function locateVideoElement() {
    if (videoEl && videoEl.isConnected) return videoEl;
    videoEl = document.querySelector('.bpx-player-video-wrap video, .bilibili-player-video video, video, bwp-video');
    return videoEl;
  }

  function isVideoPlaying(el) {
    if (!el || el.paused || el.ended) return false;
    if (typeof el.readyState === 'number' && el.readyState < 2) return false;
    return true;
  }

  function flushPlayProgress(force = false) {
    if (isDead || !currentSnapshot || !currentSnapshot.meta) return;
    if (unflushedSeconds <= 0) return;
    if (!force && unflushedSeconds < FLUSH_INTERVAL_SECONDS) return;

    const deltaSeconds = Number(unflushedSeconds.toFixed(2));
    unflushedSeconds = 0;

    safeSendToBg(ACTION.PLAY_HEARTBEAT, {
      meta: currentSnapshot.meta,
      sessionId: currentSessionId,
      deltaSeconds,
    });
  }

  function samplePlaybackStep() {
    if (isDead) return;
    const now = Date.now();
    const el = locateVideoElement();

    if (currentSnapshot && currentTrackKey && isVideoPlaying(el)) {
      const stepSec = Math.min(MAX_TICK_STEP_SECONDS, Math.max(0, (now - lastTickMs) / 1000));
      unflushedSeconds += stepSec;
      flushPlayProgress(false);
    }
    lastTickMs = now;
  }

  function handleTrackSnapshot(snapshot) {
    if (isDead || !snapshot || !snapshot.meta || !snapshot.meta.bvid || !snapshot.meta.cid) return;

    const nextKey = `${snapshot.meta.bvid}_${snapshot.meta.cid}`;
    if (currentTrackKey && currentTrackKey !== nextKey) {
      flushPlayProgress(true);
      unflushedSeconds = 0;
      currentSessionId = createSessionId(snapshot.meta.bvid, snapshot.meta.cid);
    } else if (!currentTrackKey) {
      currentSessionId = createSessionId(snapshot.meta.bvid, snapshot.meta.cid);
    }

    currentTrackKey = nextKey;
    currentSnapshot = snapshot;
    lastTickMs = Date.now();

    safeSendToBg(ACTION.TRACK_DETECTED, {
      ...snapshot,
      sessionId: currentSessionId,
    });
  }

  // ---- MAIN 世界消息监听 ----
  window.addEventListener('message', (event) => {
    if (isDead || event.source !== window || !event.data || event.data[TAG] !== 'main') return;
    const { type, payload, reqId } = event.data;

    if (reqId && pendingMainReqs.has(reqId)) {
      const req = pendingMainReqs.get(reqId);
      pendingMainReqs.delete(reqId);
      clearTimeout(req.timer);
      req.resolve(payload);
      return;
    }

    if (type === 'TRACK_SNAPSHOT') {
      handleTrackSnapshot(payload);
    }
  });

  // ---- Service Worker 下发指令监听 ----
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (isDead || !message || message.__bm !== ENVELOPE_VERSION || message.target !== TARGET_CONTENT) {
        return false;
      }

      if (message.action === ACTION.FETCH_DASH_BLOB) {
        const req = message.payload || {};
        // 异步执行拉流并通过 DASH_BLOB_READY / DASH_BLOB_FAILED 回传，避免长下载期间通道超时
        askMain('FETCH_DASH_BLOB', req, 240000)
          .then((res) => {
            if (res && res.ok) {
              safeSendToBg(ACTION.DASH_BLOB_READY, {
                taskId: req.taskId,
                trackKey: req.trackKey,
                qualityId: req.qualityId,
                codecs: req.codecs,
                filename: req.filename,
                fallbackFilename: req.fallbackFilename,
                oldDownloadId: req.oldDownloadId || null,
                meta: req.meta,
                blobUrl: res.blobUrl,
                size: res.size,
                mime: res.mime,
                usedUrl: res.usedUrl,
              });
            } else {
              safeSendToBg(ACTION.DASH_BLOB_FAILED, {
                taskId: req.taskId,
                trackKey: req.trackKey,
                error: (res && res.error) || 'Failed to fetch DASH stream',
              });
            }
          })
          .catch((err) => {
            safeSendToBg(ACTION.DASH_BLOB_FAILED, {
              taskId: req.taskId,
              trackKey: req.trackKey,
              error: String((err && err.message) || err),
            });
          });
        sendResponse({ ok: true, accepted: true });
        return false;
      }

      if (message.action === ACTION.REVOKE_BLOB_URL) {
        askMain('REVOKE_BLOB_URL', message.payload || {}, 10000)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
        return true;
      }

      return false;
    });
  }

  // ---- 绑定播放器事件与页面生命周期刷盘 ----
  document.addEventListener('pause', (e) => {
    if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'BWP-VIDEO')) {
      samplePlaybackStep();
      flushPlayProgress(true);
    }
  }, true);

  document.addEventListener('ended', (e) => {
    if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'BWP-VIDEO')) {
      samplePlaybackStep();
      flushPlayProgress(true);
    }
  }, true);

  window.addEventListener('pagehide', () => {
    samplePlaybackStep();
    flushPlayProgress(true);
  });

  // ---- 启动心跳并主动向 MAIN 世界拉取首屏快照 ----
  tickTimerId = setInterval(samplePlaybackStep, TICK_INTERVAL_MS);
  askMain('GET_CURRENT_TRACK', {}, 5000)
    .then((snapshot) => handleTrackSnapshot(snapshot))
    .catch(() => {});
})();
