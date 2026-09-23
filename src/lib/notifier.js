// Notifier: 방송 시작 알림 생성, 클릭 시 방송 탭 열기(이미 있으면 활성화).

import { liveUrl } from './chzzkUrl.js';

const NOTIFICATION_PREFIX = 'live|';
const DEFAULT_ICON = 'icons/icon128.png';

export const notificationId = (channelId, openDate) => `${NOTIFICATION_PREFIX}${channelId}|${openDate}`;

export function parseNotificationId(id) {
  if (typeof id !== 'string' || !id.startsWith(NOTIFICATION_PREFIX)) return null;
  const [channelId, openDate] = id.slice(NOTIFICATION_PREFIX.length).split('|');
  return channelId ? { channelId, openDate } : null;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 프로필 이미지를 data URL로 변환(알림 API는 원격 URL을 받지 않음). 실패 시 null. */
async function profileIconDataUrl(imageUrl) {
  if (!imageUrl) return null;
  try {
    const url = new URL(imageUrl);
    if (!url.searchParams.has('type')) url.searchParams.set('type', 'f120_120_na');
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/png';
    if (!type.startsWith('image/')) return null;
    return `data:${type};base64,${arrayBufferToBase64(await res.arrayBuffer())}`;
  } catch {
    return null;
  }
}

/**
 * @param channel { id, name, imageUrl }
 * @param state   { openDate, title, category }
 */
export async function notifyLive(channel, state, settings) {
  const id = notificationId(channel.id, state.openDate);
  const base = {
    type: 'basic',
    title: `${channel.name || channel.id} 방송 시작`,
    message: state.title || '(제목 없음)',
    contextMessage: state.category || '치지직',
    priority: 2,
    requireInteraction: !!settings.requireInteraction,
  };
  const icon = await profileIconDataUrl(channel.imageUrl);
  try {
    await chrome.notifications.create(id, { ...base, iconUrl: icon || chrome.runtime.getURL(DEFAULT_ICON) });
  } catch (e) {
    if (!icon) throw e;
    // 변환한 이미지가 알림에서 거부되면 기본 아이콘으로 재시도.
    await chrome.notifications.create(id, { ...base, iconUrl: chrome.runtime.getURL(DEFAULT_ICON) });
  }
}

/** 해당 채널의 라이브 탭이 있으면 활성화, 없으면 새 탭으로 연다. */
export async function openLiveTab(channelId) {
  const tabs = await chrome.tabs.query({ url: `${liveUrl(channelId)}*` });
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  return chrome.tabs.create({ url: liveUrl(channelId) });
}

export async function onNotificationClicked(id) {
  const parsed = parseNotificationId(id);
  if (!parsed) return;
  await openLiveTab(parsed.channelId);
  await chrome.notifications.clear(id);
}
