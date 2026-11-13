/**
 * @fileoverview 音频 MIME 映射与本地磁盘 HTTP 206 Range 流式传输公共工具。
 */

import fs from 'node:fs';
import path from 'node:path';

export const MIME_BY_EXT = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
});

/**
 * 根据文件名或扩展名解析音频 MIME 类型。
 * @param {string} filePathOrName
 * @returns {string}
 */
export function getAudioContentType(filePathOrName) {
  const ext = path.extname(String(filePathOrName || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'audio/mp4';
}

/**
 * 解析 HTTP Range 请求头。
 * @param {string|undefined} rangeHeader
 * @param {number} totalSize
 * @returns {{ valid: boolean, start?: number, end?: number }}
 */
export function parseByteRange(rangeHeader, totalSize) {
  const match = String(rangeHeader || '').match(/bytes=(\d*)-(\d*)/);
  if (!match) return { valid: false };
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(totalSize - 1, Number(match[2])) : totalSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize || end < start) {
    return { valid: false };
  }
  return { valid: true, start, end };
}

/**
 * 从本地磁盘按 HTTP 200 / 206 Range 流式输出音频文件。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {number} totalSize
 * @param {string} contentType
 */
export function streamLocalFileWithRange(req, res, filePath, totalSize, contentType) {
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, totalSize);
    if (!parsed.valid) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      res.end();
      return;
    }
    const { start, end } = parsed;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    res.on('close', () => {
      if (!res.writableFinished) stream.destroy();
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': totalSize,
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  res.on('close', () => {
    if (!res.writableFinished) stream.destroy();
  });
  stream.pipe(res);
}
