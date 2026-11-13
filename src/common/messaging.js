/**
 * @fileoverview 统一消息信封组装器与 target 路由过滤器（SW / Popup 共用）。
 */

import { MSG_TARGET } from './constants.js';

const ENVELOPE_VERSION = 1;

/**
 * 组装标准跨运行域消息信封。
 * @param {string} target 目标运行域（参见 MSG_TARGET）
 * @param {string} action 动作常量（参见 ACTION）
 * @param {unknown} [payload={}] 业务载荷
 * @param {Record<string, unknown>} [meta={}] 可选附加元字段（如 tabId）
 * @returns {{ __bm: number, target: string, action: string, payload: unknown, timestamp: number }}
 */
export function createEnvelope(target, action, payload = {}, meta = {}) {
  if (typeof target !== 'string' || !target) {
    throw new TypeError('createEnvelope requires a non-empty string target');
  }
  if (typeof action !== 'string' || !action) {
    throw new TypeError('createEnvelope requires a non-empty string action');
  }
  return {
    ...meta,
    __bm: ENVELOPE_VERSION,
    target,
    action,
    payload,
    timestamp: Date.now(),
  };
}

/**
 * 校验输入消息是否为发往指定目标域的合法信封。
 * @param {unknown} message
 * @param {string} expectedTarget
 * @returns {boolean}
 */
export function isEnvelopeFor(message, expectedTarget) {
  return Boolean(
    message &&
      typeof message === 'object' &&
      message.__bm === ENVELOPE_VERSION &&
      message.target === expectedTarget &&
      typeof message.action === 'string' &&
      message.action.length > 0
  );
}

/**
 * 创建基于 target 过滤的 chrome.runtime.onMessage 路由器。
 * 返回监听器函数 `(message, sender, sendResponse) => boolean`。
 * @param {string} expectedTarget 当前运行域标识
 * @param {Record<string, (payload: any, sender: any, envelope: any) => unknown>} handlers Action 映射表
 * @returns {(message: unknown, sender: unknown, sendResponse: (res: unknown) => void) => boolean}
 */
export function createMessageRouter(expectedTarget, handlers) {
  return function routeMessage(message, sender, sendResponse) {
    if (!isEnvelopeFor(message, expectedTarget)) {
      return false;
    }
    const handler = handlers && Object.hasOwn(handlers, message.action) ? handlers[message.action] : null;
    if (typeof handler !== 'function') {
      return false;
    }

    Promise.resolve()
      .then(() => handler(message.payload, sender, message))
      .then((result) => {
        if (result !== undefined && result !== null && typeof result === 'object' && Object.hasOwn(result, 'ok')) {
          sendResponse(result);
        } else {
          sendResponse({ ok: true, data: result });
        }
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      });

    return true;
  };
}

/**
 * 发送消息给后台 Service Worker。
 * @param {string} action
 * @param {unknown} [payload={}]
 * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
 */
export async function sendToBackground(action, payload = {}) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) {
    return { ok: false, error: 'chrome.runtime.sendMessage unavailable' };
  }
  try {
    const res = await runtime.sendMessage(createEnvelope(MSG_TARGET.BACKGROUND, action, payload));
    return res ?? { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 向 Popup 推送消息（Popup 未打开时静默忽略断连错误）。
 * @param {string} action
 * @param {unknown} [payload={}]
 * @returns {Promise<boolean>} 是否送达
 */
export async function notifyPopup(action, payload = {}) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) return false;
  try {
    await runtime.sendMessage(createEnvelope(MSG_TARGET.POPUP, action, payload));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 向指定 B 站标签页的 Content Script 下发指令。
 * @param {number} tabId
 * @param {string} action
 * @param {unknown} [payload={}]
 * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
 */
export async function sendToTab(tabId, action, payload = {}) {
  const tabs = globalThis.chrome?.tabs;
  if (!Number.isInteger(tabId) || tabId < 0 || !tabs?.sendMessage) {
    return { ok: false, error: 'invalid tabId or chrome.tabs unavailable' };
  }
  try {
    const res = await tabs.sendMessage(tabId, createEnvelope(MSG_TARGET.CONTENT, action, payload, { tabId }));
    return res ?? { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
