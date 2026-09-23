// 폴링 파이프라인 통합 테스트: chrome API를 메모리 구현으로 대체하고 모의 상태 제공자로 전이를 재현한다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function createArea() {
  let data = {};
  return {
    async get(key) {
      if (key == null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      data = { ...data, ...structuredClone(obj) };
    },
    async remove(key) {
      for (const k of [].concat(key)) delete data[k];
    },
    _reset() {
      data = {};
    },
  };
}

const fake = {
  tabs: [],
  reloaded: [],
  notifications: [],
  badge: '',
};

function matchPattern(pattern, url) {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(url);
}

globalThis.chrome = {
  storage: { local: createArea(), session: createArea(), onChanged: { addListener() {} } },
  tabs: {
    async query({ url }) {
      return fake.tabs.filter((t) => matchPattern(url, t.url)).map((t) => ({ ...t }));
    },
    async reload(tabId) {
      fake.reloaded.push(tabId);
    },
  },
  windows: { async getLastFocused() { return { id: 1, focused: true }; } },
  notifications: { async create(id, opts) { fake.notifications.push({ id, ...opts }); } },
  action: {
    async setBadgeText({ text }) { fake.badge = text; },
    async setBadgeBackgroundColor() {},
    async setBadgeTextColor() {},
    async setTitle() {},
  },
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
};

const storage = await import('../src/lib/storage.js');
const { runPoll } = await import('../src/lib/poller.js');
const { onTabUpdated } = await import('../src/lib/tabTracker.js');
const { formatKst } = await import('../src/lib/time.js');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const liveUrl = (id) => `https://chzzk.naver.com/live/${id}`;

async function setMock(id, status, openMs, extra = {}) {
  await storage.setMockStatus(id, { status, openDate: openMs ? formatKst(openMs) : null, title: '모의', ...extra });
}

async function openTab(id, url, loadedAt) {
  fake.tabs.push({ id, url, active: false, windowId: 1 });
  const realNow = Date.now;
  Date.now = () => loadedAt;
  try {
    await onTabUpdated(id, { status: 'complete' }, { url });
  } finally {
    Date.now = realNow;
  }
}

beforeEach(async () => {
  chrome.storage.local._reset();
  chrome.storage.session._reset();
  fake.tabs = [];
  fake.reloaded = [];
  fake.notifications = [];
  // 디버그 모드 = 모의 제공자, 새로고침 지연 0
  await storage.saveSettings({ debugMode: true, reloadDelaySec: 0 });
  await storage.upsertChannel(A, { name: '채널A' });
  await storage.upsertChannel(B, { name: '채널B' });
  await setMock(A, 'CLOSE', null);
  await setMock(B, 'CLOSE', null);
  await runPoll(); // UNKNOWN → CLOSE
});

test('T1/T5: CLOSE → OPEN 시 알림 1회, 배지 1, 오프라인 탭 1회 새로고침', async () => {
  await openTab(10, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  const r = await runPoll();
  assert.equal(r.wentLive, 1);
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].title, /채널A/);
  assert.equal(fake.badge, '1');
  assert.deepEqual(fake.reloaded, [10]);
});

test('T2/T6: OPEN 유지 여러 주기 → 추가 알림·추가 새로고침 없음', async () => {
  await openTab(10, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  await runPoll();
  await runPoll();
  assert.equal(fake.notifications.length, 1);
  assert.deepEqual(fake.reloaded, [10]);
});

test('T3: 연속 실패 시 배지 경고, 복구 시 해제, 알림 없음', async () => {
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  fake.notifications = [];
  await setMock(A, 'OPEN', Date.now() - 1000, { fail: true });
  const m = await storage.getMockStatus();
  await storage.setMockStatus(A, { ...m[A], fail: true });
  await runPoll();
  await runPoll();
  await runPoll();
  assert.equal(fake.badge, '1!');
  const states = await storage.getAllChannelState();
  assert.equal(states[A].status, 'OPEN');
  await storage.setMockStatus(A, { ...m[A], fail: false });
  await runPoll();
  assert.equal(fake.badge, '1');
  assert.equal(fake.notifications.length, 0);
});

test('T4: 유예 시간 내 재시작 → 알림 억제, 오프라인 탭은 새 방송 기준 1회 새로고침', async () => {
  const t0 = Date.now() - 30 * 60_000;
  await setMock(A, 'OPEN', t0);
  await runPoll();
  await storage.setMockStatus(A, { status: 'CLOSE', openDate: formatKst(t0), closeDate: formatKst(Date.now() - 60_000) });
  await runPoll();
  await openTab(11, liveUrl(A), Date.now() - 30_000); // 끊긴 동안 열어 둔 오프라인 화면
  fake.notifications = [];
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  assert.equal(fake.notifications.length, 0);
  assert.deepEqual(fake.reloaded, [11]);
  const log = await storage.getEventLog();
  assert.equal(log.find((e) => e.type === 'went_live').reason, 'restart-grace');
});

test('T7: 방송 시작 후 직접 연 탭은 새로고침 안 함', async () => {
  await setMock(A, 'OPEN', Date.now() - 120_000);
  await runPoll();
  await openTab(12, liveUrl(A), Date.now());
  await runPoll();
  assert.deepEqual(fake.reloaded, []);
});

test('T8: 같은 채널 오프라인 탭 2개 → 각 1회', async () => {
  await openTab(13, liveUrl(A), Date.now() - 60_000);
  await openTab(14, liveUrl(A), Date.now() - 90_000);
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  await runPoll();
  assert.deepEqual(fake.reloaded.sort(), [13, 14]);
});

test('T9: SPA 내부 이동(URL 변경)을 로드 시각으로 기록', async () => {
  fake.tabs.push({ id: 15, url: liveUrl(B), active: false, windowId: 1 });
  await onTabUpdated(15, { url: liveUrl(B) }, { url: liveUrl(B) });
  const ts = await storage.getTabState();
  assert.equal(ts[15].channelId, B);
  assert.ok(Math.abs(ts[15].loadedAt - Date.now()) < 1000);
  await onTabUpdated(15, { url: 'https://chzzk.naver.com/' }, { url: 'https://chzzk.naver.com/' });
  assert.equal((await storage.getTabState())[15], undefined);
});

test('T10: 방송 중 브라우저 재시작(session 저장소 초기화) → 재알림 없음', async () => {
  await setMock(A, 'OPEN', Date.now() - 60_000);
  await runPoll();
  assert.equal(fake.notifications.length, 1);
  chrome.storage.session._reset();
  await runPoll();
  assert.equal(fake.notifications.length, 1);
});

test('T11: 브라우저 종료 중 방송 시작 후 실행 → 알림 1회', async () => {
  chrome.storage.session._reset();
  await setMock(A, 'OPEN', Date.now() - 10 * 60_000);
  await runPoll();
  await runPoll();
  assert.equal(fake.notifications.length, 1);
});

test('T12: 워커 강제 종료(메모리 초기화) 후 다음 주기 → 저장소에서 상태 복원', async () => {
  await setMock(A, 'OPEN', Date.now() - 60_000);
  await runPoll();
  // 모듈 캐시 없이 새로 import = 새 워커 인스턴스와 동일
  const fresh = await import(`../src/lib/poller.js?fresh=${Date.now()}`);
  await fresh.runPoll();
  assert.equal(fake.notifications.length, 1);
});

test('폴링 락: 진행 중이면 건너뜀', async () => {
  const [a, b] = await Promise.all([runPoll(), runPoll()]);
  assert.ok(a.skipped || b.skipped);
});

test('채널 알림 off여도 자동 새로고침은 동작', async () => {
  await storage.upsertChannel(A, { notify: false });
  await openTab(16, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  assert.equal(fake.notifications.length, 0);
  assert.deepEqual(fake.reloaded, [16]);
});
