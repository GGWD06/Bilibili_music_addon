/**
 * @fileoverview [MAIN 世界] 独立无依赖探针（严禁使用 import/export）：
 * 1. 抢在 document_start 无损劫持 fetch/XHR，按 cid 隔离缓存 playurl（防推荐预加载串曲）并缓存 view 元数据。
 * 2. 读取首屏 window.__playinfo__ 与 window.__INITIAL_STATE__，追踪 SPA 无刷新切 P / 切歌。
 * 3. 按后台指令在页面上下文以天然 Referer 拉取 DASH 音频流（支持 backupUrl 容灾），修正音频 MIME 生成 Blob URL 并管理释放。
 */
(() => {
  'use strict';

  const TAG = 'bm-content';
  const PLAYURL_RE = /\/x\/player\/(wbi\/)?playurl/;
  const PLAYER_V2_RE = /\/x\/player\/(wbi\/)?v2(\?|$)/;
  const VIEW_API_RE = /\/x\/web-interface\/(wbi\/)?view(\/detail)?(\?|$)/;
  const QUALITY_WEIGHT = { 30251: 500, 30250: 400, 30280: 300, 30232: 200, 30216: 100 };
  const BLOB_SAFETY_TTL_MS = 10 * 60 * 1000;

  const origFetch = window.fetch;
  const cacheByCid = new Map(); // cid(string) -> { data, source, bvid, updatedAt }
  const viewByBvid = new Map(); // bvid(string) -> normalizedVideoData
  const activePlayerCidByBvid = new Map(); // bvid(string) -> cid(string)，来自播放器 v2 接口
  const activeBlobs = new Map(); // blobUrl -> timeoutId

  let ssrPlayinfo = null;
  let ssrBoundCid = null;
  let lastEmittedSig = '';

  function postToBridge(type, payload, reqId) {
    try {
      window.postMessage({ [TAG]: 'main', type, payload, reqId }, location.origin);
    } catch (_) {}
  }

  function normalizeCoverUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw.startsWith('http://')) return `https://${raw.slice(7)}`;
    return raw;
  }

  function normalizeVideoData(raw) {
    if (!raw || typeof raw !== 'object' || !raw.bvid) return null;
    return {
      bvid: String(raw.bvid),
      cid: raw.cid ? String(raw.cid) : null,
      title: raw.title || '',
      owner: raw.owner && raw.owner.name ? String(raw.owner.name) : '',
      cover: normalizeCoverUrl(raw.pic),
      pages: Array.isArray(raw.pages)
        ? raw.pages.map((pg, idx) => ({
            cid: pg && pg.cid ? String(pg.cid) : null,
            page: Number(pg && pg.page) || idx + 1,
            part: pg && pg.part ? String(pg.part) : '',
            duration: Number(pg && pg.duration) || 0,
          }))
        : [],
      videos: Number(raw.videos) || 0,
    };
  }

  function getUrlContext() {
    const qs = new URLSearchParams(location.search);
    const pathBvid = (location.pathname.match(/BV[0-9A-Za-z]+/) || [])[0] || null;
    const urlBvid = pathBvid || qs.get('bvid') || null;
    const urlP = Number(qs.get('p')) || 0;
    const urlCid = qs.get('cid') ? String(qs.get('cid')) : null;
    return { urlBvid, urlP, urlCid };
  }

  function resolveVideoData(urlBvid) {
    const state = window.__INITIAL_STATE__ || {};
    const stateVideo = state.videoData && state.videoData.bvid ? state.videoData : null;
    if (stateVideo && stateVideo.bvid && !viewByBvid.has(stateVideo.bvid)) {
      const normalized = normalizeVideoData(stateVideo);
      if (normalized) viewByBvid.set(normalized.bvid, normalized);
    }

    if (urlBvid && viewByBvid.has(urlBvid)) {
      return viewByBvid.get(urlBvid);
    }
    if (!urlBvid && stateVideo) {
      return normalizeVideoData(stateVideo);
    }
    if (stateVideo && stateVideo.bvid === urlBvid) {
      return normalizeVideoData(stateVideo);
    }
    return null;
  }

  function cleanDocTitle() {
    return (document.title || '')
      .replace(/_哔哩哔哩_bilibili$/i, '')
      .replace(/-哔哩哔哩$/i, '')
      .trim();
  }

  function currentMeta() {
    const state = window.__INITIAL_STATE__ || {};
    const { urlBvid, urlP, urlCid } = getUrlContext();
    const video = resolveVideoData(urlBvid);

    const p = urlP || (video && Number(state.p)) || 1;
    const pages = video ? video.pages : [];
    const totalParts = pages.length || (video && video.videos) || 1;
    const pageItem = pages.find((pg) => pg.page === p) || pages[p - 1] || null;
    const playerCid = urlBvid ? activePlayerCidByBvid.get(urlBvid) : null;
    const cid =
      urlCid ||
      (pageItem && pageItem.cid) ||
      (video && video.cid) ||
      playerCid ||
      (!urlBvid && state.cid ? String(state.cid) : null);

    return {
      bvid: (video && video.bvid) || urlBvid || (!urlBvid && state.bvid ? String(state.bvid) : null),
      cid: cid ? String(cid) : null,
      p,
      totalParts,
      title: (video && video.title) || cleanDocTitle() || '',
      part: pageItem ? pageItem.part : null,
      owner: (video && video.owner) || '',
      cover: (video && video.cover) || null,
      duration: pageItem ? pageItem.duration : 0,
    };
  }

  function extractAudios(data) {
    const dash = data && data.dash;
    if (!dash) return [];
    const list = [];
    const pushTrack = (item) => {
      if (!item) return;
      const baseUrl = item.baseUrl || item.base_url || '';
      if (!baseUrl) return;
      const backupRaw = item.backupUrl || item.backup_url || [];
      list.push({
        id: Number(item.id) || 0,
        codecs: item.codecs || '',
        bandwidth: Number(item.bandwidth) || 0,
        mimeType: item.mimeType || item.mime_type || '',
        baseUrl,
        backupUrl: Array.isArray(backupRaw) ? backupRaw.filter(Boolean) : [],
      });
    };

    if (dash.flac && dash.flac.audio) pushTrack(dash.flac.audio);
    if (dash.dolby && Array.isArray(dash.dolby.audio)) dash.dolby.audio.forEach(pushTrack);
    if (Array.isArray(dash.audio)) dash.audio.forEach(pushTrack);

    list.sort((a, b) => {
      const wDiff = (QUALITY_WEIGHT[b.id] || 0) - (QUALITY_WEIGHT[a.id] || 0);
      if (wDiff !== 0) return wDiff;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    });
    return list;
  }

  function bindSsrIfReady() {
    if (!ssrPlayinfo || ssrBoundCid) return;
    const meta = currentMeta();
    if (!meta.cid || !meta.bvid) return;
    ssrBoundCid = meta.cid;
    if (!cacheByCid.has(meta.cid)) {
      cacheByCid.set(meta.cid, {
        data: ssrPlayinfo,
        source: '__playinfo__',
        bvid: meta.bvid,
        updatedAt: Date.now(),
      });
    }
  }

  function buildTrackSnapshot() {
    bindSsrIfReady();
    const meta = currentMeta();
    const entry = meta.cid ? cacheByCid.get(meta.cid) : null;
    const audios = entry ? extractAudios(entry.data) : [];
    const hasDurl = Boolean(entry && entry.data && Array.isArray(entry.data.durl) && entry.data.durl.length > 0);
    return {
      meta,
      matched: Boolean(entry),
      source: entry ? entry.source : null,
      audios,
      hasDurl: hasDurl && audios.length === 0,
    };
  }

  function emitTrackSnapshot(force = false) {
    const snapshot = buildTrackSnapshot();
    const { meta, matched, audios, hasDurl } = snapshot;
    if (!meta.bvid || !meta.cid) return;

    const topId = audios[0] ? audios[0].id : 0;
    const sig = `${meta.bvid}|${meta.cid}|${meta.p}|${meta.title}|${matched}|${topId}|${hasDurl}`;
    if (!force && sig === lastEmittedSig) return;
    lastEmittedSig = sig;
    postToBridge('TRACK_SNAPSHOT', snapshot);
  }

  function handlePlayurlPayload(json, source, reqUrl) {
    const data = json && json.data;
    if (!data || (!data.dash && !data.durl)) return;
    let cid = null;
    let bvid = null;
    try {
      const parsed = new URL(reqUrl, location.href);
      cid = parsed.searchParams.get('cid');
      bvid = parsed.searchParams.get('bvid');
    } catch (_) {}
    if (!cid) return;

    const cidStr = String(cid);
    cacheByCid.set(cidStr, { data, source, bvid, updatedAt: Date.now() });
    bindSsrIfReady();

    // 仅当拦截到的 cid 与当前在播 cid 一致时才触发更新推送，彻底隔离推荐预加载
    const meta = currentMeta();
    if (meta.cid === cidStr) {
      emitTrackSnapshot();
    }
  }

  function handleViewPayload(json) {
    const raw = json && json.data ? json.data.View || json.data : null;
    const normalized = normalizeVideoData(raw);
    if (!normalized) return;
    viewByBvid.set(normalized.bvid, normalized);
    const { urlBvid } = getUrlContext();
    if (!urlBvid || urlBvid === normalized.bvid) {
      emitTrackSnapshot();
    }
  }

  function handlePlayerV2Payload(json) {
    const data = json && json.data;
    if (!data || !data.bvid || !data.cid) return;
    const bvid = String(data.bvid);
    const cid = String(data.cid);
    activePlayerCidByBvid.set(bvid, cid);
    const { urlBvid } = getUrlContext();
    if (!urlBvid || urlBvid === bvid) {
      emitTrackSnapshot();
    }
  }

  function inspectInterceptedJson(url, json, source) {
    if (!json || typeof json !== 'object') return;
    if (PLAYURL_RE.test(url)) {
      handlePlayurlPayload(json, source, url);
    } else if (VIEW_API_RE.test(url)) {
      handleViewPayload(json);
    } else if (PLAYER_V2_RE.test(url)) {
      handlePlayerV2Payload(json);
    }
  }

  // ---- 无损劫持 fetch ----
  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (PLAYURL_RE.test(url) || VIEW_API_RE.test(url) || PLAYER_V2_RE.test(url)) {
        promise
          .then((res) => (res && res.ok ? res.clone().json() : null))
          .then((json) => inspectInterceptedJson(url, json, 'fetch'))
          .catch(() => {});
      }
    } catch (_) {}
    return promise;
  };

  // ---- 无损劫持 XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__bmUrl = String(url || '');
    } catch (_) {}
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const reqUrl = this.__bmUrl;
      if (reqUrl && (PLAYURL_RE.test(reqUrl) || VIEW_API_RE.test(reqUrl) || PLAYER_V2_RE.test(reqUrl))) {
        this.addEventListener('load', () => {
          try {
            let json = null;
            if (this.responseType === 'json') json = this.response;
            else if (this.responseType === '' || this.responseType === 'text') {
              json = JSON.parse(this.responseText);
            }
            inspectInterceptedJson(reqUrl, json, 'xhr');
          } catch (_) {}
        });
      }
    } catch (_) {}
    return origSend.apply(this, args);
  };

  // ---- 首屏 SSR __playinfo__ 与 __INITIAL_STATE__ 轮询绑定 ----
  function tryCaptureSsrPlayinfo() {
    const pi = window.__playinfo__;
    if (pi && pi.data && (pi.data.dash || pi.data.durl) && !ssrPlayinfo) {
      ssrPlayinfo = pi.data;
    }
    bindSsrIfReady();
  }

  let pollTries = 0;
  const ssrPollTimer = setInterval(() => {
    try {
      pollTries += 1;
      tryCaptureSsrPlayinfo();
      emitTrackSnapshot();
      if (ssrBoundCid || pollTries >= 80) {
        clearInterval(ssrPollTimer);
      }
    } catch (_) {
      clearInterval(ssrPollTimer);
    }
  }, 250);

  window.addEventListener('DOMContentLoaded', () => {
    try {
      tryCaptureSsrPlayinfo();
      emitTrackSnapshot();
    } catch (_) {}
  });

  // ---- SPA 无刷新切 P / 切歌路由追踪 ----
  function scheduleRouteSync() {
    setTimeout(() => emitTrackSnapshot(), 120);
    setTimeout(() => emitTrackSnapshot(), 600);
    setTimeout(() => emitTrackSnapshot(), 1500);
  }

  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const res = origPushState.apply(this, args);
    try { scheduleRouteSync(); } catch (_) {}
    return res;
  };
  history.replaceState = function (...args) {
    const res = origReplaceState.apply(this, args);
    try { scheduleRouteSync(); } catch (_) {}
    return res;
  };
  window.addEventListener('popstate', scheduleRouteSync);

  // ---- 页面侧 DASH 拉流（支持 backupUrl 容灾 + 修正 MIME 生成 Blob URL） ----
  function revokeBlobUrl(blobUrl) {
    if (!blobUrl || !activeBlobs.has(blobUrl)) return { ok: true, revoked: false };
    clearTimeout(activeBlobs.get(blobUrl));
    activeBlobs.delete(blobUrl);
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (_) {}
    return { ok: true, revoked: true };
  }

  async function fetchDashBlob(payload) {
    const urls = Array.from(new Set(Array.isArray(payload.urls) ? payload.urls.filter(Boolean) : []));
    const mimeType = payload.mimeType || 'audio/x-m4a';
    if (urls.length === 0) {
      return { ok: false, error: 'No candidate DASH URLs provided' };
    }

    let lastError = 'Unknown fetch error';
    for (const url of urls) {
      try {
        const res = await origFetch(url);
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        const rawBlob = await res.blob();
        if (!rawBlob || rawBlob.size <= 0) {
          lastError = 'Empty audio stream';
          continue;
        }
        const audioBlob = new Blob([rawBlob], { type: mimeType });
        const blobUrl = URL.createObjectURL(audioBlob);
        const timerId = setTimeout(() => revokeBlobUrl(blobUrl), BLOB_SAFETY_TTL_MS);
        activeBlobs.set(blobUrl, timerId);
        return {
          ok: true,
          blobUrl,
          size: audioBlob.size,
          mime: audioBlob.type,
          usedUrl: url,
        };
      } catch (err) {
        lastError = String((err && err.message) || err);
      }
    }
    return { ok: false, error: lastError };
  }

  // ---- 与 ISOLATED 桥接脚本双向通信 ----
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data[TAG] !== 'bridge') return;
    const { type, payload = {}, reqId } = event.data;
    try {
      if (type === 'GET_CURRENT_TRACK') {
        postToBridge('TRACK_SNAPSHOT', buildTrackSnapshot(), reqId);
      } else if (type === 'FETCH_DASH_BLOB') {
        const result = await fetchDashBlob(payload);
        postToBridge('FETCH_DASH_BLOB_RESULT', result, reqId);
      } else if (type === 'REVOKE_BLOB_URL') {
        postToBridge('REVOKE_BLOB_URL_RESULT', revokeBlobUrl(payload.blobUrl), reqId);
      }
    } catch (err) {
      postToBridge(`${type}_RESULT`, { ok: false, error: String((err && err.message) || err) }, reqId);
    }
  });
})();
