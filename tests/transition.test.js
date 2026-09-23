import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, INITIAL_STATE, matchesKeywords } from '../src/lib/transition.js';
import { DEFAULT_SETTINGS, mergeSettings, normalizeChannel } from '../src/lib/settings.js';
import { formatKst, parseKst } from '../src/lib/time.js';

const T0 = Date.parse('2026-09-23T12:00:00+09:00');
const MIN = 60_000;
const settings = mergeSettings({});
const channel = normalizeChannel('a'.repeat(32), { name: '테스트' });

const open = (openMs, extra = {}) => ({
  ok: true, status: 'OPEN', openDate: formatKst(openMs), closeDate: null, title: '제목', category: '게임', viewers: 10, ...extra,
});
const close = (openMs, closeMs) => ({
  ok: true, status: 'CLOSE', openDate: openMs ? formatKst(openMs) : null, closeDate: closeMs ? formatKst(closeMs) : null, title: '', category: '', viewers: 0,
});
const fail = { ok: false, error: 'HTTP 500' };

function run(prev, obs, now, over = {}) {
  return evaluate(prev, obs, { now, settings, channel, firstObsThisSession: false, ...over });
}

/** 여러 관측을 순서대로 적용하고 이벤트를 모은다. */
function sequence(steps, init = INITIAL_STATE, over = {}) {
  let state = init;
  const events = [];
  for (const [obs, now] of steps) {
    const r = run(state, obs, now, over);
    state = r.state;
    events.push(...r.events.map((e) => ({ ...e, now })));
  }
  return { state, events };
}

const closedState = (closeMs = T0 - 60 * MIN) => run(INITIAL_STATE, close(closeMs - 120 * MIN, closeMs), T0 - 30 * MIN).state;

test('T1: CLOSE → OPEN 새 openDate면 알림 1회', () => {
  const { state, events } = run(closedState(), open(T0), T0 + 20_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'went_live');
  assert.equal(events[0].notify, true);
  assert.equal(state.status, 'OPEN');
  assert.equal(state.alertedOpenDate, formatKst(T0));
});

test('T2: OPEN 유지로 여러 주기 경과 시 추가 알림 없음', () => {
  const { events } = sequence([
    [open(T0), T0 + 10_000],
    [open(T0), T0 + 40_000],
    [open(T0, { viewers: 999 }), T0 + 70_000],
    [open(T0), T0 + 100_000],
  ], closedState());
  assert.equal(events.filter((e) => e.type === 'went_live').length, 1);
});

test('T3: OPEN 중 조회 실패 3회 후 복구 → 알림 없음, 실패 횟수 증가 후 초기화', () => {
  let { state } = run(closedState(), open(T0), T0 + 10_000);
  const events = [];
  for (let i = 1; i <= 3; i++) {
    const r = run(state, fail, T0 + 10_000 + i * 30_000);
    state = r.state;
    events.push(...r.events);
    assert.equal(state.status, 'OPEN', '실패는 상태를 바꾸지 않는다');
    assert.equal(state.failCount, i);
  }
  const r = run(state, open(T0), T0 + 130_000);
  assert.equal(r.state.failCount, 0);
  assert.deepEqual([...events, ...r.events], []);
});

test('조회 실패는 CLOSE 상태도 유지', () => {
  const s = closedState();
  const r = run(s, fail, T0);
  assert.equal(r.state.status, 'CLOSE');
  assert.equal(r.events.length, 0);
});

test('T4: OPEN → CLOSE → 유예 시간 내 새 openDate로 OPEN → 알림 억제, went_live 이벤트는 발생', () => {
  const { events } = sequence([
    [open(T0), T0 + 10_000],
    [close(T0, T0 + 60 * MIN), T0 + 60 * MIN + 10_000],
    [open(T0 + 62 * MIN), T0 + 62 * MIN + 10_000],
  ], closedState());
  const lives = events.filter((e) => e.type === 'went_live');
  assert.equal(lives.length, 2);
  assert.equal(lives[1].notify, false);
  assert.equal(lives[1].reason, 'restart-grace');
  assert.equal(events.filter((e) => e.type === 'went_offline').length, 1);
});

test('유예 시간 이후 재시작은 알림', () => {
  const { events } = sequence([
    [open(T0), T0 + 10_000],
    [close(T0, T0 + 60 * MIN), T0 + 60 * MIN + 10_000],
    [open(T0 + 70 * MIN), T0 + 70 * MIN + 10_000],
  ], closedState());
  const lives = events.filter((e) => e.type === 'went_live');
  assert.equal(lives[1].notify, true);
});

test('CLOSE를 관측하지 못하고 openDate만 바뀐 경우(한 주기 내 재시작) 알림 억제', () => {
  const { events } = sequence([
    [open(T0), T0 + 10_000],
    [open(T0 + 20_000), T0 + 40_000],
  ], closedState());
  const lives = events.filter((e) => e.type === 'went_live');
  assert.equal(lives.length, 2);
  assert.equal(lives[1].reason, 'restart-grace');
});

test('API가 잠깐 CLOSE를 보였다가 같은 openDate로 OPEN → 중복 알림 없음', () => {
  const { events } = sequence([
    [open(T0), T0 + 10_000],
    [close(T0, T0 + 20_000), T0 + 40_000],
    [open(T0), T0 + 70_000],
  ], closedState());
  const lives = events.filter((e) => e.type === 'went_live');
  assert.equal(lives.filter((e) => e.notify).length, 1);
  assert.equal(lives[1].reason, 'already-alerted');
});

test('T10: 방송 중 브라우저 재시작 → 이미 알린 방송 재알림 없음', () => {
  const { state } = run(closedState(), open(T0), T0 + 10_000);
  // 재시작 후 첫 관측(세션 내 첫 관측)
  const r = run(state, open(T0), T0 + 30 * MIN, { firstObsThisSession: true });
  assert.equal(r.events.length, 0);
});

test('T11: 브라우저 종료 중 방송 시작 후 실행 → 알림 1회(기본 설정)', () => {
  const r = run(closedState(T0 - 10 * 60 * MIN), open(T0), T0 + 30 * MIN, { firstObsThisSession: true });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].notify, true);
  assert.equal(r.events[0].reason, 'startup');
});

test('시작 시 기존 방송 알림 끄면 억제', () => {
  const s = mergeSettings({ notifyExistingOnStartup: false });
  const r = evaluate(INITIAL_STATE, open(T0), { now: T0 + 60_000, settings: s, channel, firstObsThisSession: true });
  assert.equal(r.events[0].notify, false);
  assert.equal(r.events[0].reason, 'startup-disabled');
});

test('UNKNOWN → CLOSE는 이벤트 없음, UNKNOWN → OPEN은 went_live', () => {
  assert.deepEqual(run(INITIAL_STATE, close(null, null), T0).events, []);
  const r = run(INITIAL_STATE, open(T0), T0 + 1000);
  assert.equal(r.events[0].fromStatus, 'UNKNOWN');
});

test('채널 알림 off / 키워드 불일치 / 알림 금지 시간대 → 알림 억제(이벤트는 발생)', () => {
  const off = normalizeChannel(channel.id, { notify: false });
  assert.equal(evaluate(closedState(), open(T0), { now: T0, settings, channel: off }).events[0].reason, 'channel-off');

  const kw = normalizeChannel(channel.id, { keywords: ['롤'] });
  assert.equal(evaluate(closedState(), open(T0), { now: T0, settings, channel: kw }).events[0].reason, 'keyword-filter');
  assert.equal(evaluate(closedState(), open(T0, { title: '롤 랭겜' }), { now: T0, settings, channel: kw }).events[0].notify, true);

  const d = new Date(T0);
  const hm = (dt) => `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const quiet = mergeSettings({
    quietHours: { enabled: true, start: hm(new Date(T0 - 60 * MIN)), end: hm(new Date(T0 + 60 * MIN)) },
  });
  assert.equal(evaluate(closedState(), open(T0), { now: d.getTime(), settings: quiet, channel }).events[0].reason, 'quiet-hours');
});

test('OPEN → CLOSE 시 서버 종료 시각을 lastCloseAt으로 기록', () => {
  const { state } = sequence([
    [open(T0), T0 + 10_000],
    [close(T0, T0 + 60 * MIN), T0 + 60 * MIN + 25_000],
  ], closedState());
  assert.equal(state.status, 'CLOSE');
  assert.equal(state.lastCloseAt, T0 + 60 * MIN);
});

test('matchesKeywords', () => {
  assert.equal(matchesKeywords([], 'x', 'y'), true);
  assert.equal(matchesKeywords(['LoL'], '오늘은 lol', ''), true);
  assert.equal(matchesKeywords(['발로'], '', '발로란트'), true);
  assert.equal(matchesKeywords(['a'], 'b', 'c'), false);
});

test('기본 설정 값', () => {
  assert.equal(DEFAULT_SETTINGS.pollIntervalSec, 30);
  assert.equal(mergeSettings({ pollIntervalSec: 5 }).pollIntervalSec, 30);
  assert.equal(parseKst(formatKst(T0)), T0);
});
