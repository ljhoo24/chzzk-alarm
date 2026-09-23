// 치지직 URL/채널 ID 관련 순수 함수.

export const CHZZK_ORIGIN = 'https://chzzk.naver.com';
export const LIVE_URL_PATTERN = `${CHZZK_ORIGIN}/live/*`;

const CHANNEL_ID_RE = /^[0-9a-f]{32}$/i;

export function isChannelId(value) {
  return typeof value === 'string' && CHANNEL_ID_RE.test(value);
}

/**
 * 채널 URL(라이브 페이지, 채널 홈 등) 또는 채널 ID 문자열에서 채널 ID를 추출한다.
 * 추출할 수 없으면 null.
 */
export function extractChannelId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (isChannelId(text)) return text.toLowerCase();

  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/(^|\.)chzzk\.naver\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const found = segments.find(isChannelId);
  return found ? found.toLowerCase() : null;
}

/** 라이브 페이지 URL(https://chzzk.naver.com/live/{channelId})이면 채널 ID, 아니면 null. */
export function liveChannelIdFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== 'chzzk.naver.com') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'live' || !isChannelId(segments[1] ?? '')) return null;
  return segments[1].toLowerCase();
}

export function liveUrl(channelId) {
  return `${CHZZK_ORIGIN}/live/${channelId}`;
}
