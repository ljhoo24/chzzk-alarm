// v1.0 순수 모듈: 방송 중 변경 판정, 탭 열기 판정, 방송 기록, 통계, 동기화 코덱, 백업 형식.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideChange, evaluate, INITIAL_STATE, shouldOpenOnLive } from '../src/lib/transition.js';
import { applyObservation, HISTORY_MAX, mergeHistory } from '../src/lib/history.js';
import {
  categoryHours,
  startHeatmap,
  summarizeRecords,
  typicalStart,
  typicalStartLabel,
  weekStart,
  weeklyTotals,
} from '../src/lib/stats.js';
import {
  checkQuota,
  diffItems,
  fromSyncItems,
  mergeForInit,
  QUOTA_BYTES,
  toSyncItems,
} from '../src/lib/syncCodec.js';
import { buildBackup, parseBackup } from '../src/lib/backup.js';
import { mergeSettings, normalizeChannel } from '../src/lib/settings.js';
import { formatKst } from '../src/lib/time.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const settings = mergeSettings({});
const T0 = Date.parse('2026-09-23T20:00:00+09:00');

// ---- 변경 판정 ----
const openState = (over = {}) => ({ ...INITIAL_STATE, status: 'OPEN', openDate: formatKst(T0), title: '저챗', category: '저스트채팅', ...over });
const obs = (over = {}) => ({ ok: true, status: 'OPEN', openDate: formatKst(T0), title: '저챗', category: '저스트채팅', viewers: 1, ...over });

test('카테고리 변경: 채널 옵션 켜짐일 때만', () => {
  const on = normalizeChannel(A, { notifyCategoryChange: true });
  const off = normalizeChannel(A, {});
  const ctx = (channel) => ({ now: T0 + 3_600_000, settings, channel });
  assert.equal(decideChange(openState(), obs({ category: '롤' }), ctx(off)), null);
  const c = decideChange(openState(), obs({ category: '롤' }), ctx(on));
  assert.equal(c.notify, true);
  assert.equal(c.categoryFrom, '저스트채팅');
  assert.equal(c.categoryTo, '롤');
  // 카테고리 정보가 비어 있다가 생긴 경우는 변경으로 보지 않음
  assert.equal(decideChange(openState({ category: '' }), obs({ category: '롤' }), ctx(on)), null);
});

test('키워드 새로 일치: 시작 때 키워드로 생략된 방송이 나중에 일치하면 알림', () => {
  const ch = normalizeChannel(A, { keywords: ['롤'] });
  const ctx = { now: T0, settings, channel: ch };
  const c = decideChange(openState(), obs({ title: '롤 랭크' }), ctx);
  assert.equal(c.keywordMatched, true);
  assert.equal(c.reason, 'keyword-matched');
  // 이미 일치하던 상태에서 계속 일치 → 알림 없음
  assert.equal(decideChange(openState({ title: '롤 랭크' }), obs({ title: '롤 칼바람' }), ctx), null);
});

test('변경 알림 간격·오늘 끄기·알림 off', () => {
  const ch = normalizeChannel(A, { notifyCategoryChange: true });
  const base = { settings, channel: ch };
  assert.equal(decideChange(openState({ lastChangeNotifiedAt: T0 }), obs({ category: '롤' }), { ...base, now: T0 + 60_000 }).reason, 'cooldown');
  assert.equal(decideChange(openState(), obs({ category: '롤' }), { ...base, now: T0, mutedUntil: T0 + 1 }).reason, 'muted-today');
  const quiet = decideChange(openState(), obs({ category: '롤' }), { settings, channel: normalizeChannel(A, { notifyCategoryChange: true, notify: false }), now: T0 });
  assert.equal(quiet.reason, 'channel-off');
});

test('evaluate: 같은 방송 중 변경 이벤트와 lastChangeNotifiedAt 기록', () => {
  const ch = normalizeChannel(A, { notifyCategoryChange: true });
  const r = evaluate(openState(), obs({ category: '롤' }), { now: T0 + 1000, settings, channel: ch });
  assert.equal(r.events[0].type, 'live_changed');
  assert.equal(r.state.lastChangeNotifiedAt, T0 + 1000);
  assert.equal(r.state.category, '롤');
});

test('evaluate: 오늘 끄기면 새 방송 알림 생략', () => {
  const closed = { ...INITIAL_STATE, status: 'CLOSE' };
  const r = evaluate(closed, obs(), { now: T0, settings, channel: normalizeChannel(A, {}), mutedUntil: T0 + 1000 });
  assert.equal(r.events[0].reason, 'muted-today');
});

test('shouldOpenOnLive: 허용 사유만', () => {
  const ch = normalizeChannel(A, {});
  assert.equal(ch.openOnLive, true);
  for (const r of ['went-live', 'channel-off', 'active-tab-reload']) assert.equal(shouldOpenOnLive(ch, r), true, r);
  for (const r of ['startup', 'restart-grace', 'keyword-filter', 'quiet-hours', 'muted-today', 'already-alerted', 'startup-disabled']) {
    assert.equal(shouldOpenOnLive(ch, r), false, r);
  }
  assert.equal(shouldOpenOnLive(normalizeChannel(A, { openOnLive: false }), 'went-live'), false);
});

// ---- 방송 기록 ----
const channel = { id: A, name: '채널A' };
const openObs = (openMs, viewers, category = '롤') => ({ ok: true, status: 'OPEN', openDate: formatKst(openMs), title: 't', category, viewers });

test('기록: OPEN 관측 누적, CLOSE로 종료, 같은 방송은 레코드 1개', () => {
  let h = applyObservation([], channel, openObs(T0, 10), T0 + 1000);
  h = applyObservation(h, channel, openObs(T0, 30, '발로'), T0 + 31_000);
  assert.equal(h.length, 1);
  assert.equal(h[0].peakViewers, 30);
  assert.equal(h[0].viewerSum, 40);
  assert.deepEqual(h[0].categories, ['롤', '발로']);
  h = applyObservation(h, channel, { ok: true, status: 'CLOSE', openDate: formatKst(T0), closeDate: formatKst(T0 + 7_200_000) }, T0 + 7_300_000);
  assert.equal(h[0].closeDate, formatKst(T0 + 7_200_000));
  // 종료 후 같은 CLOSE 반복 → 변화 없음(같은 배열)
  assert.equal(applyObservation(h, channel, { ok: true, status: 'CLOSE', openDate: formatKst(T0), closeDate: formatKst(T0 + 7_200_000) }, T0), h);
});

test('기록: 크롬이 꺼져 있던 동안의 방송은 CLOSE 응답으로 보충(observed=false)', () => {
  const h = applyObservation([], channel, { ok: true, status: 'CLOSE', openDate: formatKst(T0), closeDate: formatKst(T0 + 3_600_000), title: 'x', category: '롤' }, T0 + 9e6);
  assert.equal(h.length, 1);
  assert.equal(h[0].observed, false);
  assert.equal(h[0].viewerSamples, 0);
});

test('기록: 실패·openDate 없음은 무시, 최대 개수 유지', () => {
  assert.deepEqual(applyObservation([], channel, { ok: false }, T0), []);
  assert.deepEqual(applyObservation([], channel, { ok: true, status: 'CLOSE', openDate: null }, T0), []);
  let h = [];
  for (let i = 0; i < HISTORY_MAX + 5; i++) h.push({ channelId: A, openDate: formatKst(T0 + i * 60_000) });
  h = applyObservation(h.slice(0, HISTORY_MAX), channel, openObs(T0 + 1e10, 1), T0);
  assert.equal(h.length, HISTORY_MAX);
});

test('mergeHistory: 중복 제거', () => {
  const cur = [{ channelId: A, openDate: '2026-01-01 10:00:00', peakViewers: 5 }];
  const merged = mergeHistory(cur, [{ channelId: A, openDate: '2026-01-01 10:00:00', peakViewers: 99 }, { channelId: B, openDate: '2026-01-02 10:00:00' }, null]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].peakViewers, 5);
});

// ---- 통계 ----
const rec = (localIso, hours, extra = {}) => {
  const start = new Date(localIso).getTime();
  return { channelId: A, openDate: formatKst(start), closeDate: formatKst(start + hours * 3_600_000), categories: ['롤'], peakViewers: 0, viewerSum: 0, viewerSamples: 0, ...extra };
};

test('typicalStart: 자정을 넘는 시작 시각의 원형 평균', () => {
  const t = typicalStart([new Date(2026, 8, 1, 23, 50).getTime(), new Date(2026, 8, 2, 0, 10).getTime()]);
  assert.equal(t.minute, 0);
  assert.ok(t.concentration > 0.99);
});

test('typicalStartLabel: 3회 이상·일정할 때만', () => {
  const h = [rec('2026-09-01T20:00', 2), rec('2026-09-02T20:10', 2)];
  assert.equal(typicalStartLabel(h, A), null);
  h.push(rec('2026-09-03T19:50', 2));
  assert.equal(typicalStartLabel(h, A), '20:00');
  const scattered = [rec('2026-09-01T02:00', 1), rec('2026-09-02T10:00', 1), rec('2026-09-03T18:00', 1)];
  assert.equal(typicalStartLabel(scattered, A), null);
});

test('startHeatmap: 월요일=0 기준 요일·시', () => {
  const g = startHeatmap([rec('2026-09-21T20:30', 1), rec('2026-09-27T09:00', 1)]); // 2026-09-21 월, 09-27 일
  assert.equal(g[0][20], 1);
  assert.equal(g[6][9], 1);
});

test('weeklyTotals: 12주 버킷, 시작 주 기준 시간 합계', () => {
  const now = new Date('2026-09-23T12:00').getTime();
  const w = weeklyTotals([rec('2026-09-21T20:00', 2), rec('2026-09-22T20:00', 3), rec('2026-09-14T20:00', 1)], now, 12);
  assert.equal(w.length, 12);
  assert.equal(w[11].weekStart, weekStart(now));
  assert.equal(w[11].hours, 5);
  assert.equal(w[11].count, 2);
  assert.equal(w[10].hours, 1);
});

test('categoryHours: 균등 분배와 기타 묶기', () => {
  const c = categoryHours([rec('2026-09-21T20:00', 2, { categories: ['롤', '발로'] }), rec('2026-09-22T20:00', 1)]);
  assert.deepEqual(c.map((x) => [x.name, x.hours]), [['롤', 2], ['발로', 1]]);
  const many = Array.from({ length: 10 }, (_, i) => rec(`2026-09-${String(i + 1).padStart(2, '0')}T20:00`, 10 - i, { categories: [`c${i}`] }));
  const top = categoryHours(many, 8);
  assert.equal(top.length, 9);
  assert.equal(top[8].name, '기타');
  assert.equal(top[8].hours, 3);
});

test('summarizeRecords', () => {
  const s = summarizeRecords([rec('2026-09-21T20:00', 2, { peakViewers: 50, viewerSum: 60, viewerSamples: 2 }), rec('2026-09-22T20:00', 4)]);
  assert.equal(s.count, 2);
  assert.equal(s.avgMs, 3 * 3_600_000);
  assert.equal(s.peakViewers, 50);
  assert.equal(s.avgViewers, 30);
});

// ---- 동기화 코덱 ----
test('toSyncItems/fromSyncItems 왕복, 기기별 설정 제외', () => {
  const channels = { [B]: normalizeChannel(B, { name: 'B', addedAt: 2 }), [A]: normalizeChannel(A, { name: 'A', addedAt: 1 }) };
  const s = mergeSettings({ debugMode: true, syncEnabled: false, restartGraceMin: 7 });
  const items = toSyncItems(channels, s);
  assert.ok(items[`ch:${A}`]);
  assert.equal(items.settings.debugMode, undefined);
  assert.equal(items.settings.syncEnabled, undefined);
  const back = fromSyncItems(items);
  assert.deepEqual(Object.keys(back.channels), [A, B], 'addedAt 순서');
  assert.equal(back.channels[A].name, 'A');
  assert.equal(back.settings.restartGraceMin, 7);
});

test('diffItems: 바뀐 항목만 쓰고, 없어진 채널만 지움', () => {
  const remote = { settings: { a: 1 }, [`ch:${A}`]: { name: 'A' }, [`ch:${B}`]: { name: 'B' }, other: 1 };
  const d = diffItems({ settings: { a: 1 }, [`ch:${A}`]: { name: 'A2' } }, remote);
  assert.deepEqual(Object.keys(d.set), [`ch:${A}`]);
  assert.deepEqual(d.remove, [`ch:${B}`]);
  assert.equal(diffItems({ settings: { a: 1 } }, { settings: { a: 1 } }).changed, false);
});

test('checkQuota: 채널 수백 개도 항목 분할로 통과, 총량·항목 크기 초과 감지', () => {
  const mk = (n, kw = []) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const id = i.toString(16).padStart(32, '0');
        return [id, normalizeChannel(id, { name: `채널${i}`, imageUrl: `https://nng-phinf.pstatic.net/${'x'.repeat(120)}.png`, keywords: kw })];
      }),
    );
  const ok = checkQuota(toSyncItems(mk(150), settings));
  assert.equal(ok.ok, true, `150개 = ${ok.totalBytes}B`);
  const tooMany = checkQuota(toSyncItems(mk(400), settings));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.reason, 'total');
  assert.ok(tooMany.totalBytes > QUOTA_BYTES * 0.9);
  const huge = checkQuota(toSyncItems(mk(1, ['키워드'.repeat(2000)]), settings));
  assert.equal(huge.reason, 'item');
});

test('mergeForInit: 채널 합집합(원격 우선), 설정은 원격 + 기기별 값 유지', () => {
  const local = {
    channels: { [A]: normalizeChannel(A, { name: 'local-A', addedAt: 1 }) },
    settings: mergeSettings({ debugMode: true, restartGraceMin: 1 }),
  };
  const remote = {
    channels: { [A]: normalizeChannel(A, { name: 'remote-A', addedAt: 1 }), [B]: normalizeChannel(B, { addedAt: 2 }) },
    settings: mergeSettings({ restartGraceMin: 9, debugMode: false }),
  };
  const m = mergeForInit(local, remote);
  assert.deepEqual(Object.keys(m.channels), [A, B]);
  assert.equal(m.channels[A].name, 'remote-A');
  assert.equal(m.settings.restartGraceMin, 9);
  assert.equal(m.settings.debugMode, true);
  assert.equal(mergeForInit(local, { channels: {}, settings: null }).settings.restartGraceMin, 1);
});

// ---- 백업 ----
test('백업 왕복과 검증', () => {
  const channels = { [A]: normalizeChannel(A, { name: 'A', keywords: ['롤'] }) };
  const data = buildBackup({ channels, settings: mergeSettings({ debugMode: true }), history: [{ channelId: A, openDate: 'x' }], now: 0, appVersion: '1.0.0' });
  assert.equal(data.settings.debugMode, undefined);
  const back = parseBackup(JSON.stringify(data));
  assert.equal(back.channels[A].name, 'A');
  assert.deepEqual(back.channels[A].keywords, ['롤']);
  assert.equal(back.history.length, 1);
  assert.throws(() => parseBackup('nope'), /JSON/);
  assert.throws(() => parseBackup('{"format":"other"}'), /백업 파일이 아닙니다/);
  assert.throws(() => parseBackup(JSON.stringify({ ...data, version: 99 })), /새로운 버전/);
  const bad = parseBackup(JSON.stringify({ ...data, channels: [{ id: 'bad' }, { id: A.toUpperCase(), name: 'U' }] }));
  assert.deepEqual(Object.keys(bad.channels), [A]);
});
