// Scheduler: 알람 등록·재등록, 한 주기 안에서 채널 요청 간격 분산.

export const POLL_ALARM = 'poll';

// 한 주기 동안 요청을 이 시간 안에 흩뿌린다(30초 주기보다 충분히 짧게).
const SPREAD_WINDOW_MS = 20_000;
const MAX_GAP_MS = 1_000;

/** 채널 수 N일 때 요청 사이 간격(ms). */
export function requestGap(n) {
  if (n <= 1) return 0;
  return Math.min(MAX_GAP_MS, Math.floor(SPREAD_WINDOW_MS / n));
}

/** 알람이 없거나 주기가 다르면 다시 만든다. 브라우저 재시작 시 알람이 사라질 수 있어 시작 시마다 호출한다. */
export async function ensurePollAlarm(settings) {
  const periodInMinutes = settings.pollIntervalSec / 60;
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (existing && Math.abs((existing.periodInMinutes ?? 0) - periodInMinutes) < 1e-6) return false;
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes, delayInMinutes: 0.5 });
  return true;
}
