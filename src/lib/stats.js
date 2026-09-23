// 방송 기록 통계. 순수 함수(시각은 로컬 시간대 기준으로 집계).

import { parseKst } from './time.js';

const DAY = 86_400_000;
export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

/** 레코드의 시작·종료 ms. 종료 기록이 없으면 마지막 관측 시각(진행 중이면 사실상 현재). */
export function spanOf(r) {
  const start = parseKst(r.openDate);
  if (start == null) return null;
  const end = parseKst(r.closeDate) ?? r.lastSeenAt ?? start;
  return { start, end: Math.max(start, end) };
}

export function filterRecords(history, { channelId = null, sinceMs = null } = {}) {
  return history.filter((r) => {
    if (channelId && r.channelId !== channelId) return false;
    const span = spanOf(r);
    if (!span) return false;
    return sinceMs == null || span.start >= sinceMs;
  });
}

const minuteOfDay = (ms) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * 시작 시각의 원형 평균(자정을 넘는 23:50/00:10 → 00:00).
 * @returns {{ minute: number, concentration: number } | null} concentration 0~1(1이면 매번 같은 시각)
 */
export function typicalStart(startsMs) {
  if (startsMs.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const ms of startsMs) {
    const a = (minuteOfDay(ms) / 1440) * 2 * Math.PI;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  x /= startsMs.length;
  y /= startsMs.length;
  const concentration = Math.hypot(x, y);
  let angle = Math.atan2(y, x);
  if (angle < 0) angle += 2 * Math.PI;
  return { minute: Math.round((angle / (2 * Math.PI)) * 1440) % 1440, concentration };
}

export const formatMinute = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 팝업용 "보통 HH:MM 시작". 기록이 3회 미만이거나 시작 시각이 들쭉날쭉하면 null. */
export function typicalStartLabel(history, channelId, { recent = 20, minCount = 3, minConcentration = 0.6 } = {}) {
  const starts = history
    .filter((r) => r.channelId === channelId)
    .map((r) => parseKst(r.openDate))
    .filter((v) => v != null)
    .sort((a, b) => b - a)
    .slice(0, recent);
  if (starts.length < minCount) return null;
  const t = typicalStart(starts);
  return t && t.concentration >= minConcentration ? formatMinute(t.minute) : null;
}

/** 요일(월=0) × 시(0~23) 방송 시작 횟수. */
export function startHeatmap(records) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of records) {
    const span = spanOf(r);
    if (!span) continue;
    const d = new Date(span.start);
    grid[(d.getDay() + 6) % 7][d.getHours()]++;
  }
  return grid;
}

/** 로컬 기준 해당 주 월요일 0시. */
export function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** 최근 weeks주 주별 방송 시간(시간)·횟수. 오래된 주부터. 시작 시각이 속한 주로 집계. */
export function weeklyTotals(records, now, weeks = 12) {
  const thisWeek = weekStart(now);
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - i * 7);
    buckets.push({ weekStart: d.getTime(), hours: 0, count: 0 });
  }
  const index = new Map(buckets.map((b, i) => [b.weekStart, i]));
  for (const r of records) {
    const span = spanOf(r);
    if (!span) continue;
    const i = index.get(weekStart(span.start));
    if (i == null) continue;
    buckets[i].hours += (span.end - span.start) / 3_600_000;
    buckets[i].count++;
  }
  return buckets;
}

/** 카테고리별 방송 시간(시간). 한 방송에 카테고리가 여럿이면 균등 분배. 상위 top개 + 기타. */
export function categoryHours(records, top = 8) {
  const map = new Map();
  for (const r of records) {
    const span = spanOf(r);
    if (!span) continue;
    const cats = r.categories?.length ? r.categories : ['(카테고리 없음)'];
    const share = (span.end - span.start) / 3_600_000 / cats.length;
    for (const c of cats) map.set(c, (map.get(c) ?? 0) + share);
  }
  const sorted = [...map.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours);
  if (sorted.length <= top) return sorted;
  const rest = sorted.slice(top).reduce((sum, c) => sum + c.hours, 0);
  return [...sorted.slice(0, top), { name: '기타', hours: rest, other: true }];
}

export function summarizeRecords(records) {
  const spans = records.map(spanOf).filter(Boolean);
  const total = spans.reduce((s, x) => s + (x.end - x.start), 0);
  const withViewers = records.filter((r) => r.viewerSamples > 0);
  return {
    count: records.length,
    totalMs: total,
    avgMs: spans.length ? total / spans.length : 0,
    typical: typicalStart(spans.map((x) => x.start)),
    peakViewers: records.reduce((m, r) => Math.max(m, r.peakViewers || 0), 0),
    avgViewers: withViewers.length
      ? withViewers.reduce((s, r) => s + r.viewerSum / r.viewerSamples, 0) / withViewers.length
      : 0,
  };
}

export const periodStart = (now, days) => (days ? now - days * DAY : null);
