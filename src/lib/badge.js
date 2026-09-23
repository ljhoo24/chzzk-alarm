// BadgeUpdater: 라이브 채널 수를 툴바 배지로 표시하고, 연속 조회 실패 시 경고한다.

import { getAllChannelState, getChannels, getSettings } from './storage.js';

const COLOR_LIVE = '#00a86b';
const COLOR_WARN = '#d93025';

export function summarize(channels, states, failWarnThreshold) {
  const ids = Object.keys(channels);
  const live = ids.filter((id) => states[id]?.status === 'OPEN');
  const failing = ids.filter((id) => (states[id]?.failCount ?? 0) >= failWarnThreshold);
  return { live, failing, total: ids.length };
}

export async function updateBadge() {
  const [channels, states, settings] = await Promise.all([getChannels(), getAllChannelState(), getSettings()]);
  const { live, failing, total } = summarize(channels, states, settings.failWarnThreshold);

  let text = live.length > 0 ? String(live.length) : '';
  let color = COLOR_LIVE;
  const lines = [`치지직 라이브 알림 — 라이브 ${live.length} / 등록 ${total}`];
  for (const id of live) lines.push(`● ${channels[id].name || id}`);

  if (failing.length > 0) {
    text = live.length > 0 ? `${live.length}!` : '!';
    color = COLOR_WARN;
    lines.push(`⚠ 상태 조회 연속 실패: ${failing.map((id) => channels[id].name || id).join(', ')}`);
  }
  if (settings.debugMode) lines.push('[디버그: 모의 상태 제공자 사용 중]');

  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setBadgeTextColor?.({ color: '#ffffff' }),
    chrome.action.setTitle({ title: lines.join('\n') }),
  ]);
}
