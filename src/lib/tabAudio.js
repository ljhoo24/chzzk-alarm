// 백그라운드에서 새로고침·자동으로 연 탭의 음소거와, 사용자가 그 탭을 볼 때 음소거 해제.
// 확장이 음소거한 탭만 해제한다(사용자가 직접 음소거한 탭은 건드리지 않음).

import { getMutedByUs, setMutedByUs } from './storage.js';

export async function muteTab(tabId) {
  await chrome.tabs.update(tabId, { muted: true });
  await setMutedByUs(tabId, true);
}

async function unmuteIfOurs(tabId) {
  const muted = await getMutedByUs();
  if (!muted[tabId]) return;
  await setMutedByUs(tabId, false);
  try {
    await chrome.tabs.update(tabId, { muted: false });
  } catch {
    // 이미 닫힌 탭
  }
}

export async function onTabActivated({ tabId }) {
  await unmuteIfOurs(tabId);
}

/** 다른 창에서 활성 탭이던 탭은 창 포커스가 바뀔 때 보이게 된다. */
export async function onWindowFocusChanged(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await unmuteIfOurs(tab.id);
}

export async function onTabRemovedAudio(tabId) {
  await setMutedByUs(tabId, false);
}
