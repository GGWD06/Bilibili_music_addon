/**
 * @fileoverview 状态机枚举、消息 Action 常量与 B 站 DASH 音质等级映射字典（SW / Popup 共用）。
 */

/** 扩展全局工作模式 */
export const WORK_MODE = Object.freeze({
  AUTO_CAPTURE: 'AUTO_CAPTURE',
  STATS_ONLY: 'STATS_ONLY',
  PAUSED: 'PAUSED',
});

/** 曲目在本地曲库与调度会话中的归档状态 */
export const DOWNLOAD_STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  UPGRADED: 'upgraded',
  SKIPPED: 'skipped',
  UNSUPPORTED_DURL: 'unsupported_durl',
  ERROR: 'error',
});

/** 跨运行域消息目标标识 */
export const MSG_TARGET = Object.freeze({
  BACKGROUND: 'background',
  CONTENT: 'content',
  POPUP: 'popup',
});

/** 统一跨运行域消息 Action 常量 */
export const ACTION = Object.freeze({
  // Content -> SW
  TRACK_DETECTED: 'TRACK_DETECTED',
  PLAY_HEARTBEAT: 'PLAY_HEARTBEAT',
  DASH_BLOB_READY: 'DASH_BLOB_READY',
  DASH_BLOB_FAILED: 'DASH_BLOB_FAILED',

  // SW -> Content
  FETCH_DASH_BLOB: 'FETCH_DASH_BLOB',
  REVOKE_BLOB_URL: 'REVOKE_BLOB_URL',

  // Popup <-> SW
  GET_POPUP_STATE: 'GET_POPUP_STATE',
  POPUP_STATE_UPDATED: 'POPUP_STATE_UPDATED',
  SET_WORK_MODE: 'SET_WORK_MODE',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  MANUAL_DOWNLOAD: 'MANUAL_DOWNLOAD',
  GET_LEADERBOARD: 'GET_LEADERBOARD',
  CLEAR_STATS: 'CLEAR_STATS',
});

/** Storage 存储键常量 */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  TAB_STATES: 'tabStates',
  PENDING_DOWNLOADS: 'pendingDownloads',
});

/** 用户默认持久化偏好设置 */
export const DEFAULT_SETTINGS = Object.freeze({
  mode: WORK_MODE.AUTO_CAPTURE,
  autoCaptureThresholdSeconds: 15,
  enableQualityUpgrade: true,
  archiveSubfolder: 'BiliMusic',
  groupMultiPartInSubdir: true,
  audioMimeType: 'audio/x-m4a',
});

/** 三态工作模式对应的 UI 提示与徽章配置 */
export const MODE_UI_META = Object.freeze({
  [WORK_MODE.AUTO_CAPTURE]: Object.freeze({
    label: '自动捕获 + 统计',
    badgeText: 'AUTO',
    badgeColor: '#fb7299',
    iconPaths: Object.freeze({
      16: 'assets/icons/icon-16.png',
      48: 'assets/icons/icon-48.png',
      128: 'assets/icons/icon-128.png',
    }),
  }),
  [WORK_MODE.STATS_ONLY]: Object.freeze({
    label: '仅听歌统计',
    badgeText: 'STAT',
    badgeColor: '#2ea043',
    iconPaths: Object.freeze({
      16: 'assets/icons/icon-stats-16.png',
      48: 'assets/icons/icon-stats-48.png',
      128: 'assets/icons/icon-stats-128.png',
    }),
  }),
  [WORK_MODE.PAUSED]: Object.freeze({
    label: '暂停待机',
    badgeText: 'OFF',
    badgeColor: '#6e7681',
    iconPaths: Object.freeze({
      16: 'assets/icons/icon-paused-16.png',
      48: 'assets/icons/icon-paused-48.png',
      128: 'assets/icons/icon-paused-128.png',
    }),
  }),
});

/**
 * B 站 DASH 音质代号映射字典。
 * B 站所有 DASH 音轨（含 Hi-Res FLAC 与杜比 E-AC-3）均封装于 fMP4 (ftyp) 容器内，统一落盘为 .m4a。
 */
export const DASH_QUALITY_MAP = Object.freeze({
  30251: Object.freeze({
    id: 30251,
    weight: 500,
    label: 'Hi-Res 无损',
    shortLabel: 'Hi-Res',
    codecLabel: 'FLAC',
    ext: 'm4a',
    mime: 'audio/x-m4a',
  }),
  30250: Object.freeze({
    id: 30250,
    weight: 400,
    label: '杜比全景声',
    shortLabel: 'Dolby',
    codecLabel: 'E-AC-3',
    ext: 'm4a',
    mime: 'audio/x-m4a',
  }),
  30280: Object.freeze({
    id: 30280,
    weight: 300,
    label: '192K 高码率',
    shortLabel: '192K',
    codecLabel: 'AAC',
    ext: 'm4a',
    mime: 'audio/x-m4a',
  }),
  30232: Object.freeze({
    id: 30232,
    weight: 200,
    label: '132K 标准',
    shortLabel: '132K',
    codecLabel: 'AAC',
    ext: 'm4a',
    mime: 'audio/x-m4a',
  }),
  30216: Object.freeze({
    id: 30216,
    weight: 100,
    label: '64K 流畅',
    shortLabel: '64K',
    codecLabel: 'AAC',
    ext: 'm4a',
    mime: 'audio/x-m4a',
  }),
});

/**
 * 根据音质代号与编码字符串查询标准音质元信息。
 * @param {number|string|null|undefined} qualityId B 站 DASH 音质代号
 * @param {string} [codecs] 编码字符串（如 mp4a.40.2 / fLaC）
 * @returns {{ id: number, weight: number, label: string, shortLabel: string, codecLabel: string, ext: string, mime: string }}
 */
export function getQualityInfo(qualityId, codecs = '') {
  const numericId = Number(qualityId);
  if (Number.isFinite(numericId) && DASH_QUALITY_MAP[numericId]) {
    return DASH_QUALITY_MAP[numericId];
  }
  const codecUpper = String(codecs || '').toUpperCase();
  const codecLabel = codecUpper.includes('FLAC')
    ? 'FLAC'
    : codecUpper.includes('EC-3') || codecUpper.includes('AC-3')
      ? 'Dolby'
      : 'AAC';

  return {
    id: Number.isFinite(numericId) ? numericId : 0,
    weight: Number.isFinite(numericId) && numericId > 0 ? 50 : 0,
    label: Number.isFinite(numericId) && numericId > 0 ? `音质 ${numericId}` : '未知音质',
    shortLabel: Number.isFinite(numericId) && numericId > 0 ? String(numericId) : 'N/A',
    codecLabel,
    ext: 'm4a',
    mime: 'audio/x-m4a',
  };
}

/**
 * 比较两条 DASH 音轨的优劣（返回正数表示 a 优于 b，负数表示 b 优于 a，0 表示同级）。
 * @param {{ id?: number, bandwidth?: number }|null|undefined} a
 * @param {{ id?: number, bandwidth?: number }|null|undefined} b
 * @returns {number}
 */
export function compareQuality(a, b) {
  const weightA = a ? getQualityInfo(a.id).weight : -1;
  const weightB = b ? getQualityInfo(b.id).weight : -1;
  if (weightA !== weightB) return weightA - weightB;

  const bwA = Number(a?.bandwidth) || 0;
  const bwB = Number(b?.bandwidth) || 0;
  if (bwA !== bwB) return bwA - bwB;

  return (Number(a?.id) || 0) - (Number(b?.id) || 0);
}

/**
 * 从归一化音轨列表中挑选最优 DASH 音频流。
 * @param {Array<{ id: number, codecs?: string, bandwidth?: number, baseUrl: string, backupUrl?: string[] }>} tracks
 * @returns {object|null}
 */
export function pickBestAudioTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  let best = null;
  for (const track of tracks) {
    if (!track || !track.baseUrl) continue;
    if (!best || compareQuality(track, best) > 0) {
      best = track;
    }
  }
  return best;
}
