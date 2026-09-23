// Notifier: 방송 시작·재알림·방송 중 변경 알림, 감지 중단 경고, 알림 클릭·버튼 처리.

import { liveUrl } from './chzzkUrl.js';

const DEFAULT_ICON = 'icons/icon128.png';
export const STALL_NOTIFICATION_ID = 'stall';
export const SNOOZE_ALARM_PREFIX = 'snooze|';
export const SNOOZE_MINUTES = 30;

// 알림 ID: '{kind}|{channelId}|{openDate}'  kind = live | change
export const notificationId = (channelId, openDate, kind = 'live') => `${kind}|${channelId}|${openDate}`;

export function parseNotificationId(id) {
  if (typeof id !== 'string') return null;
  const [kind, channelId, openDate] = id.split('|');
  if ((kind !== 'live' && kind !== 'change') || !channelId) return null;
  return { kind, channelId, openDate };
}

export const snoozeAlarmName = (channelId, openDate) => `${SNOOZE_ALARM_PREFIX}${channelId}|${openDate}`;

export function parseSnoozeAlarm(name) {
  if (typeof name !== 'string' || !name.startsWith(SNOOZE_ALARM_PREFIX)) return null;
  const [channelId, openDate] = name.slice(SNOOZE_ALARM_PREFIX.length).split('|');
  return channelId ? { channelId, openDate } : null;
}

/** 로컬 기준 다음 자정(= "오늘" 끝). */
export function endOfToday(now) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
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

const BUTTONS = [{ title: `${SNOOZE_MINUTES}분 뒤 다시 알림` }, { title: '오늘 이 채널 알림 끄기' }];

async function createWithIcon(id, options, imageUrl) {
  const icon = await profileIconDataUrl(imageUrl);
  const fallback = chrome.runtime.getURL(DEFAULT_ICON);
  try {
    await chrome.notifications.create(id, { ...options, iconUrl: icon || fallback });
  } catch (e) {
    if (!icon) throw e;
    // 변환한 이미지가 알림에서 거부되면 기본 아이콘으로 재시도.
    await chrome.notifications.create(id, { ...options, iconUrl: fallback });
  }
}

/**
 * @param channel { id, name, imageUrl }
 * @param state   { openDate, title, category }
 * @param opts    { kind: 'start' | 'reminder' | 'change', change?: { categoryFrom, categoryTo, keywordMatched } }
 */
export async function notifyLive(channel, state, settings, opts = {}) {
  const kind = opts.kind ?? 'start';
  const name = channel.name || channel.id;
  let title = `${name} 방송 시작`;
  let contextMessage = state.category || '치지직';
  if (kind === 'reminder') title = `${name} 방송 중`;
  if (kind === 'change') {
    const c = opts.change ?? {};
    title = c.categoryTo ? `${name} 카테고리 변경` : `${name} 키워드 일치`;
    contextMessage = c.categoryTo ? `${c.categoryFrom} → ${c.categoryTo}` : contextMessage;
  }
  await createWithIcon(
    notificationId(channel.id, state.openDate, kind === 'change' ? 'change' : 'live'),
    {
      type: 'basic',
      title,
      message: state.title || '(제목 없음)',
      contextMessage,
      priority: 2,
      requireInteraction: !!settings.requireInteraction,
      buttons: BUTTONS,
    },
    channel.imageUrl,
  );
}

/** 연속 조회 실패 경고(한 번만). 클릭하면 설정 페이지. */
export async function notifyStall(names) {
  await chrome.notifications.create(STALL_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(DEFAULT_ICON),
    title: '치지직 방송 감지가 멈췄을 수 있습니다',
    message: `상태 조회 연속 실패: ${names.join(', ')}`,
    contextMessage: '비공식 API 변경 또는 네트워크 문제',
    priority: 2,
  });
}

export async function clearStall() {
  await chrome.notifications.clear(STALL_NOTIFICATION_ID);
}

/**
 * 해당 채널의 라이브 탭이 있으면 활성화, 없으면 새 탭으로 연다.
 * @param opts { active=true } false면 백그라운드 새 탭(기존 탭은 건드리지 않음)
 */
export async function openLiveTab(channelId, { active = true } = {}) {
  const tabs = await chrome.tabs.query({ url: `${liveUrl(channelId)}*` });
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (tab) {
    if (active) await focusTab(tab);
    return { tab, created: false };
  }
  let created;
  try {
    created = await chrome.tabs.create({ url: liveUrl(channelId), active });
  } catch {
    // 열린 창이 없을 때(크롬이 백그라운드로만 실행 중) 새 창으로 연다.
    const win = await chrome.windows.create({ url: liveUrl(channelId), focused: active });
    created = win.tabs?.[0] ?? { id: undefined, windowId: win.id };
    return { tab: created, created: true };
  }
  if (active) await chrome.windows.update(created.windowId, { focused: true });
  return { tab: created, created: true };
}

export async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** 알림 본문 클릭: 방송 탭 열기. 경고 알림은 설정 페이지. */
export async function onNotificationClicked(id) {
  if (id === STALL_NOTIFICATION_ID) {
    await chrome.runtime.openOptionsPage();
    await chrome.notifications.clear(id);
    return;
  }
  const parsed = parseNotificationId(id);
  if (!parsed) return;
  await openLiveTab(parsed.channelId);
  await chrome.notifications.clear(id);
}

/**
 * 알림 버튼: 0 = 30분 뒤 다시 알림, 1 = 오늘 이 채널 알림 끄기.
 * @param deps { setChannelMute(id, until) }
 */
export async function onNotificationButtonClicked(id, buttonIndex, deps) {
  const parsed = parseNotificationId(id);
  if (!parsed) return;
  if (buttonIndex === 0) {
    await chrome.alarms.create(snoozeAlarmName(parsed.channelId, parsed.openDate), { delayInMinutes: SNOOZE_MINUTES });
  } else if (buttonIndex === 1) {
    await deps.setChannelMute(parsed.channelId, endOfToday(Date.now()));
  }
  await chrome.notifications.clear(id);
}
