// 구글 계정 동기화(chrome.storage.sync). 서비스 워커에서만 호출한다.
//
// - local이 실행 기준, sync는 사본. 이 기기에서 채널·설정을 바꾸면 sync로 밀어 넣고(push),
//   다른 기기의 변경이 들어오면(sync onChanged) local에 반영한다(pull).
// - 이 기기에서 처음 켤 때는 합집합으로 합친다(mergeForInit). 이후 삭제도 기기 간에 반영된다.
// - 용량을 넘으면 쓰지 않고 상태를 'quota'로 남긴다. 옵션 페이지가 파일 백업을 안내한다.
//   push가 실패한 동안에는 pull도 멈춘다(동기화되지 않은 local 변경을 원격 값으로 덮지 않기 위해).
// - 크롬에 로그인하지 않았거나 확장 동기화가 꺼져 있으면 sync는 이 기기에만 저장된다.

import {
  applyRemoteSettings,
  checkQuota,
  diffItems,
  fromSyncItems,
  mergeForInit,
  toSyncItems,
} from './syncCodec.js';
import { getChannels, getSettings, saveChannels } from './storage.js';

const local = chrome.storage.local;
const sync = chrome.storage.sync;

let chain = Promise.resolve();
const serialized = (fn) => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

async function setStatus(status) {
  await local.set({ syncStatus: { ...status, at: Date.now() } });
}

export async function getSyncStatus() {
  return (await local.get('syncStatus')).syncStatus ?? { state: 'off' };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function writeLocal(channels, settings) {
  const [curChannels, curSettings] = await Promise.all([getChannels(), getSettings()]);
  if (!same(curChannels, channels)) await saveChannels(channels);
  if (!same(curSettings, settings)) await local.set({ settings });
}

async function pushNow() {
  const [channels, settings] = await Promise.all([getChannels(), getSettings()]);
  if (!settings.syncEnabled) return setStatus({ state: 'off' });

  const items = toSyncItems(channels, settings);
  const quota = checkQuota(items);
  if (!quota.ok) {
    return setStatus({ state: 'quota', reason: quota.reason, totalBytes: quota.totalBytes, itemCount: quota.itemCount, oversized: quota.oversized });
  }
  try {
    const remote = await sync.get(null);
    const { set, remove, changed } = diffItems(items, remote);
    if (changed) {
      if (Object.keys(set).length) await sync.set(set);
      if (remove.length) await sync.remove(remove);
    }
    await setStatus({ state: 'ok', totalBytes: await sync.getBytesInUse(null), itemCount: quota.itemCount });
  } catch (e) {
    const message = String(e?.message ?? e);
    await setStatus({ state: /quota/i.test(message) ? 'quota' : 'error', error: message, totalBytes: quota.totalBytes });
  }
}

async function pullNow() {
  const settings = await getSettings();
  if (!settings.syncEnabled) return;
  const status = await getSyncStatus();
  if (status.state === 'quota' || status.state === 'error') return pushNow(); // 실패 상태면 local 기준으로 재시도

  const remote = fromSyncItems(await sync.get(null));
  if (!remote.settings && Object.keys(remote.channels).length === 0) return pushNow(); // 원격이 비어 있음
  const channels = remote.channels;
  const nextSettings = remote.settings ? applyRemoteSettings(settings, remote.settings) : settings;
  await writeLocal(channels, nextSettings);
}

async function initNow() {
  const settings = await getSettings();
  if (!settings.syncEnabled) return setStatus({ state: 'off' });
  const [channels, remoteItems] = await Promise.all([getChannels(), sync.get(null)]);
  const merged = mergeForInit({ channels, settings }, fromSyncItems(remoteItems));
  await writeLocal(merged.channels, merged.settings);
  await local.set({ syncInitialized: true });
  await pushNow();
}

/** 시작 시: 이 기기에서 처음이면 합치기, 아니면 원격 반영. */
export function startSync() {
  return serialized(async () => {
    const { syncInitialized } = await local.get('syncInitialized');
    return syncInitialized ? pullNow() : initNow();
  });
}

export const pushToSync = () => serialized(pushNow);
export const pullFromSync = () => serialized(pullNow);

/** 동기화를 켜면 합치기부터 다시, 끄면 상태만 off. */
export function onSyncToggled(enabled) {
  return serialized(async () => {
    if (enabled) {
      await local.set({ syncInitialized: false });
      return initNow();
    }
    return setStatus({ state: 'off' });
  });
}

export const isSyncKeyChange = (changes) => Object.keys(changes).some((k) => k === 'settings' || k.startsWith('ch:'));
