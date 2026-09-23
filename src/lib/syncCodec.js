// chrome.storage.sync 변환·용량 계산. 순수 함수.
// 채널 1개 = 항목 1개('ch:{id}'), 설정 = 'settings'. 항목당 8KB 제한을 채널 수와 무관하게 피하기 위해 채널을 나눠 저장한다.
// 기기별 설정(debugMode, syncEnabled)은 동기화하지 않는다.

import { DEVICE_ONLY_SETTINGS, mergeSettings, normalizeChannel } from './settings.js';
import { isChannelId } from './chzzkUrl.js';
import { equalValue } from './equal.js';

export const CHANNEL_PREFIX = 'ch:';
export const SETTINGS_KEY = 'settings';
// chrome.storage.sync.QUOTA_BYTES / QUOTA_BYTES_PER_ITEM / MAX_ITEMS
export const QUOTA_BYTES = 102_400;
export const QUOTA_BYTES_PER_ITEM = 8_192;
export const MAX_ITEMS = 512;
// 여유분: 총량의 90%를 넘으면 쓰기 전에 막는다.
export const SAFE_RATIO = 0.9;

const isOurKey = (key) => key === SETTINGS_KEY || key.startsWith(CHANNEL_PREFIX);

export function syncableSettings(settings) {
  const out = { ...settings };
  for (const k of DEVICE_ONLY_SETTINGS) delete out[k];
  return out;
}

export function toSyncItems(channels, settings) {
  const items = { [SETTINGS_KEY]: syncableSettings(settings) };
  for (const [id, c] of Object.entries(channels)) {
    const { id: _omit, ...rest } = c;
    items[`${CHANNEL_PREFIX}${id}`] = rest;
  }
  return items;
}

/** sync 항목 → { channels, settings(없으면 null) }. 채널은 등록 순서(addedAt)로 정렬. */
export function fromSyncItems(items) {
  const entries = Object.entries(items || {})
    .filter(([k]) => k.startsWith(CHANNEL_PREFIX) && isChannelId(k.slice(CHANNEL_PREFIX.length)))
    .map(([k, v]) => [k.slice(CHANNEL_PREFIX.length), normalizeChannel(k.slice(CHANNEL_PREFIX.length), v)])
    .sort((a, b) => (a[1].addedAt || 0) - (b[1].addedAt || 0));
  return {
    channels: Object.fromEntries(entries),
    settings: items?.[SETTINGS_KEY] ? mergeSettings(items[SETTINGS_KEY]) : null,
  };
}

const utf8Length = (s) => new TextEncoder().encode(s).length;

/** chrome 방식과 같은 기준(키 + JSON 문자열 길이)으로 항목 크기 계산. */
export const itemBytes = (key, value) => utf8Length(key) + utf8Length(JSON.stringify(value));

export function checkQuota(items) {
  const keys = Object.keys(items);
  const sizes = keys.map((k) => itemBytes(k, items[k]));
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const oversized = keys.filter((_, i) => sizes[i] > QUOTA_BYTES_PER_ITEM);
  let reason = null;
  if (oversized.length) reason = 'item';
  else if (keys.length > MAX_ITEMS) reason = 'items';
  else if (totalBytes > QUOTA_BYTES * SAFE_RATIO) reason = 'total';
  return { ok: reason == null, reason, totalBytes, oversized, itemCount: keys.length };
}

/** 원격(sync)을 local 항목과 같게 만드는 최소 변경. 우리 키가 아닌 항목은 건드리지 않는다. */
export function diffItems(wanted, remote) {
  const set = {};
  for (const [k, v] of Object.entries(wanted)) if (!equalValue(v, remote?.[k])) set[k] = v;
  const remove = Object.keys(remote || {}).filter((k) => isOurKey(k) && !(k in wanted));
  return { set, remove, changed: Object.keys(set).length > 0 || remove.length > 0 };
}

/**
 * 동기화를 처음 켤 때(또는 이 기기에서 처음) 합치기.
 * 채널은 합집합(같은 ID는 원격 우선), 설정은 원격이 있으면 원격. 기기별 설정은 local 값 유지.
 */
export function mergeForInit(local, remote) {
  const channels = { ...local.channels, ...remote.channels };
  const ordered = Object.fromEntries(Object.entries(channels).sort((a, b) => (a[1].addedAt || 0) - (b[1].addedAt || 0)));
  const settings = remote.settings ? applyRemoteSettings(local.settings, remote.settings) : local.settings;
  return { channels: ordered, settings };
}

export function applyRemoteSettings(localSettings, remoteSettings) {
  const next = mergeSettings({ ...remoteSettings });
  for (const k of DEVICE_ONLY_SETTINGS) next[k] = localSettings[k];
  return next;
}
