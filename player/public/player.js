/**
 * @fileoverview BiliMusic 独立配套桌面播放器前端核心逻辑（4态播放模式、洗牌队列、歌单管理、真实播放计数与后台同步）。
 */

const PLAY_MODE = Object.freeze({
  LIST_LOOP: 'list_loop',
  SINGLE_LOOP: 'single_loop',
  PLAYLIST_SHUFFLE: 'playlist_shuffle',
  ALL_SHUFFLE: 'all_shuffle',
});

const PLAY_MODE_ORDER = [
  PLAY_MODE.LIST_LOOP,
  PLAY_MODE.SINGLE_LOOP,
  PLAY_MODE.PLAYLIST_SHUFFLE,
  PLAY_MODE.ALL_SHUFFLE,
];

const PLAY_MODE_META = Object.freeze({
  [PLAY_MODE.LIST_LOOP]: { label: '🔁 列表循环', short: '列表循环', isShuffle: false },
  [PLAY_MODE.SINGLE_LOOP]: { label: '🔂 单曲循环', short: '单曲循环', isShuffle: false },
  [PLAY_MODE.PLAYLIST_SHUFFLE]: { label: '🔀 列表随机', short: '列表随机', isShuffle: true },
  [PLAY_MODE.ALL_SHUFFLE]: { label: '🎲 全部随机', short: '全部随机', isShuffle: true },
});

const QUALITY_META = Object.freeze({
  30251: { label: 'Hi-Res 无损', cls: 'pill-hires' },
  30250: { label: '杜比全景声', cls: 'pill-dolby' },
  30280: { label: '192K AAC', cls: 'pill-high' },
  30232: { label: '132K AAC', cls: 'pill-muted' },
  30216: { label: '64K AAC', cls: 'pill-muted' },
});

const RATES = [1.0, 1.25, 1.5, 0.75];

const state = {
  libraryRevision: 0,
  lastExtensionSyncAt: null,
  settings: {
    musicDirs: [],
    countThresholdSeconds: 15,
  },
  summary: {},
  tracks: [],
  trackMap: new Map(),
  playlists: [],

  // View state
  activeView: 'all', // 'all' | 'favorites' | 'leaderboard' | 'playlist'
  activePlaylistId: null,
  editingPlaylistId: null,
  searchQuery: '',
  lbSource: 'all',
  lbSortBy: 'totalPlayCount',
  queueOpen: false,

  // Playback & queue state
  playMode: PLAY_MODE.LIST_LOOP,
  queue: [],
  queueIndex: -1,
  historyStack: [],
  currentTrackKey: null,
  playbackRateIndex: 0,
  isSeeking: false,

  // Real playback accounting
  sessionId: null,
  sessionAccumSeconds: 0,
  sessionPendingFlush: 0,
  sessionCounted: false,
  lastWallClockMs: 0,

  // UI timers & popovers
  toastTimer: null,
  pickerTrackKey: null,
  deleteConfirmId: null,
  deleteConfirmTimer: null,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('http://')) return `https://${raw.slice(7)}`;
  return raw;
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(rem)}` : `${pad(m)}:${pad(rem)}`;
}

function formatHuman(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h}h${m % 60}m` : `${h}h`;
}

function showToast(msg, variant = 'info') {
  if (!els.toast) return;
  clearTimeout(state.toastTimer);
  els.toast.textContent = msg;
  els.toast.className = `toast ${variant === 'success' ? 'is-success' : variant === 'error' ? 'is-error' : ''}`;
  state.toastTimer = setTimeout(() => {
    els.toast.classList.add('is-hidden');
  }, 2600);
}

function shuffleArray(items, keepFirstKey = null) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  if (keepFirstKey) {
    const idx = arr.indexOf(keepFirstKey);
    if (idx > 0) {
      [arr[0], arr[idx]] = [arr[idx], arr[0]];
    }
  }
  return arr;
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return res.json();
}

function getQualityBadge(track) {
  const qid = Number(track?.qualityId);
  if (qid && QUALITY_META[qid]) return QUALITY_META[qid];
  if (track?.codecs) {
    const up = String(track.codecs).toUpperCase();
    if (up.includes('FLAC')) return { label: 'FLAC', cls: 'pill-hires' };
    if (up.includes('EC-3')) return { label: 'Dolby', cls: 'pill-dolby' };
  }
  return { label: qid ? `${qid}` : '本地音频', cls: 'pill-muted' };
}

function getTracksForView(view = state.activeView, playlistId = state.activePlaylistId) {
  let list = [];
  if (view === 'favorites') {
    list = state.tracks.filter((t) => t.favorite);
  } else if (view === 'playlist' && playlistId) {
    const pl = state.playlists.find((p) => p.id === playlistId);
    if (pl && Array.isArray(pl.trackKeys)) {
      list = pl.trackKeys.map((k) => state.trackMap.get(k)).filter(Boolean);
    }
  } else {
    list = [...state.tracks];
  }

  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((t) => {
      const hay = `${t.title || ''} ${t.part || ''} ${t.owner || ''} ${t.bvid || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return list;
}

function getPlayableKeys(tracks) {
  return tracks.filter((t) => t.fileExists && t.filePath).map((t) => t.trackKey);
}

function rebuildQueue({ mode = state.playMode, sourceTracks = null, anchorKey = state.currentTrackKey } = {}) {
  let poolKeys = [];
  if (mode === PLAY_MODE.ALL_SHUFFLE) {
    poolKeys = getPlayableKeys(state.tracks);
  } else {
    const baseTracks = sourceTracks || getTracksForView();
    poolKeys = getPlayableKeys(baseTracks);
    if (poolKeys.length === 0) {
      poolKeys = getPlayableKeys(state.tracks);
    }
  }

  if (mode === PLAY_MODE.PLAYLIST_SHUFFLE || mode === PLAY_MODE.ALL_SHUFFLE) {
    state.queue = shuffleArray(poolKeys, anchorKey);
  } else {
    state.queue = poolKeys;
  }

  state.queueIndex = anchorKey ? state.queue.indexOf(anchorKey) : state.queue.length > 0 ? 0 : -1;
  renderQueueDrawer();
}

function createSessionId(trackKey) {
  return `${trackKey}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function flushPlaybackProgress(forceCount = false) {
  const trackKey = state.currentTrackKey;
  if (!trackKey) return;
  const delta = state.sessionPendingFlush;
  const threshold = Math.max(3, Number(state.settings?.countThresholdSeconds) || 15);
  const reachedNow = !state.sessionCounted && (forceCount || state.sessionAccumSeconds >= threshold);

  if (delta <= 0 && !reachedNow) return;

  state.sessionPendingFlush = 0;
  if (reachedNow) {
    state.sessionCounted = true;
  }

  try {
    const res = await apiJson('/api/play-heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        trackKey,
        sessionId: state.sessionId,
        deltaSeconds: Number(delta.toFixed(2)),
        incrementPlayCount: reachedNow,
      }),
    });
    if (res?.ok && res.track) {
      applyUpdatedTrack(res.track, res.summary);
      if (reachedNow) {
        showToast(`已计入有效播放: ${res.track.title} (总 ${res.track.totalPlayCount} 次)`, 'success');
      }
    }
  } catch (_) {}
}

function applyUpdatedTrack(updatedTrack, summary) {
  if (!updatedTrack?.trackKey) return;
  state.trackMap.set(updatedTrack.trackKey, updatedTrack);
  const idx = state.tracks.findIndex((t) => t.trackKey === updatedTrack.trackKey);
  if (idx >= 0) {
    state.tracks[idx] = updatedTrack;
  } else {
    state.tracks.unshift(updatedTrack);
  }
  if (summary) state.summary = summary;
  renderSidebarCounts();
  renderNowPlayingBar();
  renderTrackTable();
  if (state.activeView === 'leaderboard') {
    refreshLeaderboard();
  }
}

async function playTrackByKey(trackKey, { pushHistory = true, rebuildFromView = false } = {}) {
  const track = state.trackMap.get(trackKey);
  if (!track) return;
  if (!track.fileExists || !track.filePath) {
    showToast('本地音频文件尚未下载或已被移除', 'error');
    return;
  }

  await flushPlaybackProgress(false);

  if (pushHistory && state.currentTrackKey && state.currentTrackKey !== trackKey) {
    state.historyStack.push(state.currentTrackKey);
    if (state.historyStack.length > 100) state.historyStack.shift();
  }

  if (rebuildFromView || state.queue.length === 0 || !state.queue.includes(trackKey)) {
    rebuildQueue({ mode: state.playMode, anchorKey: trackKey });
  } else {
    state.queueIndex = state.queue.indexOf(trackKey);
  }

  state.currentTrackKey = trackKey;
  state.sessionId = createSessionId(trackKey);
  state.sessionAccumSeconds = 0;
  state.sessionPendingFlush = 0;
  state.sessionCounted = false;
  state.lastWallClockMs = performance.now();

  const audioUrl = `/api/audio?trackKey=${encodeURIComponent(trackKey)}&t=${Date.now()}`;
  els.audioEl.src = audioUrl;
  els.audioEl.playbackRate = RATES[state.playbackRateIndex] || 1.0;

  try {
    await els.audioEl.play();
  } catch (err) {
    showToast(`播放启动受阻: ${err?.message || '请点击播放按钮继续'}`, 'error');
  }

  renderNowPlayingBar();
  renderTrackTable();
  renderQueueDrawer();
}

async function playNextTrack({ autoTriggered = false } = {}) {
  if (autoTriggered && state.playMode === PLAY_MODE.SINGLE_LOOP && state.currentTrackKey) {
    await playTrackByKey(state.currentTrackKey, { pushHistory: false });
    return;
  }

  if (state.queue.length === 0) {
    rebuildQueue({ mode: state.playMode });
  }
  if (state.queue.length === 0) {
    showToast('当前没有可播放的本地音频文件', 'error');
    return;
  }

  let nextIdx = state.queueIndex + 1;
  if (nextIdx >= state.queue.length) {
    if (state.playMode === PLAY_MODE.PLAYLIST_SHUFFLE || state.playMode === PLAY_MODE.ALL_SHUFFLE) {
      rebuildQueue({ mode: state.playMode, anchorKey: null });
      if (state.queue.length > 1 && state.queue[0] === state.currentTrackKey) {
        [state.queue[0], state.queue[1]] = [state.queue[1], state.queue[0]];
      }
      nextIdx = 0;
    } else {
      nextIdx = 0;
    }
  }

  const nextKey = state.queue[nextIdx];
  if (nextKey) {
    state.queueIndex = nextIdx;
    await playTrackByKey(nextKey, { pushHistory: true });
  }
}

async function playPrevTrack() {
  if (els.audioEl.currentTime > 4) {
    els.audioEl.currentTime = 0;
    return;
  }

  while (state.historyStack.length > 0) {
    const prevKey = state.historyStack.pop();
    const t = state.trackMap.get(prevKey);
    if (t && t.fileExists) {
      await playTrackByKey(prevKey, { pushHistory: false });
      return;
    }
  }

  if (state.queue.length === 0) return;
  const prevIdx = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  state.queueIndex = prevIdx;
  await playTrackByKey(state.queue[prevIdx], { pushHistory: false });
}

function setPlayMode(nextMode, { reshuffle = true, announce = true } = {}) {
  if (!PLAY_MODE_META[nextMode]) return;
  state.playMode = nextMode;
  if (reshuffle) {
    rebuildQueue({ mode: nextMode, anchorKey: state.currentTrackKey });
  }
  renderPlayModeButton();
  renderQueueDrawer();
  if (announce) {
    showToast(`已切换为：${PLAY_MODE_META[nextMode].short}`, 'info');
  }
}

function renderPlayModeButton() {
  const meta = PLAY_MODE_META[state.playMode] || PLAY_MODE_META[PLAY_MODE.LIST_LOOP];
  els.btnPlayMode.textContent = meta.label;
  els.btnPlayMode.classList.toggle('is-shuffle', meta.isShuffle);
  els.queueModeLabel.textContent = meta.short;
}

function renderSyncStatus() {
  const hasSync = Boolean(state.lastExtensionSyncAt);
  els.syncStatusDot.classList.toggle('is-online', hasSync);
  if (hasSync) {
    const playable = state.summary?.playableTracks ?? 0;
    els.syncStatusText.textContent = `已联动插件 · ${playable} 首可播`;
  } else {
    const playable = state.summary?.playableTracks ?? 0;
    els.syncStatusText.textContent = `本地曲库 · ${playable} 首可播`;
  }
}

function renderSidebarCounts() {
  els.countAll.textContent = String(state.tracks.length);
  els.countFav.textContent = String(state.tracks.filter((t) => t.favorite).length);
  renderSyncStatus();
}

function renderPlaylistsNav() {
  els.playlistNavList.replaceChildren();
  const frag = document.createDocumentFragment();

  for (const pl of state.playlists) {
    const li = document.createElement('li');
    const isActive = state.activeView === 'playlist' && state.activePlaylistId === pl.id;
    li.className = `playlist-row${isActive ? ' is-active' : ''}`;

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'playlist-select-btn';

    const iconSpan = document.createElement('span');
    iconSpan.textContent = '☰';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'playlist-name';
    nameSpan.textContent = pl.name;
    nameSpan.title = pl.name;
    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'nav-badge mono';
    badgeSpan.textContent = String((pl.trackKeys || []).length);

    selectBtn.append(iconSpan, nameSpan, badgeSpan);
    selectBtn.addEventListener('click', () => {
      switchView('playlist', pl.id);
    });

    const ops = document.createElement('div');
    const isConfirming = state.deleteConfirmId === pl.id;
    ops.className = `playlist-row-ops${isConfirming ? ' is-confirming' : ''}`;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-tiny-op';
    editBtn.title = '重命名歌单';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlaylistForm(pl.id, pl.name);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = `btn-tiny-op${isConfirming ? ' is-confirming' : ''}`;
    delBtn.title = '删除歌单';
    delBtn.textContent = isConfirming ? '确认?' : '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.deleteConfirmId !== pl.id) {
        state.deleteConfirmId = pl.id;
        clearTimeout(state.deleteConfirmTimer);
        state.deleteConfirmTimer = setTimeout(() => {
          state.deleteConfirmId = null;
          renderPlaylistsNav();
        }, 3500);
        renderPlaylistsNav();
        return;
      }
      clearTimeout(state.deleteConfirmTimer);
      state.deleteConfirmId = null;
      const res = await apiJson(`/api/playlists/${encodeURIComponent(pl.id)}`, { method: 'DELETE' });
      if (res?.ok) {
        if (state.activeView === 'playlist' && state.activePlaylistId === pl.id) {
          switchView('all');
        }
        showToast('歌单已删除', 'success');
        await fetchLibrary();
      } else {
        showToast(res?.error || '删除失败', 'error');
      }
    });

    ops.append(editBtn, delBtn);
    li.append(selectBtn, ops);
    frag.appendChild(li);
  }

  els.playlistNavList.appendChild(frag);
}

function renderTrackTable() {
  const list = getTracksForView();

  if (state.activeView === 'all') {
    els.viewTitle.textContent = '全部音乐';
  } else if (state.activeView === 'favorites') {
    els.viewTitle.textContent = '我喜欢的音乐';
  } else if (state.activeView === 'playlist') {
    const pl = state.playlists.find((p) => p.id === state.activePlaylistId);
    els.viewTitle.textContent = pl ? pl.name : '自定义歌单';
  }

  if (state.activeView !== 'leaderboard') {
    const playableCount = list.filter((t) => t.fileExists).length;
    els.viewSubtitle.textContent = `${list.length} 首曲目 · ${playableCount} 首可播放`;
  }

  els.trackListBody.replaceChildren();
  if (list.length === 0) {
    els.tracksEmpty.classList.remove('is-hidden');
    return;
  }
  els.tracksEmpty.classList.add('is-hidden');

  const frag = document.createDocumentFragment();
  list.forEach((track, idx) => {
    const tr = document.createElement('tr');
    const isPlaying = state.currentTrackKey === track.trackKey;
    tr.className = `track-row${isPlaying ? ' is-playing' : ''}${!track.fileExists ? ' is-missing' : ''}`;
    tr.addEventListener('dblclick', () => {
      playTrackByKey(track.trackKey, { rebuildFromView: true });
    });

    // Index
    const tdIdx = document.createElement('td');
    tdIdx.className = 'td-idx mono';
    tdIdx.textContent = isPlaying ? '▶' : String(idx + 1);

    // Title + cover
    const tdTitle = document.createElement('td');
    const titleCell = document.createElement('div');
    titleCell.className = 'track-title-cell';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'row-thumb-wrap';
    const coverUrl = normalizeUrl(track.cover);
    if (coverUrl) {
      const img = document.createElement('img');
      img.className = 'row-thumb';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      const fb = document.createElement('div');
      fb.className = 'row-thumb-fb is-hidden';
      fb.textContent = '♫';
      img.addEventListener('error', () => {
        img.classList.add('is-hidden');
        fb.classList.remove('is-hidden');
      });
      img.src = coverUrl;
      thumbWrap.append(img, fb);
    } else {
      const fb = document.createElement('div');
      fb.className = 'row-thumb-fb';
      fb.textContent = '♫';
      thumbWrap.appendChild(fb);
    }

    const metaWrap = document.createElement('div');
    metaWrap.className = 'row-title-meta';
    const titleEl = document.createElement('div');
    titleEl.className = 'row-title-text';
    titleEl.textContent = track.title || track.bvid || '未知曲目';
    titleEl.title = track.filePath || track.title || '';

    const subEl = document.createElement('div');
    subEl.className = 'row-sub-text';
    const parts = [];
    if (track.part && track.part !== track.title) parts.push(`P${track.p || 1} · ${track.part}`);
    if (track.bvid) parts.push(track.bvid);
    if (!track.fileExists) parts.push('未在本地目录发现文件');
    subEl.textContent = parts.join(' · ') || (track.relativePath || '本地音频');

    metaWrap.append(titleEl, subEl);
    titleCell.append(thumbWrap, metaWrap);
    tdTitle.appendChild(titleCell);

    // Quality
    const tdQuality = document.createElement('td');
    const qMeta = getQualityBadge(track);
    const qPill = document.createElement('span');
    qPill.className = `pill ${qMeta.cls}`;
    qPill.textContent = qMeta.label;
    tdQuality.appendChild(qPill);

    // Owner
    const tdOwner = document.createElement('td');
    const ownerDiv = document.createElement('div');
    ownerDiv.className = 'cell-ellipsis';
    ownerDiv.textContent = track.owner ? `@${track.owner}` : '-';
    tdOwner.appendChild(ownerDiv);

    // Plays (Total + breakdown)
    const tdPlays = document.createElement('td');
    const playsBox = document.createElement('div');
    playsBox.className = 'plays-cell';
    const totalLine = document.createElement('span');
    totalLine.className = 'plays-total mono';
    totalLine.textContent = `总 ${track.totalPlayCount || 0} 次`;
    const splitLine = document.createElement('span');
    splitLine.className = 'plays-split mono';
    splitLine.textContent = `网页 ${track.biliPlayCount || 0} · 软件 ${track.playerPlayCount || 0}`;
    playsBox.append(totalLine, splitLine);
    tdPlays.appendChild(playsBox);

    // Duration
    const tdDur = document.createElement('td');
    tdDur.className = 'mono';
    tdDur.textContent = formatHuman(track.totalPlayedSeconds || 0);

    // Ops
    const tdOps = document.createElement('td');
    const opsBox = document.createElement('div');
    opsBox.className = 'ops-cell';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn-icon';
    playBtn.title = track.fileExists ? '播放此曲' : '暂无本地文件';
    playBtn.textContent = '▶';
    playBtn.disabled = !track.fileExists;
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playTrackByKey(track.trackKey, { rebuildFromView: true });
    });

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = `btn-icon${track.favorite ? ' is-fav' : ''}`;
    favBtn.title = track.favorite ? '取消喜欢' : '添加到我喜欢';
    favBtn.textContent = track.favorite ? '♥' : '♡';
    favBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleTrackFavorite(track.trackKey);
    });

    const addPlBtn = document.createElement('button');
    addPlBtn.type = 'button';
    addPlBtn.className = 'btn-icon';
    addPlBtn.title = '添加到歌单';
    addPlBtn.textContent = '+';
    addPlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlaylistPicker(track.trackKey, addPlBtn);
    });

    opsBox.append(playBtn, favBtn, addPlBtn);

    if (state.activeView === 'playlist' && state.activePlaylistId) {
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn-icon';
      rmBtn.title = '从当前歌单移除';
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await apiJson(
          `/api/playlists/${encodeURIComponent(state.activePlaylistId)}/tracks`,
          {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', trackKey: track.trackKey }),
          }
        );
        if (res?.ok) {
          showToast('已从歌单移除', 'success');
          await fetchLibrary();
        }
      });
      opsBox.appendChild(rmBtn);
    }

    tdOps.appendChild(opsBox);
    tr.append(tdIdx, tdTitle, tdQuality, tdOwner, tdPlays, tdDur, tdOps);
    frag.appendChild(tr);
  });

  els.trackListBody.appendChild(frag);
}

function renderNowPlayingBar() {
  const track = state.currentTrackKey ? state.trackMap.get(state.currentTrackKey) : null;
  if (!track) {
    els.nowTitle.textContent = '未选择曲目';
    els.nowOwner.textContent = '选择任意本地歌曲开始播放';
    els.nowQuality.classList.add('is-hidden');
    els.nowStatsPill.classList.add('is-hidden');
    els.nowCover.classList.add('is-hidden');
    els.nowCoverFallback.classList.remove('is-hidden');
    els.btnNowFav.disabled = true;
    els.btnNowFav.textContent = '♡';
    els.btnNowFav.classList.remove('is-fav');
    els.btnPlayPause.textContent = '▶';
    return;
  }

  els.nowTitle.textContent = track.title || track.bvid || '未知曲目';
  els.nowOwner.textContent = track.owner ? `@${track.owner}` : (track.part || '本地音频');

  const qMeta = getQualityBadge(track);
  els.nowQuality.textContent = qMeta.label;
  els.nowQuality.className = `pill ${qMeta.cls}`;

  const threshold = Math.max(3, Number(state.settings?.countThresholdSeconds) || 15);
  const progressStr = state.sessionCounted
    ? '本次已计次'
    : `计时 ${Math.floor(state.sessionAccumSeconds)}/${threshold}s`;
  els.nowStatsPill.textContent = `总 ${track.totalPlayCount || 0} 次 (网页 ${track.biliPlayCount || 0} · 软件 ${track.playerPlayCount || 0}) · ${progressStr}`;
  els.nowStatsPill.classList.remove('is-hidden');

  const coverUrl = normalizeUrl(track.cover);
  if (coverUrl) {
    if (els.nowCover.dataset.src !== coverUrl) {
      els.nowCover.dataset.src = coverUrl;
      els.nowCover.src = coverUrl;
    }
    els.nowCover.classList.remove('is-hidden');
    els.nowCoverFallback.classList.add('is-hidden');
  } else {
    els.nowCover.classList.add('is-hidden');
    els.nowCoverFallback.classList.remove('is-hidden');
  }

  els.btnNowFav.disabled = false;
  els.btnNowFav.textContent = track.favorite ? '♥' : '♡';
  els.btnNowFav.classList.toggle('is-fav', Boolean(track.favorite));
  els.btnPlayPause.textContent = els.audioEl.paused ? '▶' : '⏸';
}

function renderQueueDrawer() {
  els.queueCount.textContent = String(state.queue.length);
  els.queueList.replaceChildren();

  const frag = document.createDocumentFragment();
  state.queue.forEach((key, idx) => {
    const track = state.trackMap.get(key);
    if (!track) return;
    const li = document.createElement('li');
    li.className = `queue-item${key === state.currentTrackKey ? ' is-active' : ''}`;
    li.addEventListener('click', () => {
      state.queueIndex = idx;
      playTrackByKey(key, { pushHistory: true });
    });

    const num = document.createElement('span');
    num.className = 'mono';
    num.style.width = '20px';
    num.style.color = 'var(--text-muted)';
    num.textContent = key === state.currentTrackKey ? '▶' : String(idx + 1);

    const info = document.createElement('div');
    info.className = 'queue-item-info';
    const title = document.createElement('div');
    title.className = 'queue-item-title';
    title.textContent = track.title || track.bvid || '未知曲目';
    const owner = document.createElement('div');
    owner.className = 'queue-item-owner';
    owner.textContent = track.owner ? `@${track.owner}` : '本地音频';
    info.append(title, owner);

    li.append(num, info);
    frag.appendChild(li);
  });

  els.queueList.appendChild(frag);
}

async function refreshLeaderboard() {
  const res = await apiJson(
    `/api/leaderboard?sortBy=${encodeURIComponent(state.lbSortBy)}&sourceFilter=${encodeURIComponent(state.lbSource)}&limit=100`
  );
  if (!res?.ok) return;
  const s = res.summary || {};
  els.lbKpiTracks.textContent = String(s.totalTracks || 0);
  els.lbKpiTotalPlays.textContent = String(s.totalPlayCount || 0);
  els.lbKpiPlayerStats.textContent = `${s.playerPlayCount || 0} 次 · ${formatHuman(s.playerPlayedSeconds || 0)}`;
  els.lbKpiBiliStats.textContent = `${s.biliPlayCount || 0} 次 · ${formatHuman(s.biliPlayedSeconds || 0)}`;

  const items = Array.isArray(res.items) ? res.items : [];
  els.lbList.replaceChildren();
  if (items.length === 0) {
    els.lbEmpty.classList.remove('is-hidden');
    return;
  }
  els.lbEmpty.classList.add('is-hidden');

  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'lb-card';
    li.addEventListener('click', () => {
      if (item.fileExists) {
        playTrackByKey(item.trackKey, { rebuildFromView: true });
      } else {
        showToast('该曲目仅在网页端播放过，尚未下载到本地目录', 'info');
      }
    });

    const rank = document.createElement('span');
    const r = idx + 1;
    rank.className = `lb-rank mono${r <= 3 ? ` rank-${r}` : ''}`;
    rank.textContent = String(r);

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'row-thumb-wrap';
    const coverUrl = normalizeUrl(item.cover);
    if (coverUrl) {
      const img = document.createElement('img');
      img.className = 'row-thumb';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = coverUrl;
      thumbWrap.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'row-thumb-fb';
      fb.textContent = '♫';
      thumbWrap.appendChild(fb);
    }

    const info = document.createElement('div');
    info.className = 'lb-info';
    const title = document.createElement('div');
    title.className = 'row-title-text';
    title.textContent = item.title || item.bvid || '未知曲目';
    const sub = document.createElement('div');
    sub.className = 'row-sub-text';
    sub.textContent = `${item.owner ? `@${item.owner}` : '本地'} · 网页 ${item.biliPlayCount || 0} 次 / 软件 ${item.playerPlayCount || 0} 次`;
    info.append(title, sub);

    const metrics = document.createElement('div');
    metrics.className = 'lb-metrics';
    const countVal = state.lbSource === 'player'
      ? item.playerPlayCount || 0
      : state.lbSource === 'bili'
        ? item.biliPlayCount || 0
        : item.totalPlayCount || 0;
    const secVal = state.lbSource === 'player'
      ? item.playerPlayedSeconds || 0
      : state.lbSource === 'bili'
        ? item.biliPlayedSeconds || 0
        : item.totalPlayedSeconds || 0;

    const mCount = document.createElement('div');
    mCount.className = 'plays-total mono';
    mCount.textContent = `${countVal} 次`;
    const mDur = document.createElement('div');
    mDur.className = 'plays-split mono';
    mDur.textContent = formatHuman(secVal);
    metrics.append(mCount, mDur);

    li.append(rank, thumbWrap, info, metrics);
    frag.appendChild(li);
  });

  els.lbList.appendChild(frag);
}

function switchView(view, playlistId = null) {
  state.activeView = view;
  state.activePlaylistId = view === 'playlist' ? playlistId : null;

  for (const btn of els.navItems) {
    const active = btn.dataset.view === view;
    btn.classList.toggle('is-active', active);
  }
  renderPlaylistsNav();

  const isLeaderboard = view === 'leaderboard';
  els.viewTracks.classList.toggle('is-active', !isLeaderboard);
  els.viewLeaderboard.classList.toggle('is-active', isLeaderboard);

  if (isLeaderboard) {
    els.viewTitle.textContent = '听歌排行榜';
    els.viewSubtitle.textContent = '汇总「B站网页端 + 桌面播放器」播放次数与时长';
    refreshLeaderboard();
  } else {
    renderTrackTable();
  }
}

async function toggleTrackFavorite(trackKey) {
  const res = await apiJson('/api/tracks/favorite', {
    method: 'POST',
    body: JSON.stringify({ trackKey }),
  });
  if (res?.ok && res.track) {
    applyUpdatedTrack(res.track, res.summary);
    showToast(res.track.favorite ? '已添加到我喜欢 ♥' : '已取消喜欢', 'success');
  }
}

function openPlaylistForm(editingId = null, initialName = '') {
  state.editingPlaylistId = editingId;
  els.playlistNameInput.value = initialName;
  els.playlistForm.classList.remove('is-hidden');
  els.playlistNameInput.focus();
}

function closePlaylistForm() {
  state.editingPlaylistId = null;
  els.playlistNameInput.value = '';
  els.playlistForm.classList.add('is-hidden');
}

function openPlaylistPicker(trackKey, anchorBtn) {
  if (state.playlists.length === 0) {
    showToast('请先在左侧点击「+ 新建」创建歌单', 'info');
    openPlaylistForm();
    return;
  }
  state.pickerTrackKey = trackKey;
  els.playlistPickerList.replaceChildren();
  const frag = document.createDocumentFragment();

  for (const pl of state.playlists) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popover-item-btn';
    const exists = (pl.trackKeys || []).includes(trackKey);
    btn.textContent = `${exists ? '✓ ' : '+ '}${pl.name}`;
    btn.addEventListener('click', async () => {
      const res = await apiJson(`/api/playlists/${encodeURIComponent(pl.id)}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ trackKeys: [trackKey] }),
      });
      closePlaylistPicker();
      if (res?.ok) {
        showToast(`已添加到歌单「${pl.name}」`, 'success');
        await fetchLibrary();
      }
    });
    li.appendChild(btn);
    frag.appendChild(li);
  }
  els.playlistPickerList.appendChild(frag);

  const rect = anchorBtn.getBoundingClientRect();
  els.playlistPickerPopover.style.left = `${Math.max(12, Math.min(window.innerWidth - 224, rect.right - 210))}px`;
  els.playlistPickerPopover.style.top = `${Math.min(window.innerHeight - 260, rect.bottom + 6)}px`;
  els.playlistPickerPopover.classList.remove('is-hidden');
}

function closePlaylistPicker() {
  state.pickerTrackKey = null;
  els.playlistPickerPopover.classList.add('is-hidden');
}

function renderSettingsDrawer() {
  if (document.activeElement !== els.settingMusicDirs) {
    els.settingMusicDirs.value = (state.settings.musicDirs || []).join('\n');
  }
  if (document.activeElement !== els.settingThreshold) {
    els.settingThreshold.value = String(state.settings.countThresholdSeconds || 15);
  }
}

async function fetchLibrary() {
  const data = await apiJson('/api/library');
  if (!data?.ok) return;
  state.libraryRevision = data.libraryRevision || 1;
  state.lastExtensionSyncAt = data.lastExtensionSyncAt || null;
  state.settings = data.settings || state.settings;
  state.summary = data.summary || {};
  state.tracks = Array.isArray(data.tracks) ? data.tracks : [];
  state.trackMap = new Map(state.tracks.map((t) => [t.trackKey, t]));
  state.playlists = Array.isArray(data.playlists) ? data.playlists : [];

  renderSidebarCounts();
  renderPlaylistsNav();
  renderSettingsDrawer();
  renderNowPlayingBar();
  renderQueueDrawer();

  if (state.activeView === 'leaderboard') {
    await refreshLeaderboard();
  } else {
    renderTrackTable();
  }
}

async function pollServerStatus() {
  try {
    const res = await apiJson('/api/status');
    if (!res?.ok) return;
    state.lastExtensionSyncAt = res.lastExtensionSyncAt || state.lastExtensionSyncAt;
    renderSyncStatus();
    if (res.libraryRevision && res.libraryRevision !== state.libraryRevision) {
      await fetchLibrary();
    }
  } catch (_) {}
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    if (!els.playlistPickerPopover.classList.contains('is-hidden') && !els.playlistPickerPopover.contains(e.target)) {
      closePlaylistPicker();
    }
  });

  els.nowCover.addEventListener('error', () => {
    els.nowCover.classList.add('is-hidden');
    els.nowCoverFallback.classList.remove('is-hidden');
  });

  // 左侧导航
  for (const btn of els.navItems) {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view || 'all');
    });
  }

  // 刷新扫描
  els.btnRescan.addEventListener('click', async () => {
    els.btnRescan.disabled = true;
    const res = await apiJson('/api/library/rescan', { method: 'POST', body: '{}' });
    els.btnRescan.disabled = false;
    if (res?.ok) {
      await fetchLibrary();
      showToast(`扫描完成：共 ${res.summary?.playableTracks || 0} 首可播音频`, 'success');
    } else {
      showToast(res?.error || '扫描失败', 'error');
    }
  });

  // 歌单创建/重命名
  els.btnNewPlaylist.addEventListener('click', () => openPlaylistForm());
  els.btnPlaylistCancel.addEventListener('click', closePlaylistForm);
  els.playlistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.playlistNameInput.value.trim();
    if (!name) {
      showToast('请输入歌单名称', 'error');
      return;
    }
    if (state.editingPlaylistId) {
      const res = await apiJson(`/api/playlists/${encodeURIComponent(state.editingPlaylistId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      if (res?.ok) {
        showToast('歌单已重命名', 'success');
        closePlaylistForm();
        await fetchLibrary();
      }
    } else {
      const res = await apiJson('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (res?.ok) {
        showToast(`已创建歌单「${name}」`, 'success');
        closePlaylistForm();
        await fetchLibrary();
        if (res.playlist?.id) switchView('playlist', res.playlist.id);
      }
    }
  });

  // 顶部快捷播放与随机播放按钮
  els.btnPlayAll.addEventListener('click', async () => {
    const viewTracks = getTracksForView();
    const playable = getPlayableKeys(viewTracks);
    if (playable.length === 0) {
      showToast('当前列表没有可播放的本地音频', 'error');
      return;
    }
    setPlayMode(PLAY_MODE.LIST_LOOP, { reshuffle: false, announce: false });
    rebuildQueue({ mode: PLAY_MODE.LIST_LOOP, sourceTracks: viewTracks, anchorKey: playable[0] });
    await playTrackByKey(playable[0], { pushHistory: false });
  });

  els.btnShuffleList.addEventListener('click', async () => {
    const viewTracks = getTracksForView();
    const playable = getPlayableKeys(viewTracks);
    if (playable.length === 0) {
      showToast('当前列表没有可播放的本地音频', 'error');
      return;
    }
    setPlayMode(PLAY_MODE.PLAYLIST_SHUFFLE, { reshuffle: false, announce: false });
    rebuildQueue({ mode: PLAY_MODE.PLAYLIST_SHUFFLE, sourceTracks: viewTracks, anchorKey: null });
    showToast(`已开启当前列表随机播放 (${state.queue.length} 首)`, 'success');
    await playTrackByKey(state.queue[0], { pushHistory: false });
  });

  els.btnShuffleAll.addEventListener('click', async () => {
    const playable = getPlayableKeys(state.tracks);
    if (playable.length === 0) {
      showToast('本地曲库暂无可播放音频', 'error');
      return;
    }
    setPlayMode(PLAY_MODE.ALL_SHUFFLE, { reshuffle: false, announce: false });
    rebuildQueue({ mode: PLAY_MODE.ALL_SHUFFLE, anchorKey: null });
    showToast(`已开启全部音乐随机播放 (${state.queue.length} 首)`, 'success');
    await playTrackByKey(state.queue[0], { pushHistory: false });
  });

  els.searchInput.addEventListener('input', () => {
    state.searchQuery = els.searchInput.value || '';
    if (state.activeView !== 'leaderboard') {
      renderTrackTable();
    }
  });

  // 设置面板
  els.btnToggleSettings.addEventListener('click', () => {
    els.settingsPanel.classList.toggle('is-hidden');
  });

  els.btnSaveSettings.addEventListener('click', async () => {
    const dirs = els.settingMusicDirs.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const threshold = Math.min(300, Math.max(3, Math.round(Number(els.settingThreshold.value) || 15)));
    const res = await apiJson('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ musicDirs: dirs, countThresholdSeconds: threshold }),
    });
    if (res?.ok) {
      await fetchLibrary();
      showToast('设置已保存并重新扫描目录', 'success');
      els.settingsPanel.classList.add('is-hidden');
    } else {
      showToast(res?.error || '保存设置失败', 'error');
    }
  });

  // 排行榜筛选
  for (const btn of els.sourceButtons) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.source || 'all';
      if (next === state.lbSource) return;
      state.lbSource = next;
      for (const b of els.sourceButtons) {
        b.classList.toggle('is-active', b.dataset.source === next);
      }
      refreshLeaderboard();
    });
  }

  els.lbSort.addEventListener('change', () => {
    state.lbSortBy = els.lbSort.value || 'totalPlayCount';
    refreshLeaderboard();
  });

  // 队列抽屉
  els.btnToggleQueue.addEventListener('click', () => {
    state.queueOpen = !state.queueOpen;
    els.queueDrawer.classList.toggle('is-hidden', !state.queueOpen);
  });
  els.btnCloseQueue.addEventListener('click', () => {
    state.queueOpen = false;
    els.queueDrawer.classList.add('is-hidden');
  });
  els.btnReshuffleQueue.addEventListener('click', () => {
    if (state.playMode !== PLAY_MODE.ALL_SHUFFLE && state.playMode !== PLAY_MODE.PLAYLIST_SHUFFLE) {
      setPlayMode(PLAY_MODE.PLAYLIST_SHUFFLE, { reshuffle: true, announce: false });
    } else {
      rebuildQueue({ mode: state.playMode, anchorKey: state.currentTrackKey });
    }
    showToast('已重新随机洗牌播放队列', 'success');
  });

  // 底部播放控制
  els.btnPlayMode.addEventListener('click', () => {
    const idx = PLAY_MODE_ORDER.indexOf(state.playMode);
    const nextMode = PLAY_MODE_ORDER[(idx + 1) % PLAY_MODE_ORDER.length];
    setPlayMode(nextMode);
  });

  els.btnPlayPause.addEventListener('click', async () => {
    if (!state.currentTrackKey) {
      await playNextTrack();
      return;
    }
    if (els.audioEl.paused) {
      await els.audioEl.play().catch(() => {});
    } else {
      els.audioEl.pause();
    }
  });

  els.btnPrev.addEventListener('click', () => playPrevTrack());
  els.btnNext.addEventListener('click', () => playNextTrack({ autoTriggered: false }));

  els.btnPlaybackRate.addEventListener('click', () => {
    state.playbackRateIndex = (state.playbackRateIndex + 1) % RATES.length;
    const rate = RATES[state.playbackRateIndex];
    els.audioEl.playbackRate = rate;
    els.btnPlaybackRate.textContent = `${rate}x`;
  });

  els.btnNowFav.addEventListener('click', async () => {
    if (state.currentTrackKey) {
      await toggleTrackFavorite(state.currentTrackKey);
    }
  });

  els.btnMute.addEventListener('click', () => {
    els.audioEl.muted = !els.audioEl.muted;
    els.btnMute.textContent = els.audioEl.muted ? '🔇' : '🔊';
  });

  els.volumeBar.addEventListener('input', () => {
    els.audioEl.volume = Number(els.volumeBar.value);
    if (els.audioEl.volume > 0 && els.audioEl.muted) {
      els.audioEl.muted = false;
      els.btnMute.textContent = '🔊';
    }
  });

  els.seekBar.addEventListener('input', () => {
    state.isSeeking = true;
    els.timeCurrent.textContent = formatClock(els.seekBar.value);
  });

  els.seekBar.addEventListener('change', () => {
    els.audioEl.currentTime = Number(els.seekBar.value) || 0;
    state.isSeeking = false;
    state.lastWallClockMs = performance.now();
  });

  // <audio> 事件与真实听歌计时
  els.audioEl.addEventListener('play', () => {
    state.lastWallClockMs = performance.now();
    renderNowPlayingBar();
  });

  els.audioEl.addEventListener('pause', () => {
    flushPlaybackProgress(false);
    renderNowPlayingBar();
  });

  els.audioEl.addEventListener('ended', async () => {
    await flushPlaybackProgress(false);
    await playNextTrack({ autoTriggered: true });
  });

  els.audioEl.addEventListener('loadedmetadata', () => {
    const dur = Number.isFinite(els.audioEl.duration) ? els.audioEl.duration : 0;
    els.seekBar.max = String(dur || 100);
    els.timeTotal.textContent = formatClock(dur);
  });

  els.audioEl.addEventListener('timeupdate', () => {
    if (!state.isSeeking) {
      els.seekBar.value = String(els.audioEl.currentTime || 0);
      els.timeCurrent.textContent = formatClock(els.audioEl.currentTime || 0);
    }
  });

  els.audioEl.addEventListener('error', () => {
    showToast('音频解码失败，跳过至下一首', 'error');
    playNextTrack({ autoTriggered: false });
  });

  setInterval(() => {
    if (!state.currentTrackKey || els.audioEl.paused || els.audioEl.ended) {
      state.lastWallClockMs = performance.now();
      return;
    }
    const now = performance.now();
    const rawElapsed = (now - (state.lastWallClockMs || now)) / 1000;
    state.lastWallClockMs = now;
    const step = Math.min(2.5, Math.max(0, rawElapsed));
    if (step <= 0) return;

    state.sessionAccumSeconds += step;
    state.sessionPendingFlush += step;
    renderNowPlayingBar();

    const threshold = Math.max(3, Number(state.settings?.countThresholdSeconds) || 15);
    const shouldFlushCount = !state.sessionCounted && state.sessionAccumSeconds >= threshold;
    if (shouldFlushCount || state.sessionPendingFlush >= 5) {
      flushPlaybackProgress(shouldFlushCount);
    }
  }, 1000);

  setInterval(pollServerStatus, 4000);
  window.addEventListener('pagehide', () => flushPlaybackProgress(false));
}

function init() {
  els.syncStatusDot = $('sync-status-dot');
  els.syncStatusText = $('sync-status-text');
  els.btnRescan = $('btn-rescan');
  els.navItems = Array.from(document.querySelectorAll('.nav-item'));
  els.countAll = $('count-all');
  els.countFav = $('count-fav');
  els.btnNewPlaylist = $('btn-new-playlist');
  els.playlistForm = $('playlist-form');
  els.playlistNameInput = $('playlist-name-input');
  els.btnPlaylistSave = $('btn-playlist-save');
  els.btnPlaylistCancel = $('btn-playlist-cancel');
  els.playlistNavList = $('playlist-nav-list');

  els.viewTitle = $('view-title');
  els.viewSubtitle = $('view-subtitle');
  els.btnPlayAll = $('btn-play-all');
  els.btnShuffleList = $('btn-shuffle-list');
  els.btnShuffleAll = $('btn-shuffle-all');
  els.searchInput = $('search-input');
  els.btnToggleSettings = $('btn-toggle-settings');
  els.settingsPanel = $('settings-panel');
  els.settingMusicDirs = $('setting-music-dirs');
  els.settingThreshold = $('setting-threshold');
  els.btnSaveSettings = $('btn-save-settings');

  els.viewTracks = $('view-tracks');
  els.tracksEmpty = $('tracks-empty');
  els.trackListBody = $('track-list-body');

  els.viewLeaderboard = $('view-leaderboard');
  els.lbKpiTracks = $('lb-kpi-tracks');
  els.lbKpiTotalPlays = $('lb-kpi-total-plays');
  els.lbKpiPlayerStats = $('lb-kpi-player-stats');
  els.lbKpiBiliStats = $('lb-kpi-bili-stats');
  els.sourceButtons = Array.from(document.querySelectorAll('.source-btn'));
  els.lbSort = $('lb-sort');
  els.lbEmpty = $('lb-empty');
  els.lbList = $('lb-list');

  els.queueDrawer = $('queue-drawer');
  els.queueModeLabel = $('queue-mode-label');
  els.queueCount = $('queue-count');
  els.btnReshuffleQueue = $('btn-reshuffle-queue');
  els.btnCloseQueue = $('btn-close-queue');
  els.queueList = $('queue-list');

  els.nowCover = $('now-cover');
  els.nowCoverFallback = $('now-cover-fallback');
  els.nowTitle = $('now-title');
  els.nowQuality = $('now-quality');
  els.nowOwner = $('now-owner');
  els.nowStatsPill = $('now-stats-pill');
  els.btnNowFav = $('btn-now-fav');
  els.btnPlayMode = $('btn-play-mode');
  els.btnPrev = $('btn-prev');
  els.btnPlayPause = $('btn-play-pause');
  els.btnNext = $('btn-next');
  els.btnPlaybackRate = $('btn-playback-rate');
  els.timeCurrent = $('time-current');
  els.seekBar = $('seek-bar');
  els.timeTotal = $('time-total');
  els.btnMute = $('btn-mute');
  els.volumeBar = $('volume-bar');
  els.btnToggleQueue = $('btn-toggle-queue');

  els.playlistPickerPopover = $('playlist-picker-popover');
  els.playlistPickerList = $('playlist-picker-list');
  els.toast = $('toast');
  els.audioEl = $('audio-el');
  els.audioEl.volume = Number(els.volumeBar.value) || 0.85;

  bindEvents();
  renderPlayModeButton();
  fetchLibrary();
}

document.addEventListener('DOMContentLoaded', init);
