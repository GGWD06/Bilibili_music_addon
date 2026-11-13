/**
 * @fileoverview 三级文件名清洗流水线与归档相对路径生成器（防 Windows 非法字符、保留设备名与路径穿越）。
 */

const ILLEGAL_CHARS_RE = /[\\/:*?"<>|]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g;
const MULTI_SPACE_RE = /\s+/g;
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

const MAX_SEGMENT_CHARS = 80;
const MAX_RELATIVE_PATH_CHARS = 180;

/**
 * 按 Unicode 码点安全截断字符串，避免拆断代理对（如 Emoji）。
 * @param {string} text
 * @param {number} maxCodePoints
 * @returns {string}
 */
function sliceByCodePoints(text, maxCodePoints) {
  const chars = Array.from(text);
  if (chars.length <= maxCodePoints) return text;
  return chars.slice(0, maxCodePoints).join('');
}

/**
 * 第 1+2 级：清洗单个文件名/目录名片段（非法字符、控制字符、点号边界、保留设备名与安全截断）。
 * @param {unknown} rawText 原始文本
 * @param {string} [fallback='untitled'] 清洗后为空时的保底名称
 * @param {number} [maxLength=MAX_SEGMENT_CHARS] 最大字符数
 * @returns {string}
 */
export function sanitizeSegment(rawText, fallback = 'untitled', maxLength = MAX_SEGMENT_CHARS) {
  const normalized = String(rawText ?? '').normalize('NFC');

  // Level 1: 剔除控制字符、非法路径字符与首尾点/空白，再消除内部连续点号（防 .. 穿越）
  let cleaned = normalized
    .replace(CONTROL_CHARS_RE, '')
    .replace(ILLEGAL_CHARS_RE, '_')
    .replace(MULTI_SPACE_RE, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\.\.+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');

  // Level 2: 按码点截断并二次剥离尾随空白/点号，再防御 Windows 保留设备名
  cleaned = sliceByCodePoints(cleaned, Math.max(1, maxLength)).replace(/^[.\s]+|[.\s]+$/g, '');

  if (!cleaned) {
    cleaned = fallback;
  }
  if (WINDOWS_RESERVED_RE.test(cleaned)) {
    cleaned = `_${cleaned}_`;
  }
  return cleaned;
}

/**
 * 清洗并规范化归档根子目录名称（禁止路径穿越与多级非法斜杠）。
 * @param {unknown} rawDir
 * @param {string} [fallback='BiliMusic']
 * @returns {string}
 */
export function sanitizeArchiveDir(rawDir, fallback = 'BiliMusic') {
  const segments = String(rawDir ?? '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => sanitizeSegment(part, '', 40))
    .filter(Boolean);

  return segments.length > 0 ? segments.join('/') : fallback;
}

/**
 * 将相对路径中潜在的异常段彻底剔除，确保供 chrome.downloads.download 使用的安全斜杠格式。
 * @param {string[]} parts
 * @returns {string}
 */
function joinSafeRelativePath(parts) {
  return parts
    .flatMap((p) => String(p).split('/'))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * 第 3 级：生成标准归档相对路径（自动区分单 P 与多 P 合集，并控制总路径长度防 Windows MAX_PATH 溢出）。
 * @param {{ bvid?: string, cid?: string|number, p?: number, totalParts?: number, title?: string, part?: string|null, owner?: string }} trackMeta
 * @param {{ baseDir?: string, groupMultiPartInSubdir?: boolean, ext?: string }} [options={}]
 * @returns {string}
 */
export function buildArchiveFilename(trackMeta = {}, options = {}) {
  const baseDir = sanitizeArchiveDir(options.baseDir, 'BiliMusic');
  const ext = sanitizeSegment(options.ext || 'm4a', 'm4a', 10).replace(/^\.+/, '');
  const groupMultiPartInSubdir = options.groupMultiPartInSubdir !== false;

  const owner = sanitizeSegment(trackMeta.owner, '未知UP主', 32);
  const bvidFallback = sanitizeSegment(trackMeta.bvid, 'BiliTrack', 24);
  const titleMaxLen = 64;
  let title = sanitizeSegment(trackMeta.title, bvidFallback, titleMaxLen);

  const totalParts = Math.max(1, Number(trackMeta.totalParts) || 1);
  const pNum = Math.max(1, Number(trackMeta.p) || 1);
  const padWidth = Math.max(2, String(totalParts).length);
  const pTag = `P${String(pNum).padStart(padWidth, '0')}`;

  if (totalParts === 1) {
    const stemMax = Math.max(20, MAX_RELATIVE_PATH_CHARS - baseDir.length - owner.length - ext.length - 6);
    if (Array.from(title).length > stemMax) {
      title = sanitizeSegment(title, bvidFallback, stemMax);
    }
    return joinSafeRelativePath([baseDir, `${owner} - ${title}.${ext}`]);
  }

  let partName = sanitizeSegment(trackMeta.part, pTag, 64);

  if (groupMultiPartInSubdir) {
    const folder = sanitizeSegment(`${owner} - ${title}`, bvidFallback, 72);
    const maxFileStem = Math.max(20, MAX_RELATIVE_PATH_CHARS - baseDir.length - folder.length - pTag.length - ext.length - 7);
    if (Array.from(partName).length > maxFileStem) {
      partName = sanitizeSegment(partName, pTag, maxFileStem);
    }
    return joinSafeRelativePath([baseDir, folder, `${pTag} - ${partName}.${ext}`]);
  }

  const maxTitleFlat = 36;
  const maxPartFlat = Math.max(20, MAX_RELATIVE_PATH_CHARS - baseDir.length - owner.length - maxTitleFlat - pTag.length - ext.length - 12);
  title = sanitizeSegment(title, bvidFallback, maxTitleFlat);
  partName = sanitizeSegment(partName, pTag, maxPartFlat);
  return joinSafeRelativePath([baseDir, `${owner} - ${title} - ${pTag} - ${partName}.${ext}`]);
}

/**
 * 生成下载重试时的保底安全短路径（规避极端标题导致的路径异常）。
 * @param {{ bvid?: string, cid?: string|number, qualityId?: number|string }} info
 * @param {{ baseDir?: string, ext?: string }} [options={}]
 * @returns {string}
 */
export function buildFallbackFilename(info = {}, options = {}) {
  const baseDir = sanitizeArchiveDir(options.baseDir, 'BiliMusic');
  const ext = sanitizeSegment(options.ext || 'm4a', 'm4a', 10).replace(/^\.+/, '');
  const bvid = sanitizeSegment(info.bvid, 'nobv', 24);
  const cid = sanitizeSegment(info.cid, 'nocid', 24);
  const qid = sanitizeSegment(info.qualityId, 'audio', 16);
  return joinSafeRelativePath([baseDir, `${bvid}_${cid}_${qid}.${ext}`]);
}
