import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTabsToReload } from '../src/lib/reloadPolicy.js';
import { reloadLogKey } from '../src/lib/reloadLogKey.js';
import { mergeSettings, normalizeChannel } from '../src/lib/settings.js';
import { formatKst } from '../src/lib/time.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const T0 = Date.parse('2026-09-23T20:00:00+09:00');
const openDate = formatKst(T0);
const settings = mergeSettings({});
const url = (id) => `https://chzzk.naver.com/live/${id}`;

function base(over = {}) {
  return {
    tabs: [{ id: 1, url: url(A), active: false }],
    channels: { [A]: normalizeChannel(A, {}), [B]: normalizeChannel(B, {}) },
    states: { [A]: { status: 'OPEN', openDate }, [B]: { status: 'CLOSE', openDate: null } },
    tabState: { 1: { channelId: A, loadedAt: T0 - 5 * 60_000 } },
    reloadLog: {},
    settings,
    ...over,
  };
}

test('T5: CLOSE 중 연 라이브 페이지 → OPEN 전환 시 새로고침 대상', () => {
  assert.deepEqual(selectTabsToReload(base()).map((c) => c.tabId), [1]);
});

test('T6: 새로고침 기록이 있으면 여전히 오프라인으로 보여도 재시도 없음', () => {
  const p = base({ reloadLog: { [reloadLogKey(1, openDate)]: T0 + 1000 } });
  assert.deepEqual(selectTabsToReload(p), []);
});

test('T6-2: 새로고침 후 로드 시각이 갱신되면 기록이 없어도 대상 아님', () => {
  const p = base({ tabState: { 1: { channelId: A, loadedAt: T0 + 40_000 } } });
  assert.deepEqual(selectTabsToReload(p), []);
});

test('T7: 방송 시작 후 사용자가 직접 연 탭은 대상 아님', () => {
  const p = base({ tabState: { 1: { channelId: A, loadedAt: T0 + 60_000 } } });
  assert.deepEqual(selectTabsToReload(p), []);
});

test('시계 오차 허용: openDate 직후(허용 범위 내) 로드된 탭은 대상', () => {
  const p = base({ tabState: { 1: { channelId: A, loadedAt: T0 + 5_000 } } });
  assert.equal(selectTabsToReload(p).length, 1);
});

test('T8: 같은 채널 오프라인 탭 2개 → 각각 대상, 하나만 기록 있으면 나머지만', () => {
  const tabs = [{ id: 1, url: url(A) }, { id: 2, url: `${url(A)}?foo=1` }];
  const tabState = { 1: { channelId: A, loadedAt: T0 - 1000 * 60 }, 2: { channelId: A, loadedAt: T0 - 1000 * 90 } };
  assert.deepEqual(selectTabsToReload(base({ tabs, tabState })).map((c) => c.tabId), [1, 2]);
  const reloadLog = { [reloadLogKey(1, openDate)]: T0 };
  assert.deepEqual(selectTabsToReload(base({ tabs, tabState, reloadLog })).map((c) => c.tabId), [2]);
});

test('새 방송(openDate 변경)이면 이전 방송 기록과 무관하게 다시 대상(T4 새로고침)', () => {
  const newOpen = formatKst(T0 + 90 * 60_000);
  const p = base({
    states: { [A]: { status: 'OPEN', openDate: newOpen } },
    tabState: { 1: { channelId: A, loadedAt: T0 + 30 * 60_000 } },
    reloadLog: { [reloadLogKey(1, openDate)]: T0 },
  });
  assert.equal(selectTabsToReload(p).length, 1);
});

test('자동 새로고침 off, 미등록 채널, 오프라인 채널, 라이브 아닌 URL, 추적 기록 없음 → 대상 아님', () => {
  assert.deepEqual(selectTabsToReload(base({ channels: { [A]: normalizeChannel(A, { autoReload: false }) } })), []);
  assert.deepEqual(selectTabsToReload(base({ channels: {} })), []);
  assert.deepEqual(selectTabsToReload(base({ tabs: [{ id: 1, url: url(B) }], tabState: { 1: { channelId: B, loadedAt: 0 } } })), []);
  assert.deepEqual(selectTabsToReload(base({ tabs: [{ id: 1, url: `https://chzzk.naver.com/${A}` }] })), []);
  assert.deepEqual(selectTabsToReload(base({ tabState: {} })), []);
  // 추적 기록이 다른 채널(SPA 이동 후 URL과 불일치)
  assert.deepEqual(selectTabsToReload(base({ tabState: { 1: { channelId: B, loadedAt: 0 } } })), []);
});

test('백그라운드 탭 포함(기본 범위 all)', () => {
  const p = base({ tabs: [{ id: 1, url: url(A), active: false }] });
  assert.equal(selectTabsToReload(p).length, 1);
});
