/**
 * @fileoverview 已下载音乐历史清单过滤、去重合并与 AI 友好格式导出工具（Chrome 扩展与桌面播放器共用）。
 */

import { getQualityInfo } from './constants.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 格式化本地日期 YYYY-MM-DD。
 * @param {number} ts
 * @returns {string}
 */
export function formatDateStamp(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 格式化本地日期时间 YYYY-MM-DD HH:mm。
 * @param {number|null|undefined} ts
 * @returns {string}
 */
export function formatDateTime(ts) {
  const num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return '-';
  const d = new Date(num);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 格式化字节大小为可读字符串。
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 规范化路径用于跨端去重比对（统一斜杠并在 Windows 盘符风格下忽略大小写）。
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizePathForMatch(rawPath) {
  const normalized = String(rawPath || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!normalized) return '';
  if (/^[a-zA-Z]:\//.test(normalized) || typeof process === 'undefined' || process.platform === 'win32') {
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * 提取路径末段文件名。
 * @param {string} rawPath
 * @returns {string}
 */
export function getPathBasename(rawPath) {
  const norm = String(rawPath || '').replace(/\\/g, '/').trim();
  if (!norm) return '';
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 判断曲目当前是否真实存在可用音频（本地磁盘文件或 Google Drive 云端文件）。
 * 严禁包含已删除的本地文件或未下载的纯播放统计视频，避免审计时产生幻觉与困扰。
 * @param {object} track
 * @returns {boolean}
 */
export function isTrackCurrentlyAvailable(track) {
  if (!track || typeof track !== 'object') return false;
  const hasLocal = Boolean(track.fileExists && (track.filePath || track.filename));
  const hasCloud = Boolean(track.gdriveExists && track.gdriveFileId);
  return hasLocal || hasCloud;
}

/**
 * 过滤出当前实际存在的本地或云端已下载曲目。
 * @param {Array<object>} tracks
 * @returns {Array<object>}
 */
export function filterExistingDownloadedTracks(tracks = []) {
  if (!Array.isArray(tracks)) return [];
  return tracks.filter(isTrackCurrentlyAvailable);
}

function extractComparablePaths(track) {
  const fullPaths = [];
  const relPaths = [];
  for (const cand of [track?.filePath, track?.filename]) {
    const norm = normalizePathForMatch(cand);
    if (!norm) continue;
    if (/^[a-z]:\//i.test(norm) || norm.startsWith('/')) {
      fullPaths.push(norm);
    } else {
      relPaths.push(norm);
    }
  }
  for (const cand of [track?.relativePath, track?.gdriveRelativePath]) {
    const norm = normalizePathForMatch(cand);
    if (norm) relPaths.push(norm);
  }
  return {
    fullPaths: Array.from(new Set(fullPaths)),
    relPaths: Array.from(new Set(relPaths)),
  };
}

function tracksMatchForMerge(a, b) {
  const aCanonical = a?.bvid && a?.cid ? `${a.bvid}_${a.cid}` : null;
  const bCanonical = b?.bvid && b?.cid ? `${b.bvid}_${b.cid}` : null;
  if (aCanonical && bCanonical) {
    return aCanonical === bCanonical;
  }

  if (a?.gdriveFileId && b?.gdriveFileId && String(a.gdriveFileId) === String(b.gdriveFileId)) {
    return true;
  }

  const ap = extractComparablePaths(a);
  const bp = extractComparablePaths(b);

  for (const fp of ap.fullPaths) {
    if (bp.fullPaths.includes(fp)) return true;
    for (const rel of bp.relPaths) {
      if (fp.endsWith('/' + rel)) return true;
    }
  }
  for (const fp of bp.fullPaths) {
    for (const rel of ap.relPaths) {
      if (fp.endsWith('/' + rel)) return true;
    }
  }
  for (const rel of ap.relPaths) {
    if (bp.relPaths.includes(rel)) return true;
  }
  return false;
}

function mergeTwoTracks(base, incoming) {
  const merged = { ...base };
  const fillKeys = ['bvid', 'cid', 'title', 'part', 'owner', 'cover', 'qualityId', 'codecs', 'filePath', 'relativePath', 'filename', 'gdriveFileId', 'gdriveRelativePath'];
  for (const k of fillKeys) {
    if (!merged[k] && incoming[k]) {
      merged[k] = incoming[k];
    }
  }
  if (incoming.bvid && incoming.cid) {
    merged.trackKey = `${incoming.bvid}_${incoming.cid}`;
  }
  if (incoming.p && (!merged.p || merged.p === 1)) merged.p = incoming.p;
  if (incoming.totalParts && (!merged.totalParts || merged.totalParts === 1)) merged.totalParts = incoming.totalParts;

  merged.fileExists = Boolean(base.fileExists || incoming.fileExists);
  merged.gdriveExists = Boolean(base.gdriveExists || incoming.gdriveExists);
  merged.fileSize = Math.max(Number(base.fileSize) || 0, Number(incoming.fileSize) || 0) || null;
  merged.gdriveSize = Math.max(Number(base.gdriveSize) || 0, Number(incoming.gdriveSize) || 0) || null;
  merged.downloadedAt = Math.max(Number(base.downloadedAt) || 0, Number(incoming.downloadedAt) || 0) || null;
  merged.lastPlayedAt = Math.max(Number(base.lastPlayedAt) || 0, Number(incoming.lastPlayedAt) || 0) || null;
  merged.playCount = Math.max(
    Number(base.totalPlayCount ?? base.playCount) || 0,
    Number(incoming.totalPlayCount ?? incoming.playCount) || 0
  );
  merged.totalPlayCount = merged.playCount;
  merged.totalPlayedSeconds = Number(
    Math.max(Number(base.totalPlayedSeconds) || 0, Number(incoming.totalPlayedSeconds) || 0).toFixed(2)
  );
  return merged;
}

/**
 * 合并来自不同来源（如 Chrome 扩展存活下载与桌面播放器曲库）的现有曲目并去重。
 * @param {Array<object>} primaryTracks
 * @param {Array<object>} [secondaryTracks=[]]
 * @returns {Array<object>}
 */
export function mergeExportTracks(primaryTracks = [], secondaryTracks = []) {
  const combined = [...filterExistingDownloadedTracks(primaryTracks), ...filterExistingDownloadedTracks(secondaryTracks)];
  const records = [];

  for (const track of combined) {
    const matchIdx = records.findIndex((existing) => tracksMatchForMerge(existing, track));
    if (matchIdx >= 0) {
      records[matchIdx] = mergeTwoTracks(records[matchIdx], track);
    } else {
      records.push({ ...track });
    }
  }

  return records;
}

function resolveDisplayTitle(track) {
  const title = String(track?.title || '').trim() || getPathBasename(track?.relativePath || track?.filename || track?.filePath) || '未知曲目';
  const part = String(track?.part || '').trim();
  const p = Number(track?.p) || 1;
  const totalParts = Number(track?.totalParts) || 1;
  if (part && part !== title) {
    return totalParts > 1 || p > 1 ? `${title} [P${p}: ${part}]` : `${title} (${part})`;
  }
  return title;
}

function resolveQualityLabel(track) {
  if (track?.qualityId != null && Number(track.qualityId) > 0) {
    const q = getQualityInfo(track.qualityId, track.codecs || '');
    return `${q.shortLabel} (${q.codecLabel})`;
  }
  if (track?.codecs) {
    const q = getQualityInfo(0, track.codecs);
    return q.codecLabel;
  }
  return '未知';
}

function resolveStorageStatus(track) {
  const hasLocal = Boolean(track?.fileExists && (track?.filePath || track?.filename));
  const hasCloud = Boolean(track?.gdriveExists && track?.gdriveFileId);
  if (hasLocal && hasCloud) return '本地+云端';
  if (hasLocal) return '仅本地';
  if (hasCloud) return '仅云端';
  return '-';
}

/**
 * 将曲目记录归一化为适合 AI 查重审查的精简结构。
 * @param {object} track
 * @param {number} index
 * @returns {object}
 */
export function normalizeExportRecord(track, index = 1) {
  const sizeBytes = Number(track?.fileSize || track?.gdriveSize) || null;
  const downloadedAtMs = Number(track?.downloadedAt || track?.lastPlayedAt) || null;
  const displayPath =
    track?.relativePath ||
    track?.gdriveRelativePath ||
    getPathBasename(track?.filePath || track?.filename) ||
    track?.filename ||
    '-';

  return {
    index,
    title: resolveDisplayTitle(track),
    rawTitle: String(track?.title || '').trim() || null,
    part: track?.part || null,
    owner: String(track?.owner || '').trim() || '未知',
    quality: resolveQualityLabel(track),
    sizeBytes,
    sizeText: formatFileSize(sizeBytes),
    storage: resolveStorageStatus(track),
    downloadedAtMs,
    downloadedAt: formatDateTime(downloadedAtMs),
    bvid: track?.bvid || '-',
    filename: String(displayPath),
    playCount: Number(track?.totalPlayCount ?? track?.playCount) || 0,
  };
}

function escapeMdCell(val) {
  return String(val ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '-';
}

function escapeCsvCell(val) {
  const s = String(val ?? '');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 生成发给 AI 查重审查的 Markdown / JSON / CSV 下载历史清单。
 * @param {Array<object>} tracks
 * @param {{ format?: 'md'|'json'|'csv', sourceLabel?: string, exportedAt?: number }} [options={}]
 * @returns {{ format: string, filename: string, mimeType: string, count: number, items: Array<object>, content: string }}
 */
export function buildDownloadHistoryExport(tracks = [], options = {}) {
  const rawFormat = String(options.format || 'md').toLowerCase();
  const format = ['md', 'json', 'csv'].includes(rawFormat) ? rawFormat : 'md';
  const exportedAt = Number(options.exportedAt) || Date.now();
  const sourceLabel = String(options.sourceLabel || 'BiliMusic');

  const available = filterExistingDownloadedTracks(tracks);
  const sorted = [...available].sort((a, b) => {
    const timeDiff = (Number(b.downloadedAt || b.lastPlayedAt) || 0) - (Number(a.downloadedAt || a.lastPlayedAt) || 0);
    if (timeDiff !== 0) return timeDiff;
    return String(a.title || a.filename || '').localeCompare(String(b.title || b.filename || ''), 'zh-CN');
  });

  const items = sorted.map((t, i) => normalizeExportRecord(t, i + 1));
  const dateStamp = formatDateStamp(exportedAt);
  const exportTimeText = formatDateTime(exportedAt);

  if (format === 'json') {
    const payload = {
      exportedAt: exportTimeText,
      source: sourceLabel,
      totalCount: items.length,
      note: '仅包含当前实际存在的本地或云端已下载音乐，已排除已删除文件与未下载的普通视频记录。',
      aiAuditHint: '请审查 tracks 数组中是否存在同首歌的重复版本（如不同UP主搬运、标题前缀后缀差异、低音质冗余），并区分 Live/Remix/翻唱等不同演绎版本。',
      tracks: items,
    };
    return {
      format: 'json',
      filename: `BiliMusic-下载历史-${dateStamp}.json`,
      mimeType: 'application/json; charset=utf-8',
      count: items.length,
      items,
      content: JSON.stringify(payload, null, 2),
    };
  }

  if (format === 'csv') {
    const headers = ['序号', '歌名/分P', 'UP主', '音质', '大小', '存储位置', '下载时间', 'BV号', '播放次数', '文件名/路径'];
    const lines = [headers.map(escapeCsvCell).join(',')];
    for (const item of items) {
      lines.push(
        [
          item.index,
          item.title,
          item.owner,
          item.quality,
          item.sizeText,
          item.storage,
          item.downloadedAt,
          item.bvid,
          item.playCount,
          item.filename,
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }
    return {
      format: 'csv',
      filename: `BiliMusic-下载历史-${dateStamp}.csv`,
      mimeType: 'text/csv; charset=utf-8',
      count: items.length,
      items,
      content: `\uFEFF${lines.join('\r\n')}`,
    };
  }

  const mdLines = [
    '# BiliMusic 已下载音乐清单 (AI 查重审计专用)',
    '',
    `- **导出时间**: ${exportTimeText}`,
    `- **数据来源**: ${sourceLabel}`,
    `- **现存曲目总数**: ${items.length} 首（仅包含当前实际存在的本地或云端音频，不含已删除或未下载记录）`,
    '',
    '> **可直接发给 AI 的审查提示词：**',
    '> 请帮我审查下方已下载音乐清单，重点识别：',
    '> 1. **同首歌的重复下载**（例如不同 UP 主搬运、中英文/书名号写法不同、带“【Hi-Res】/百万级装备试听”等前后缀但实质是同一首歌）；',
    '> 2. **同曲低音质冗余**（优先建议保留 Hi-Res / 体积更大 / 播放次数更高的一份）；',
    '> 3. **不同演绎版本区分**（Live 现场、Remix、翻唱、伴奏请明确标注为“不同版本建议保留”，勿与纯重复混淆）。',
    '> 请按组列出疑似重复曲目的序号、歌名、文件名，并给出保留与清理建议。',
    '',
  ];

  if (items.length === 0) {
    mdLines.push('（当前暂无实际存在的已下载音乐记录）');
  } else {
    mdLines.push('| # | 歌名 / 分P | UP主 | 音质 | 大小 | 存储位置 | 下载时间 | BV号 | 文件名 / 路径 |');
    mdLines.push('| ---: | :--- | :--- | :--- | ---: | :--- | :--- | :--- | :--- |');
    for (const item of items) {
      mdLines.push(
        `| ${item.index} | ${escapeMdCell(item.title)} | ${escapeMdCell(item.owner)} | ${escapeMdCell(item.quality)} | ${escapeMdCell(item.sizeText)} | ${escapeMdCell(item.storage)} | ${escapeMdCell(item.downloadedAt)} | ${escapeMdCell(item.bvid)} | ${escapeMdCell(item.filename)} |`
      );
    }
  }

  return {
    format: 'md',
    filename: `BiliMusic-下载历史-${dateStamp}.md`,
    mimeType: 'text/markdown; charset=utf-8',
    count: items.length,
    items,
    content: mdLines.join('\n'),
  };
}

/**
 * 将 UTF-8 文本编码为 Base64 Data URL（用于 SW 通过 chrome.downloads.download 稳定保留 .md/.csv/.json 扩展名落盘）。
 * @param {string} text
 * @returns {string}
 */
export function buildDownloadDataUrl(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:application/octet-stream;base64,${btoa(bin)}`;
}
