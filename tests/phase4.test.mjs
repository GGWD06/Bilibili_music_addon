import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function createFakeElement(tagName = 'div', id = '') {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: tagName.toUpperCase(),
    id,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    src: '',
    title: '',
    children: [],
    dataset: {},
    style: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const next = force === undefined ? !classes.has(c) : Boolean(force);
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
      contains: (c) => classes.has(c),
    },
    set className(val) {
      classes.clear();
      String(val || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent: async (evt) => {
      const fns = listeners.get(evt?.type || evt) || [];
      for (const fn of fns) {
        await fn(typeof evt === 'string' ? { type: evt, target: el } : evt);
      }
    },
    append: (...nodes) => el.children.push(...nodes),
    appendChild: (node) => el.children.push(node),
    replaceChildren: (...nodes) => { el.children = [...nodes]; },
  };
  return el;
}

test('popup.html & popup.js: all element IDs match, no inline handlers/dialogs, and full UI interactions work', async () => {
  const html = fs.readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');

  // 安全与规则检查
  assert.doesNotMatch(js, /\b(alert|confirm|prompt)\s*\(/, 'Popup must never use blocking window dialogs');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'Popup HTML must not contain inline event attributes under MV3 CSP');

  const idSet = new Set();
  for (const m of html.matchAll(/id="([^"]+)"/g)) {
    idSet.add(m[1]);
  }
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(idSet.has(m[1]), `popup.js references missing HTML element id: ${m[1]}`);
  }

  // 构建轻量 DOM 与 Mock Chrome 通道验证全流程交互
  const elMap = new Map();
  for (const id of idSet) {
    elMap.set(id, createFakeElement('div', id));
  }
  elMap.get('lb-sort').value = 'totalPlayedSeconds';

  const modeButtons = [
    Object.assign(createFakeElement('button'), { dataset: { mode: 'AUTO_CAPTURE' } }),
    Object.assign(createFakeElement('button'), { dataset: { mode: 'STATS_ONLY' } }),
    Object.assign(createFakeElement('button'), { dataset: { mode: 'PAUSED' } }),
  ];
  const tabButtons = [
    Object.assign(createFakeElement('button'), { dataset: { tab: 'live' } }),
    Object.assign(createFakeElement('button'), { dataset: { tab: 'leaderboard' } }),
  ];
  const periodButtons = [
    Object.assign(createFakeElement('button'), { dataset: { days: '0' } }),
    Object.assign(createFakeElement('button'), { dataset: { days: '7' } }),
    Object.assign(createFakeElement('button'), { dataset: { days: '30' } }),
  ];

  const docListeners = new Map();
  const sentMessages = [];
  let clearStatsCalls = 0;

  const prevDoc = globalThis.document;
  const prevChrome = globalThis.chrome;

  globalThis.document = {
    activeElement: null,
    getElementById: (id) => elMap.get(id) || null,
    querySelectorAll: (sel) => {
      if (sel === '.mode-btn') return modeButtons;
      if (sel === '.tab-btn') return tabButtons;
      if (sel === '.period-btn') return periodButtons;
      return [];
    },
    createElement: (tag) => createFakeElement(tag),
    createDocumentFragment: () => createFakeElement('fragment'),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (env) => {
        sentMessages.push(env);
        if (env.action === 'GET_POPUP_STATE') {
          return {
            ok: true,
            data: {
              tabId: 12,
              settings: {
                mode: 'AUTO_CAPTURE',
                autoCaptureThresholdSeconds: 15,
                enableQualityUpgrade: true,
                archiveSubfolder: 'BiliMusic',
                groupMultiPartInSubdir: true,
              },
              tabState: {
                tabId: 12,
                trackKey: 'BV1pop_1',
                meta: { bvid: 'BV1pop', cid: '1', title: '测试歌曲', owner: '歌手X', p: 2, totalParts: 3, part: 'Live版' },
                matched: true,
                bestAudio: { id: 30251, codecs: 'flac' },
                qualityInfo: { id: 30251, weight: 500, label: 'Hi-Res 无损', shortLabel: 'Hi-Res', codecLabel: 'FLAC' },
                downloadStatus: 'idle',
                sessionAccumulatedSeconds: 7.5,
                sessionCounted: false,
                trackStats: { playCount: 4, totalPlayedSeconds: 125 },
              },
              dbTrack: null,
            },
          };
        }
        if (env.action === 'SET_WORK_MODE') {
          return { ok: true, settings: { mode: env.payload.mode, autoCaptureThresholdSeconds: 15, enableQualityUpgrade: true, archiveSubfolder: 'BiliMusic', groupMultiPartInSubdir: true } };
        }
        if (env.action === 'MANUAL_DOWNLOAD') {
          return { ok: true, taskId: 't-1', isUpgrade: false };
        }
        if (env.action === 'UPDATE_SETTINGS') {
          return { ok: true, settings: { mode: 'STATS_ONLY', autoCaptureThresholdSeconds: 20, enableQualityUpgrade: true, archiveSubfolder: 'BiliMusic', groupMultiPartInSubdir: true } };
        }
        if (env.action === 'GET_LEADERBOARD') {
          return {
            ok: true,
            data: {
              summary: { totalTracks: 1, totalPlayCount: 4, totalPlayedSeconds: 125 },
              items: [{ bvid: 'BV1pop', title: '测试歌曲', owner: '歌手X', playCount: 4, totalPlayedSeconds: 125, downloadId: 9, qualityId: 30251 }],
            },
          };
        }
        if (env.action === 'CLEAR_STATS') {
          clearStatsCalls += 1;
          return { ok: true };
        }
        return { ok: true };
      },
    },
  };

  try {
    await import(`../src/popup/popup.js?v=${Date.now()}`);
    for (const fn of docListeners.get('DOMContentLoaded') || []) {
      await fn();
    }
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(elMap.get('track-title').textContent, '测试歌曲');
    assert.equal(elMap.get('track-part').textContent, 'P2/3 · Live版');
    assert.equal(elMap.get('quality-badge').textContent, 'Hi-Res 无损 · FLAC');
    assert.equal(elMap.get('threshold-text').textContent, '7.5 / 15s');

    // 模式切换 STATS_ONLY
    await modeButtons[1].dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(elMap.get('mode-pill').textContent, 'STAT');

    // 手动下载
    await elMap.get('btn-manual-download').dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(sentMessages.some((m) => m.action === 'MANUAL_DOWNLOAD' && m.payload.tabId === 12));

    // 切换 Leaderboard Tab 并测试两步清空确认
    await tabButtons[1].dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(elMap.get('kpi-plays').textContent, '4');
    assert.equal(elMap.get('lb-list').children.length, 1);

    const clearBtn = elMap.get('btn-clear-stats');
    await clearBtn.dispatchEvent('click');
    assert.equal(clearStatsCalls, 0, 'First click must arm confirmation without clearing immediately');
    assert.equal(clearBtn.textContent, '确认清空?');

    await clearBtn.dispatchEvent('click');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(clearStatsCalls, 1, 'Second click must dispatch CLEAR_STATS');
  } finally {
    globalThis.document = prevDoc;
    globalThis.chrome = prevChrome;
  }
});
