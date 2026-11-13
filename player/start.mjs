/**
 * @fileoverview BiliMusic 独立配套音乐播放器桌面启动器。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPlayerServer } from './server.mjs';

function parseArgs(argv) {
  let noOpen = false;
  let port = 19527;
  for (const arg of argv) {
    if (arg === '--no-open') noOpen = true;
    if (arg.startsWith('--port=')) {
      const p = Number(arg.slice('--port='.length));
      if (Number.isInteger(p) && p >= 0) port = p;
    }
  }
  return { noOpen, port };
}

function findDesktopBrowserExe() {
  if (process.platform !== 'win32') return null;
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';

  const candidates = [
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean);

  for (const exe of candidates) {
    try {
      if (fs.existsSync(exe)) return exe;
    } catch (_) {}
  }
  return null;
}

function openAppWindow(url) {
  const exe = findDesktopBrowserExe();
  if (exe) {
    const child = spawn(exe, [`--app=${url}`, '--window-size=1220,800'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

async function main() {
  const { noOpen, port } = parseArgs(process.argv.slice(2));
  const playerServer = createPlayerServer({ port });

  try {
    const info = await playerServer.start();
    console.log(`[BiliMusic Player] 服务已启动: ${info.url}`);
    console.log('[BiliMusic Player] 保持本窗口开启以维持后台同步与音频流服务 (Ctrl+C 退出)');

    if (!noOpen) {
      openAppWindow(info.url);
    }

    const shutdown = async () => {
      console.log('\n[BiliMusic Player] 正在关闭服务...');
      await playerServer.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      const existingUrl = `http://127.0.0.1:${port}`;
      console.log(`[BiliMusic Player] 检测到服务已在运行 (${existingUrl})，直接唤起播放器窗口...`);
      if (!noOpen) {
        openAppWindow(existingUrl);
      }
      process.exit(0);
    }
    console.error('[BiliMusic Player] 启动失败:', err);
    process.exit(1);
  }
}

main();
