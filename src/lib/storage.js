// 확장 저장소 접근 계층. 서비스 워커는 언제든 종료될 수 있으므로 모든 상태는 여기에 둔다.
//  local  : 브라우저 재시작 후에도 유지 (channels, channelState, settings, mockStatus, meta)
//  session: 재시작 시 비워짐 (tabState, reloadLog, observedThisSession)

import { mergeSettings, normalizeChannel } from './settings.js';
import { reloadLogKey } from './reloadLogKey.js';

const local = chrome.storage.local;
const session = chrome.storage.session;

// 같은 키에 대한 읽기-수정-쓰기가 겹치지 않도록 키별로 직렬화한다(탭 이벤트가 연달아 올 때 등).
const queues = new Map();
function serialized(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function getKey(area, key, fallback) {
  const res = await area.get(key);
  return res[key] ?? fallback;
}

// ---- channels ----
export async function getChannels() {
  const raw = await getKey(local, 'channels', {});
  return Object.fromEntries(Object.entries(raw).map(([id, c]) => [id, normalizeChannel(id, c)]));
}

export async function saveChannels(channels) {
  await local.set({ channels });
}

export function upsertChannel(id, patch) {
  return serialized('channels', async () => {
    const channels = await getChannels();
    channels[id] = normalizeChannel(id, { ...channels[id], ...patch });
    await saveChannels(channels);
    return channels[id];
  });
}

export async function removeChannel(id) {
  const [channels, states] = await Promise.all([getChannels(), getAllChannelState()]);
  delete channels[id];
  delete states[id];
  await local.set({ channels, channelState: states });
}

// ---- channelState ----
export async function getAllChannelState() {
  return getKey(local, 'channelState', {});
}

/** 채널 하나의 상태만 갱신(읽기-수정-쓰기). 채널별 처리 직후 호출한다. */
export function putChannelState(id, state) {
  return serialized('channelState', async () => {
    const states = await getAllChannelState();
    states[id] = state;
    await local.set({ channelState: states });
  });
}

export function pruneChannelState(validIds) {
  return serialized('channelState', async () => {
    const states = await getAllChannelState();
    let changed = false;
    for (const id of Object.keys(states)) {
      if (!validIds.has(id)) {
        delete states[id];
        changed = true;
      }
    }
    if (changed) await local.set({ channelState: states });
  });
}

// ---- settings ----
export async function getSettings() {
  return mergeSettings(await getKey(local, 'settings', {}));
}

export function saveSettings(patch) {
  return serialized('settings', async () => {
    const current = await getKey(local, 'settings', {});
    const next = mergeSettings({ ...current, ...patch });
    await local.set({ settings: next });
    return next;
  });
}

// ---- meta ----
export async function getMeta() {
  return getKey(local, 'meta', {});
}

export function patchMeta(patch) {
  return serialized('meta', async () => {
    const meta = await getMeta();
    await local.set({ meta: { ...meta, ...patch } });
  });
}

// ---- 최근 이벤트 기록(옵션 페이지 확인용, 최대 50건) ----
const EVENT_LOG_MAX = 50;

export async function getEventLog() {
  return getKey(local, 'eventLog', []);
}

export function appendEventLog(entry) {
  return serialized('eventLog', async () => {
    const log = await getEventLog();
    log.unshift(entry);
    await local.set({ eventLog: log.slice(0, EVENT_LOG_MAX) });
  });
}

// ---- mock (debug) ----
export async function getMockStatus() {
  return getKey(local, 'mockStatus', {});
}

export function setMockStatus(id, value) {
  return serialized('mockStatus', async () => {
    const all = await getMockStatus();
    if (value == null) delete all[id];
    else all[id] = value;
    await local.set({ mockStatus: all });
  });
}

// ---- tabState (session) ----
export async function getTabState() {
  return getKey(session, 'tabState', {});
}

export function putTabState(tabId, value) {
  return serialized('tabState', async () => {
    const all = await getTabState();
    if (value == null) delete all[tabId];
    else all[tabId] = value;
    await session.set({ tabState: all });
  });
}

// ---- reloadLog (session) ----
export async function getReloadLog() {
  return getKey(session, 'reloadLog', {});
}

export function addReloadLog(tabId, openDate, at) {
  return serialized('reloadLog', async () => {
    const log = await getReloadLog();
    log[reloadLogKey(tabId, openDate)] = at;
    await session.set({ reloadLog: log });
  });
}

export function removeReloadLogForTab(tabId) {
  return serialized('reloadLog', async () => {
    const log = await getReloadLog();
    const prefix = `${tabId}|`;
    let changed = false;
    for (const key of Object.keys(log)) {
      if (key.startsWith(prefix)) {
        delete log[key];
        changed = true;
      }
    }
    if (changed) await session.set({ reloadLog: log });
  });
}

// ---- 세션 내 관측 여부 (브라우저 시작 직후 판정용) ----
export async function getObservedThisSession() {
  return getKey(session, 'observedThisSession', {});
}

export function markObservedThisSession(id) {
  return serialized('observedThisSession', async () => {
    const all = await getObservedThisSession();
    if (all[id]) return;
    all[id] = true;
    await session.set({ observedThisSession: all });
  });
}
