/**
 * @fileoverview Popup 控制台脚本：模式切换、实时音轨状态展示、手动触发下载、参数设置与听歌排行榜。
 */

import {
  WORK_MODE,
  DOWNLOAD_STATUS,
  MSG_TARGET,
  ACTION,
  DEFAULT_SETTINGS,
  MODE_UI_META,
  getQualityInfo,
  compareQuality,
} from '../common/constants.js';
import { sendToBackground, isEnvelopeFor } from '../common/messaging.js';

const DOWNLOAD_STATUS_META = Object.freeze({
  [DOWNLOAD_STATUS.IDLE]: { text: '未归档', cls: 'pill-muted' },
  [DOWNLOAD_STATUS.CHECKING]: { text: '预检去重中...', cls: 'pill-high' },
  [DOWNLOAD_STATUS.DOWNLOADING]: { text: '原流拉取落盘中...', cls: 'pill-high' },
  [DOWNLOAD_STATUS.COMPLETED]: { text: '已归档 .m4a', cls: 'pill-green' },
  [DOWNLOAD_STATUS.UPGRADED]: { text: '已升级更高音质', cls: 'pill-green' },
  [DOWNLOAD_STATUS.SKIPPED]: { text: '本地已有同级/更高音质', cls: 'pill-green' },
  [DOWNLOAD_STATUS.UNSUPPORTED_DURL]: { text: '老版流暂不支持提取', cls: 'pill-muted' },
  [DOWNLOAD_STATUS.ERROR]: { text: '捕获失败', cls: 'pill-red' },
});

const state = {
  activeTab: 'live',
  tabId: null,
  settings: { ...DEFAULT_SETTINGS },
  tabState: null,
  dbTrack: null,
  playerSyncState: null,
  lbDays: 0,
  lbSortBy: 'totalPlayedSeconds',
  clearConfirmTimer: null,
  toastTimer: null,
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

function formatDurationClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatDurationHuman(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${sec % 60}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h${remM}m` : `${h}h`;
}

function getBasename(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function showToast(message, variant = 'info') {
  if (!els.toast) return;
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast ${variant === 'success' ? 'is-success' : variant === 'error' ? 'is-error' : ''}`;
  state.toastTimer = setTimeout(() => {
    els.toast.classList.add('is-hidden');
  }, 2600);
}

function renderCoverImage(imgEl, fallbackEl, rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    imgEl.classList.add('is-hidden');
    imgEl.removeAttribute('src');
    fallbackEl.classList.remove('is-hidden');
    return;
  }
  if (imgEl.dataset.currentUrl !== url) {
    imgEl.dataset.currentUrl = url;
    imgEl.src = url;
  }
  imgEl.classList.remove('is-hidden');
  fallbackEl.classList.add('is-hidden');
}

function renderModeControls() {
  const mode = state.settings?.mode || WORK_MODE.STATS_ONLY;
  const meta = MODE_UI_META[mode] || MODE_UI_META[WORK_MODE.STATS_ONLY];

  if (els.brandIcon && meta.iconPaths?.[48]) {
    els.brandIcon.src = `../../${meta.iconPaths[48]}`;
  }

  els.modePill.textContent = meta.badgeText;
  els.modePill.className = `mode-pill ${
    mode === WORK_MODE.STATS_ONLY ? 'mode-stat' : mode === WORK_MODE.PAUSED ? 'mode-off' : 'mode-auto'
  }`;

  for (const btn of els.modeButtons) {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  }
}

function renderSettingsForm() {
  const s = state.settings || DEFAULT_SETTINGS;
  if (document.activeElement !== els.settingThreshold) {
    els.settingThreshold.value = String(Number(s.autoCaptureThresholdSeconds) || 15);
  }
  if (document.activeElement !== els.settingSubfolder) {
    els.settingSubfolder.value = s.archiveSubfolder ?? 'BiliMusic';
  }
  els.settingUpgrade.checked = Boolean(s.enableQualityUpgrade);
  els.settingMultipart.checked = Boolean(s.groupMultiPartInSubdir);
}

function renderQualityBadge(tabState) {
  if (tabState.hasDurl && !tabState.bestAudio) {
    els.qualityBadge.textContent = '老版 durl 流 (无 DASH 音轨)';
    els.qualityBadge.className = 'pill pill-muted';
    return;
  }
  if (!tabState.bestAudio) {
    els.qualityBadge.textContent = tabState.matched ? '未找到音轨' : '等待捕获 playurl 音轨...';
    els.qualityBadge.className = 'pill pill-muted';
    return;
  }
  const q = tabState.qualityInfo || getQualityInfo(tabState.bestAudio.id, tabState.bestAudio.codecs);
  els.qualityBadge.textContent = `${q.label} · ${q.codecLabel}`;
  if (q.id === 30251) {
    els.qualityBadge.className = 'pill pill-hires';
  } else if (q.id === 30250) {
    els.qualityBadge.className = 'pill pill-dolby';
  } else if (q.weight >= 300) {
    els.qualityBadge.className = 'pill pill-high';
  } else {
    els.qualityBadge.className = 'pill pill-muted';
  }
}

function renderPlayerSyncStatus() {
  if (!els.playerSyncDot || !els.playerSyncText) return;
  const sync = state.playerSyncState;
  const isOnline = Boolean(sync && sync.online);
  els.playerSyncDot.classList.toggle('is-online', isOnline);
  if (sync?.disabled) {
    els.playerSyncText.textContent = '桌面播放器联动已关闭';
  } else if (isOnline) {
    const count = sync.playerSummary?.totalTracks;
    els.playerSyncText.textContent = count != null ? `桌面播放器已联机 (${count} 首)` : '桌面播放器已联机';
  } else {
    els.playerSyncText.textContent = '桌面播放器未连接';
  }
}

function renderLiveTrack() {
  const tab = state.tabState;
  if (!tab || !tab.meta || !tab.meta.bvid) {
    els.emptyTrackState.classList.remove('is-hidden');
    els.trackCard.classList.add('is-hidden');
    return;
  }

  els.emptyTrackState.classList.add('is-hidden');
  els.trackCard.classList.remove('is-hidden');

  const meta = tab.meta;
  renderCoverImage(els.trackCover, els.trackCoverFallback, meta.cover);
  els.trackTitle.textContent = meta.title || meta.bvid;
  els.trackTitle.title = meta.title || '';

  const totalParts = Number(meta.totalParts) || 1;
  const p = Number(meta.p) || 1;
  if (totalParts > 1 || (meta.part && meta.part !== meta.title)) {
    els.trackPart.textContent = `P${p}/${totalParts}${meta.part ? ` · ${meta.part}` : ''}`;
    els.trackPart.classList.remove('is-hidden');
  } else {
    els.trackPart.classList.add('is-hidden');
  }

  els.trackOwner.textContent = meta.owner ? `@${meta.owner}` : 'UP主未知';
  els.trackBvid.textContent = meta.bvid;

  renderQualityBadge(tab);

  const dlStatus = tab.downloadStatus || DOWNLOAD_STATUS.IDLE;
  const statusMeta = DOWNLOAD_STATUS_META[dlStatus] || DOWNLOAD_STATUS_META[DOWNLOAD_STATUS.IDLE];
  els.downloadStatusPill.textContent = statusMeta.text;
  els.downloadStatusPill.className = `pill ${statusMeta.cls}`;

  // 播放阈值进度条
  const threshold = Math.max(3, Number(state.settings?.autoCaptureThresholdSeconds) || 15);
  const accum = Number(tab.sessionAccumulatedSeconds) || 0;
  const pct = tab.sessionCounted ? 100 : Math.min(100, Math.round((accum / threshold) * 100));
  els.thresholdBar.style.width = `${pct}%`;
  els.thresholdBar.classList.toggle('is-done', Boolean(tab.sessionCounted));

  if (state.settings?.mode === WORK_MODE.PAUSED) {
    els.thresholdText.textContent = '暂停待机中';
  } else if (tab.sessionCounted) {
    els.thresholdText.textContent = `已达标 (${accum.toFixed(0)}s)`;
  } else {
    els.thresholdText.textContent = `${accum.toFixed(1)} / ${threshold}s`;
  }

  const stats = tab.trackStats || {};
  const playCount = Number(stats.playCount ?? state.dbTrack?.playCount ?? 0);
  const biliCount = Number(stats.biliPlayCount ?? state.dbTrack?.biliPlayCount ?? playCount);
  const playerCount = Number(stats.playerPlayCount ?? state.dbTrack?.playerPlayCount ?? 0);
  const totalSec = Number(stats.totalPlayedSeconds ?? state.dbTrack?.totalPlayedSeconds ?? 0);
  const breakdown = playerCount > 0 ? ` (网页 ${biliCount} · 播放器 ${playerCount})` : '';
  els.trackStatsLine.textContent = `累计有效播放 ${playCount} 次${breakdown} · 累计听歌 ${formatDurationClock(totalSec)}`;

  const filename = stats.filename || state.dbTrack?.filename || '';
  if (filename) {
    const dlQId = stats.downloadedQualityId ?? state.dbTrack?.qualityId;
    const dlQLabel = dlQId ? getQualityInfo(dlQId).shortLabel : '';
    els.trackFilenameLine.textContent = `本地归档${dlQLabel ? ` [${dlQLabel}]` : ''}: ${getBasename(filename)}`;
    els.trackFilenameLine.title = filename;
    els.trackFilenameLine.classList.remove('is-hidden');
  } else {
    els.trackFilenameLine.classList.add('is-hidden');
  }

  if (dlStatus === DOWNLOAD_STATUS.ERROR && tab.downloadError) {
    els.downloadErrorBox.textContent = `错误详情: ${tab.downloadError}`;
    els.downloadErrorBox.classList.remove('is-hidden');
  } else {
    els.downloadErrorBox.classList.add('is-hidden');
  }

  // 手动下载按钮文案与禁用态
  const btn = els.btnManualDownload;
  const savedQualityId = stats.downloadedQualityId ?? state.dbTrack?.qualityId;
  const canUpgrade =
    dlStatus === DOWNLOAD_STATUS.COMPLETED &&
    tab.bestAudio &&
    savedQualityId != null &&
    compareQuality(tab.bestAudio.id, savedQualityId) > 0;

  if (dlStatus === DOWNLOAD_STATUS.DOWNLOADING || dlStatus === DOWNLOAD_STATUS.CHECKING) {
    btn.disabled = true;
    btn.textContent = '正在后台拉取原流...';
  } else if (tab.hasDurl && !tab.bestAudio) {
    btn.disabled = true;
    btn.textContent = '老版 durl 流暂不支持提取';
  } else if (!tab.bestAudio) {
    btn.disabled = true;
    btn.textContent = '等待页面捕获音轨...';
  } else if (canUpgrade) {
    btn.disabled = false;
    btn.textContent = `立即升级更高音质 (${getQualityInfo(tab.bestAudio.id).shortLabel})`;
  } else if (dlStatus === DOWNLOAD_STATUS.COMPLETED || dlStatus === DOWNLOAD_STATUS.UPGRADED) {
    btn.disabled = false;
    btn.textContent = '重新校验 / 再次下载 (.m4a)';
  } else {
    btn.disabled = false;
    btn.textContent = '立即下载原流 (.m4a)';
  }
}

function renderLeaderboard(payload) {
  const summary = payload?.summary || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];

  els.kpiTracks.textContent = String(summary.totalTracks || 0);
  els.kpiPlays.textContent = String(summary.totalPlayCount || 0);
  els.kpiDuration.textContent = formatDurationHuman(summary.totalPlayedSeconds || 0);

  els.lbList.replaceChildren();
  if (items.length === 0) {
    els.lbEmpty.classList.remove('is-hidden');
    return;
  }
  els.lbEmpty.classList.add('is-hidden');

  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'lb-item';

    const rankEl = document.createElement('span');
    const rankNum = idx + 1;
    rankEl.className = `lb-rank mono${rankNum <= 3 ? ` rank-${rankNum}` : ''}`;
    rankEl.textContent = String(rankNum);

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'lb-thumb-wrap';
    const coverUrl = normalizeUrl(item.cover);
    if (coverUrl) {
      const img = document.createElement('img');
      img.className = 'lb-thumb';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      const fb = document.createElement('div');
      fb.className = 'lb-thumb-fallback is-hidden';
      fb.textContent = '♫';
      img.addEventListener('error', () => {
        img.classList.add('is-hidden');
        fb.classList.remove('is-hidden');
      });
      img.src = coverUrl;
      thumbWrap.append(img, fb);
    } else {
      const fb = document.createElement('div');
      fb.className = 'lb-thumb-fallback';
      fb.textContent = '♫';
      thumbWrap.appendChild(fb);
    }

    const info = document.createElement('div');
    info.className = 'lb-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'lb-title';
    titleEl.textContent = item.title || item.bvid;
    titleEl.title = item.part && item.part !== item.title ? `${item.title} (${item.part})` : item.title || '';

    const sub = document.createElement('div');
    sub.className = 'lb-sub';

    const ownerEl = document.createElement('span');
    ownerEl.className = 'lb-owner';
    ownerEl.textContent = item.owner ? `@${item.owner}` : item.bvid;
    sub.appendChild(ownerEl);

    if (item.downloadId != null) {
      const tag = document.createElement('span');
      tag.className = 'lb-tag';
      tag.textContent = item.qualityId ? `${getQualityInfo(item.qualityId).shortLabel} ✓` : '已归档';
      sub.appendChild(tag);
    }
    info.append(titleEl, sub);

    const metrics = document.createElement('div');
    metrics.className = 'lb-metrics';
    const playsEl = document.createElement('div');
    playsEl.className = 'lb-plays mono';
    const playerCnt = Number(item.playerPlayCount) || 0;
    playsEl.textContent = `${item.playCount || 0} 次`;
    if (playerCnt > 0) {
      const biliCnt = Number(item.biliPlayCount ?? ((item.playCount || 0) - playerCnt));
      playsEl.title = `B站网页 ${biliCnt} 次 + 桌面播放器 ${playerCnt} 次`;
    }
    const durEl = document.createElement('div');
    durEl.className = 'lb-dur mono';
    durEl.textContent = formatDurationHuman(item.totalPlayedSeconds || 0);
    metrics.append(playsEl, durEl);

    li.append(rankEl, thumbWrap, info, metrics);
    frag.appendChild(li);
  });

  els.lbList.appendChild(frag);
}

async function refreshPopupState() {
  const res = await sendToBackground(ACTION.GET_POPUP_STATE, {});
  if (!res?.ok) {
    showToast(res?.error || '读取扩展状态失败', 'error');
    return;
  }
  const payload = res.data || res;
  if (payload.settings) state.settings = payload.settings;
  state.tabId = payload.tabId ?? null;
  state.tabState = payload.tabState ?? null;
  state.dbTrack = payload.dbTrack ?? null;
  if (payload.playerSyncState !== undefined) {
    state.playerSyncState = payload.playerSyncState;
  }

  renderModeControls();
  renderSettingsForm();
  renderPlayerSyncStatus();
  renderLiveTrack();
}

async function refreshPlayerSyncStatus() {
  const res = await sendToBackground(ACTION.GET_PLAYER_SYNC_STATUS, {});
  const syncState = res?.syncState || res?.data?.syncState;
  if (syncState) {
    state.playerSyncState = syncState;
    renderPlayerSyncStatus();
  }
}

async function refreshLeaderboard() {
  const res = await sendToBackground(ACTION.GET_LEADERBOARD, {
    days: state.lbDays,
    sortBy: state.lbSortBy,
    limit: 60,
  });
  if (!res?.ok) {
    showToast(res?.error || '读取排行榜失败', 'error');
    return;
  }
  renderLeaderboard(res.data || res);
}

async function persistSettingsPatch(patch, toastMsg = '设置已保存') {
  const res = await sendToBackground(ACTION.UPDATE_SETTINGS, patch);
  if (!res?.ok) {
    showToast(res?.error || '保存设置失败', 'error');
    return;
  }
  state.settings = res.settings || { ...state.settings, ...patch };
  renderModeControls();
  renderSettingsForm();
  renderLiveTrack();
  if (toastMsg) showToast(toastMsg, 'success');
}

function bindEvents() {
  els.trackCover.addEventListener('error', () => {
    els.trackCover.classList.add('is-hidden');
    els.trackCoverFallback.classList.remove('is-hidden');
  });

  // 模式三态切换
  for (const btn of els.modeButtons) {
    btn.addEventListener('click', async () => {
      const nextMode = btn.dataset.mode;
      if (!nextMode || nextMode === state.settings.mode) return;
      const res = await sendToBackground(ACTION.SET_WORK_MODE, { mode: nextMode });
      if (!res?.ok) {
        showToast(res?.error || '模式切换失败', 'error');
        return;
      }
      state.settings = res.settings;
      renderModeControls();
      renderLiveTrack();
      showToast(`已切换为：${MODE_UI_META[nextMode]?.label || nextMode}`, 'success');
    });
  }

  // 顶部视图 Tab 切换
  for (const btn of els.tabButtons) {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      if (!targetTab || targetTab === state.activeTab) return;
      state.activeTab = targetTab;
      for (const b of els.tabButtons) {
        const active = b.dataset.tab === targetTab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      }
      els.panelLive.classList.toggle('is-active', targetTab === 'live');
      els.panelLeaderboard.classList.toggle('is-active', targetTab === 'leaderboard');
      if (targetTab === 'leaderboard') {
        refreshLeaderboard();
      }
    });
  }

  // 手动立即下载
  els.btnManualDownload.addEventListener('click', async () => {
    els.btnManualDownload.disabled = true;
    const res = await sendToBackground(ACTION.MANUAL_DOWNLOAD, { tabId: state.tabId });
    if (res?.ok) {
      showToast(res.isUpgrade ? '正在拉取更高音质替换旧档...' : '已下发后台拉流任务...', 'success');
    } else if (res?.skipped) {
      const msg =
        res.reason === 'ALREADY_EXISTS'
          ? '本地已存在最高音质文件（已跳过重复下载）'
          : res.reason === 'ALREADY_IN_PROGRESS'
          ? '当前曲目正在下载中，请稍候'
          : `已跳过: ${res.reason}`;
      showToast(msg, 'info');
    } else {
      showToast(res?.error || '触发下载失败', 'error');
    }
    await refreshPopupState();
  });

  // 立即与桌面播放器双向同步
  els.btnSyncPlayer.addEventListener('click', async () => {
    els.btnSyncPlayer.disabled = true;
    const res = await sendToBackground(ACTION.SYNC_PLAYER_NOW, {});
    els.btnSyncPlayer.disabled = false;
    if (res?.ok) {
      state.playerSyncState = res.syncState || { online: true, lastSyncAt: Date.now(), playerSummary: res.summary };
      renderPlayerSyncStatus();
      showToast('已与桌面播放器完成双向同步', 'success');
      await refreshPopupState();
      if (state.activeTab === 'leaderboard') {
        await refreshLeaderboard();
      }
    } else {
      state.playerSyncState = { ...(state.playerSyncState || {}), online: false };
      renderPlayerSyncStatus();
      showToast(res?.error || '未检测到桌面播放器运行', 'error');
    }
  });

  // 实时参数设置
  els.settingThreshold.addEventListener('change', () => {
    const val = Math.min(300, Math.max(3, Math.round(Number(els.settingThreshold.value) || 15)));
    els.settingThreshold.value = String(val);
    persistSettingsPatch({ autoCaptureThresholdSeconds: val });
  });

  els.settingSubfolder.addEventListener('change', () => {
    const cleaned = els.settingSubfolder.value.trim() || 'BiliMusic';
    els.settingSubfolder.value = cleaned;
    persistSettingsPatch({ archiveSubfolder: cleaned });
  });

  els.settingUpgrade.addEventListener('change', () => {
    persistSettingsPatch({ enableQualityUpgrade: els.settingUpgrade.checked });
  });

  els.settingMultipart.addEventListener('change', () => {
    persistSettingsPatch({ groupMultiPartInSubdir: els.settingMultipart.checked });
  });

  // 排行榜过滤与排序
  for (const btn of els.periodButtons) {
    btn.addEventListener('click', () => {
      const days = Number(btn.dataset.days) || 0;
      if (days === state.lbDays) return;
      state.lbDays = days;
      for (const b of els.periodButtons) {
        b.classList.toggle('is-active', Number(b.dataset.days) === days);
      }
      refreshLeaderboard();
    });
  }

  els.lbSort.addEventListener('change', () => {
    state.lbSortBy = els.lbSort.value || 'totalPlayedSeconds';
    refreshLeaderboard();
  });

  // 两步内联确认清空听歌统计（严禁使用 window.confirm）
  els.btnClearStats.addEventListener('click', async () => {
    if (!els.btnClearStats.classList.contains('is-confirming')) {
      els.btnClearStats.classList.add('is-confirming');
      els.btnClearStats.textContent = '确认清空?';
      clearTimeout(state.clearConfirmTimer);
      state.clearConfirmTimer = setTimeout(() => {
        els.btnClearStats.classList.remove('is-confirming');
        els.btnClearStats.textContent = '清空统计';
      }, 3500);
      return;
    }

    clearTimeout(state.clearConfirmTimer);
    els.btnClearStats.classList.remove('is-confirming');
    els.btnClearStats.textContent = '清空统计';

    const res = await sendToBackground(ACTION.CLEAR_STATS, {});
    if (res?.ok) {
      showToast('听歌统计已清空（已保留本地归档记录）', 'success');
      await refreshLeaderboard();
      await refreshPopupState();
    } else {
      showToast(res?.error || '清空失败', 'error');
    }
  });

  // 监听后台实时状态推送
  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!isEnvelopeFor(message, MSG_TARGET.POPUP) || message.action !== ACTION.POPUP_STATE_UPDATED) {
        return false;
      }
      const p = message.payload || {};
      if (p.settings) {
        state.settings = p.settings;
        renderModeControls();
        renderSettingsForm();
      }
      if (p.playerSyncState) {
        state.playerSyncState = p.playerSyncState;
        renderPlayerSyncStatus();
      }
      if (p.tabId != null && (state.tabId == null || p.tabId === state.tabId) && p.tabState) {
        state.tabId = p.tabId;
        state.tabState = p.tabState;
        if (p.tabState.trackStats) {
          state.dbTrack = {
            ...(state.dbTrack || {}),
            playCount: p.tabState.trackStats.playCount,
            totalPlayedSeconds: p.tabState.trackStats.totalPlayedSeconds,
            qualityId: p.tabState.trackStats.downloadedQualityId,
            filename: p.tabState.trackStats.filename,
          };
        }
        renderLiveTrack();
      }
      if (state.activeTab === 'leaderboard') {
        refreshLeaderboard();
      }
      return false;
    });
  }
}

function init() {
  els.brandIcon = $('brand-icon');
  els.modePill = $('mode-pill');
  els.modeButtons = Array.from(document.querySelectorAll('.mode-btn'));
  els.tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  els.panelLive = $('panel-live');
  els.panelLeaderboard = $('panel-leaderboard');

  els.emptyTrackState = $('empty-track-state');
  els.trackCard = $('track-card');
  els.trackCover = $('track-cover');
  els.trackCoverFallback = $('track-cover-fallback');
  els.trackTitle = $('track-title');
  els.trackPart = $('track-part');
  els.trackOwner = $('track-owner');
  els.trackBvid = $('track-bvid');
  els.qualityBadge = $('quality-badge');
  els.downloadStatusPill = $('download-status-pill');
  els.thresholdText = $('threshold-text');
  els.thresholdBar = $('threshold-bar');
  els.trackStatsLine = $('track-stats-line');
  els.trackFilenameLine = $('track-filename-line');
  els.downloadErrorBox = $('download-error-box');
  els.btnManualDownload = $('btn-manual-download');
  els.playerSyncDot = $('player-sync-dot');
  els.playerSyncText = $('player-sync-text');
  els.btnSyncPlayer = $('btn-sync-player');

  els.settingThreshold = $('setting-threshold');
  els.settingSubfolder = $('setting-subfolder');
  els.settingUpgrade = $('setting-upgrade');
  els.settingMultipart = $('setting-multipart');

  els.kpiTracks = $('kpi-tracks');
  els.kpiPlays = $('kpi-plays');
  els.kpiDuration = $('kpi-duration');
  els.periodButtons = Array.from(document.querySelectorAll('.period-btn'));
  els.lbSort = $('lb-sort');
  els.btnClearStats = $('btn-clear-stats');
  els.lbEmpty = $('lb-empty');
  els.lbList = $('lb-list');
  els.toast = $('toast');

  bindEvents();
  refreshPopupState();
  refreshPlayerSyncStatus();
}

document.addEventListener('DOMContentLoaded', init);
