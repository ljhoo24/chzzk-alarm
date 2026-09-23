// 시간 관련 순수 함수.

/**
 * 치지직 API 시각 문자열("2026-09-23 16:52:15", KST)을 epoch ms로 변환한다.
 * 형식이 맞지 않으면 null.
 */
export function parseKst(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}+09:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** epoch ms → 치지직 API 형식 KST 문자열. 모의 상태 제공자에서 사용. */
export function formatKst(ms) {
  const d = new Date(ms + 9 * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** "HH:MM" → 자정 기준 분. 형식 오류 시 null. */
export function parseHm(value) {
  const m = typeof value === 'string' && value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 로컬 시각 기준으로 now가 [start, end) 구간에 있는지. 자정을 넘기는 구간(23:00~07:00) 지원. */
export function isWithinDailyWindow(now, start, end) {
  const s = parseHm(start);
  const e = parseHm(end);
  if (s == null || e == null || s === e) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** 경과 시간 표시("1:05:09", "12:03"). */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
