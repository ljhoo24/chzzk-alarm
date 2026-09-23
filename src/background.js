// 서비스 워커 진입점. 무상태: 모든 상태는 chrome.storage에 있고, 여기서는 이벤트만 연결한다.
// 리스너는 워커가 깨어날 때 이벤트를 받을 수 있도록 반드시 최상위에서 동기적으로 등록한다.

import { updateBadge } from './lib/badge.js';
import { onNotificationClicked, openLiveTab } from './lib/notifier.js';
import { runPoll } from './lib/poller.js';
import { POLL_ALARM, ensurePollAlarm } from './lib/scheduler.js';
import { getSettings } from './lib/storage.js';
import { onTabRemoved, onTabReplaced, onTabUpdated, seedExistingTabs } from './lib/tabTracker.js';

function logError(where) {
  return (e) => console.error(`[chzzk-alarm] ${where}:`, e);
}

async function bootstrap(reason) {
  const settings = await getSettings();
  await ensurePollAlarm(settings);
  await seedExistingTabs();
  await updateBadge();
  if (reason === 'install' || reason === 'startup') await runPoll();
}

chrome.runtime.onInstalled.addListener((details) => {
  bootstrap(details.reason === 'install' ? 'install' : 'startup').catch(logError('onInstalled'));
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap('startup').catch(logError('onStartup'));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) runPoll().catch(logError('poll'));
});

chrome.notifications.onClicked.addListener((id) => {
  onNotificationClicked(id).catch(logError('notification click'));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  onTabUpdated(tabId, changeInfo, tab).catch(logError('tabs.onUpdated'));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  onTabRemoved(tabId).catch(logError('tabs.onRemoved'));
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  onTabReplaced(added, removed).catch(logError('tabs.onReplaced'));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    getSettings()
      .then((s) => ensurePollAlarm(s))
      .then(updateBadge)
      .catch(logError('settings change'));
  } else if (changes.channels) {
    updateBadge().catch(logError('channels change'));
  }
});

// 팝업·옵션 페이지 요청.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    pollNow: () => runPoll(),
    openLive: () => openLiveTab(msg.channelId).then(() => ({ ok: true })),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // 비동기 응답
});

// 워커가 (재)시작될 때마다 알람 존재 확인. 알람 소실 대비.
getSettings().then(ensurePollAlarm).catch(logError('ensure alarm'));
