/**
 * @fileoverview 本地音乐目录递归扫描器与 BiliMusic 归档文件名智能反解析器。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.m4a',
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.aac',
  '.opus',
]);

let cachedWinDownloadsDir;

/**
 * 读取 Windows 注册表中的真实“下载”文件夹路径（兼容重定向到 D:\ 等非默认位置）。
 * @returns {string|null}
 */
export function detectWindowsDownloadsDir() {
  if (process.platform !== 'win32') return null;
  if (cachedWinDownloadsDir !== undefined) return cachedWinDownloadsDir;

  try {
    const out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v',
        '{374DE290-123F-4565-9164-39C4925E467B}',
      ],
      { encoding: 'utf8', timeout: 1000, windowsHide: true }
    );
    const match = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (match) {
      let raw = match[1].trim().replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
      if (/^[A-Za-z]:$/.test(raw)) raw += '\\';
      const resolved = path.resolve(raw);
      if (fsSync.existsSync(resolved)) {
        cachedWinDownloadsDir = resolved;
        return cachedWinDownloadsDir;
      }
    }
  } catch (_) {}

  cachedWinDownloadsDir = null;
  return null;
}

/**
 * 从扩展传来的绝对落盘文件路径推断归档根目录（兼容单 P 与多 P 子目录）。
 * @param {string} filename
 * @param {{ totalParts?: number }} [trackMeta]
 * @returns {string|null}
 */
export function extractArchiveRootFromFilename(filename, trackMeta = {}) {
  const raw = String(filename || '').trim();
  if (!raw || !path.isAbsolute(raw)) return null;

  const fileDir = path.dirname(raw);
  const baseName = path.basename(raw);
  const parentName = path.basename(fileDir);
  const looksMultiPart =
    Number(trackMeta?.totalParts) > 1 ||
    (/^P\d+\s*-/i.test(baseName) && parentName.includes(' - '));

  const candidate = looksMultiPart && path.dirname(fileDir) !== fileDir ? path.dirname(fileDir) : fileDir;
  return fsSync.existsSync(candidate) ? path.resolve(candidate) : null;
}

/**
 * 返回默认音乐扫描目录列表（自动探测 Windows 重定向下载目录与常见盘符下的 BiliMusic 文件夹）。
 * @returns {string[]}
 */
export function getDefaultMusicDirs() {
  const candidates = [];
  const winDownloads = detectWindowsDownloadsDir();
  if (winDownloads) {
    candidates.push(path.join(winDownloads, 'BiliMusic'));
  }
  candidates.push(path.join(os.homedir(), 'Downloads', 'BiliMusic'));

  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F']) {
      const rootBili = `${drive}:\\BiliMusic`;
      if (fsSync.existsSync(rootBili)) {
        candidates.push(rootBili);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }

  const existing = unique.filter((d) => {
    try {
      return fsSync.existsSync(d);
    } catch (_) {
      return false;
    }
  });
  return existing.length > 0 ? existing : [unique[0]];
}

/**
 * 从归档相对路径智能反解析曲目元信息：
 * 1) 保底格式: `BV1xx_12345_30251.m4a`
 * 2) 多 P 格式: `{owner} - {title}/P{p} - {part}.m4a`
 * 3) 单 P 格式: `{owner} - {title}.m4a`
 * @param {string} relativePath
 * @returns {{ bvid?: string, cid?: string, qualityId?: number, owner: string, title: string, p: number, part: string|null }}
 */
export function parseArchiveFilenameMeta(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;

  // 1) 保底格式: BV1xx_12345_30251.m4a
  const fallbackMatch = stem.match(/^(BV[0-9A-Za-z]+)_(\d+)(?:_(\d+))?$/);
  if (fallbackMatch) {
    return {
      bvid: fallbackMatch[1],
      cid: fallbackMatch[2],
      qualityId: fallbackMatch[3] ? Number(fallbackMatch[3]) : undefined,
      owner: '',
      title: fallbackMatch[1],
      p: 1,
      part: null,
    };
  }

  // 2) 多 P 格式: {owner} - {title}/P{p} - {part}.m4a
  if (parts.length >= 2) {
    const parentFolder = parts[parts.length - 2];
    const partMatch = stem.match(/^P(\d+)\s*-\s*(.+)$/i);
    if (partMatch) {
      const pNum = Number(partMatch[1]) || 1;
      const partTitle = partMatch[2].trim();
      const sepIdx = parentFolder.indexOf(' - ');
      const owner = sepIdx > 0 ? parentFolder.slice(0, sepIdx).trim() : '';
      const title = sepIdx > 0 ? parentFolder.slice(sepIdx + 3).trim() : parentFolder.trim();
      return {
        owner,
        title: title || stem,
        p: pNum,
        part: partTitle || null,
      };
    }
  }

  // 3) 单 P 格式: {owner} - {title}.m4a
  const sepIdx = stem.indexOf(' - ');
  if (sepIdx > 0) {
    return {
      owner: stem.slice(0, sepIdx).trim(),
      title: stem.slice(sepIdx + 3).trim() || stem,
      p: 1,
      part: null,
    };
  }

  return {
    owner: '',
    title: stem || fileName || '未知曲目',
    p: 1,
    part: null,
  };
}

/**
 * 递归扫描单个目录收集受支持音频文件。
 * @param {string} rootDir
 * @param {string} currentDir
 * @param {Array<object>} out
 */
async function walkDirectory(rootDir, currentDir, out) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(rootDir, fullPath, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) continue;
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (_) {
        continue;
      }
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      out.push({
        rootDir,
        filePath: fullPath,
        relativePath,
        basename: entry.name,
        ext,
        fileSize: stat.size,
        mtimeMs: stat.mtimeMs,
        parsedMeta: parseArchiveFilenameMeta(relativePath),
      });
    }
  }
}

/**
 * 递归扫描多个音乐目录并按文件路径去重。
 * @param {string[]} dirs
 * @returns {Promise<Array<object>>}
 */
export async function scanMusicDirectories(dirs = getDefaultMusicDirs()) {
  const uniqueDirs = Array.from(
    new Set(
      (Array.isArray(dirs) ? dirs : [])
        .map((d) => String(d || '').trim())
        .filter(Boolean)
        .map((d) => path.resolve(d))
    )
  );

  const results = [];
  const seenPaths = new Set();

  for (const dir of uniqueDirs) {
    const dirItems = [];
    await walkDirectory(dir, dir, dirItems);
    for (const item of dirItems) {
      const normKey = process.platform === 'win32' ? item.filePath.toLowerCase() : item.filePath;
      if (seenPaths.has(normKey)) continue;
      seenPaths.add(normKey);
      results.push(item);
    }
  }

  return results;
}
