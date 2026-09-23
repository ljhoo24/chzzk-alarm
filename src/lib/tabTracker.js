// TabTracker: 치지직 라이브 URL 탭의 로드·URL 변경 시각을 기록한다(폴링과 무관하게 동작).
// 치지직은 SPA라 사이트 내부 이동 시 URL만 바뀌므로 URL 변경 시각도 로드 시각으로 취급한다.
// 호스트 권한 덕분에 치지직 도메인 탭의 URL만 보이며, 다른 도메인 탭은 url이 undefined로 온다.

import { LIVE_URL_PATTERN, liveChannelIdFromUrl } from './chzzkUrl.js';
import { getTabState, putTabState, removeReloadLogForTab } from './storage.js';

export async function onTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = changeInfo.url ?? tab?.url;
  if (!url) return; // 권한 밖 도메인
  const channelId = liveChannelIdFromUrl(url);
  if (channelId) {
    await putTabState(tabId, { channelId, loadedAt: Date.now() });
  } else {
    await putTabState(tabId, null);
  }
}

export async function onTabRemoved(tabId) {
  await Promise.all([putTabState(tabId, null), removeReloadLogForTab(tabId)]);
}

export async function onTabReplaced(addedTabId, removedTabId) {
  const all = await getTabState();
  const prev = all[removedTabId];
  await putTabState(removedTabId, null);
  if (prev) await putTabState(addedTabId, prev);
}

/**
 * 설치·브라우저 시작·워커 시작 시 이미 열려 있는 라이브 탭 중 기록이 없는 탭을 "지금 로드됨"으로 기록한다.
 * 로드 시각을 알 수 없는 탭이 이미 진행 중인 방송 때문에 새로고침되는 일을 막는다.
 */
export async function seedExistingTabs() {
  const [tabs, all] = await Promise.all([chrome.tabs.query({ url: LIVE_URL_PATTERN }), getTabState()]);
  const now = Date.now();
  for (const tab of tabs) {
    const channelId = liveChannelIdFromUrl(tab.url);
    if (!channelId) continue;
    const rec = all[tab.id];
    if (rec && rec.channelId === channelId) continue;
    await putTabState(tab.id, { channelId, loadedAt: now });
  }
}
