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
  cleared: [],
  focused: [],
  created: [],
  muted: new Set(),
  alarms: [],
  badge: '',
  nextTabId: 1000,
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
    async update(tabId, props) {
      const tab = fake.tabs.find((t) => t.id === tabId);
      if ('muted' in props) props.muted ? fake.muted.add(tabId) : fake.muted.delete(tabId);
      if (props.active) {
        for (const t of fake.tabs) if (t.windowId === tab?.windowId) t.active = false;
        if (tab) tab.active = true;
        fake.focused.push(tabId);
      }
      return tab;
    },
    async create({ url, active }) {
      const tab = { id: fake.nextTabId++, url, active: !!active, windowId: 1 };
      fake.tabs.push(tab);
      fake.created.push({ ...tab });
      return tab;
    },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    async getLastFocused() { return { id: 1, focused: true }; },
    async update() {},
  },
  alarms: { async create(name, opts) { fake.alarms.push({ name, ...opts }); } },
  notifications: {
    async create(id, opts) { fake.notifications.push({ id, ...opts }); },
    async clear(id) { fake.cleared.push(id); },
  },
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
  fake.cleared = [];
  fake.focused = [];
  fake.created = [];
  fake.muted = new Set();
  fake.alarms = [];
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

test('T3: 연속 실패 시 배지 경고 + 감지 중단 알림 1회, 복구 시 해제, 방송 알림 없음', async () => {
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  fake.notifications = [];
  const m = await storage.getMockStatus();
  await storage.setMockStatus(A, { ...m[A], fail: true });
  await runPoll();
  await runPoll();
  await runPoll();
  await runPoll();
  assert.equal(fake.badge, '1!');
  const states = await storage.getAllChannelState();
  assert.equal(states[A].status, 'OPEN');
  assert.deepEqual(fake.notifications.map((n) => n.id), ['stall'], '경고는 한 번만');
  await storage.setMockStatus(A, { ...m[A], fail: false });
  await runPoll();
  assert.equal(fake.badge, '1');
  assert.ok(fake.cleared.includes('stall'));
  assert.equal(fake.notifications.length, 1);
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

// ---- v1.0 추가 기능 ----

test('방송 시작: 새로고침한 오프라인 탭으로 포커스, 포커스할 탭은 음소거 안 함', async () => {
  await openTab(20, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  const r = await runPoll();
  assert.deepEqual(fake.reloaded, [20]);
  assert.deepEqual(fake.focused, [20]);
  assert.equal(fake.muted.has(20), false);
  assert.equal(fake.created.length, 0);
  assert.equal(r.opened, 1);
});

test('방송 시작: 열린 탭이 없으면 새 탭으로 열고 포커스', async () => {
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].url, liveUrl(A));
  assert.equal(fake.created[0].active, true);
  // 새로 연 탭은 방송 시작 후 로드 → 다음 주기에 새로고침되지 않음
  await onTabUpdated(fake.created[0].id, { status: 'complete' }, { url: liveUrl(A) });
  await runPoll();
  assert.deepEqual(fake.reloaded, []);
  assert.equal(fake.created.length, 1);
});

test('방송 시작: 이미 시청 중인 탭(방송 시작 후 로드)이 있으면 새 탭·포커스 없음', async () => {
  await setMock(A, 'OPEN', Date.now() - 120_000);
  await openTab(21, liveUrl(A), Date.now()); // 방송 시작 2분 뒤 로드
  await runPoll();
  assert.deepEqual(fake.reloaded, []);
  assert.equal(fake.created.length, 0);
  assert.deepEqual(fake.focused, []);
});

test('포커스 전환 끔: 새로고침 탭은 음소거, 새 탭은 백그라운드+음소거', async () => {
  await storage.saveSettings({ focusOnLive: false });
  await openTab(22, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  await setMock(B, 'OPEN', Date.now());
  await runPoll();
  assert.deepEqual(fake.focused, []);
  assert.ok(fake.muted.has(22));
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].active, false);
  assert.ok(fake.muted.has(fake.created[0].id));
});

test('음소거 해제: 사용자가 탭을 활성화하면 확장이 음소거한 탭만 해제', async () => {
  const { onTabActivated } = await import('../src/lib/tabAudio.js');
  await storage.saveSettings({ focusOnLive: false });
  await openTab(23, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  assert.ok(fake.muted.has(23));
  fake.muted.add(99); // 사용자가 직접 음소거한 다른 탭
  await onTabActivated({ tabId: 23 });
  await onTabActivated({ tabId: 99 });
  assert.equal(fake.muted.has(23), false);
  assert.ok(fake.muted.has(99));
});

test('채널 탭 열기 끔: 새로고침만 하고 포커스·새 탭 없음', async () => {
  await storage.upsertChannel(A, { openOnLive: false });
  await openTab(24, liveUrl(A), Date.now() - 60_000);
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  assert.deepEqual(fake.reloaded, [24]);
  assert.deepEqual(fake.focused, []);
  assert.equal(fake.created.length, 0);
});

test('재시작 유예·브라우저 시작 직후에는 탭 포커스·새 탭 없음', async () => {
  chrome.storage.session._reset(); // 브라우저 시작 직후
  await setMock(A, 'OPEN', Date.now() - 10 * 60_000);
  await runPoll();
  assert.equal(fake.created.length, 0);
});

test('알림 버튼: 30분 뒤 다시 알림 → 알람 등록, 방송이 이어지면 재알림', async () => {
  const notifier = await import('../src/lib/notifier.js');
  const { handleSnooze } = await import('../src/lib/poller.js');
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  const id = fake.notifications[0].id;
  assert.equal(fake.notifications[0].buttons.length, 2);
  await notifier.onNotificationButtonClicked(id, 0, { setChannelMute: storage.setChannelMute });
  assert.equal(fake.alarms.length, 1);
  assert.equal(fake.alarms[0].delayInMinutes, 30);
  const parsed = notifier.parseSnoozeAlarm(fake.alarms[0].name);
  assert.equal(await handleSnooze(parsed), true);
  assert.match(fake.notifications.at(-1).title, /방송 중/);
  // 방송이 끝났으면 재알림 없음
  await setMock(A, 'CLOSE', null);
  await runPoll();
  assert.equal(await handleSnooze(parsed), false);
});

test('알림 버튼: 오늘 이 채널 알림 끄기 → 오늘 새 방송 알림 생략, 새로고침은 동작', async () => {
  const notifier = await import('../src/lib/notifier.js');
  await setMock(A, 'OPEN', Date.now() - 60 * 60_000);
  await runPoll();
  await notifier.onNotificationButtonClicked(fake.notifications[0].id, 1, { setChannelMute: storage.setChannelMute });
  const mute = await storage.getChannelMute();
  assert.ok(mute[A] > Date.now());
  // 유예 시간 밖에서 새 방송
  await storage.setMockStatus(A, { status: 'CLOSE', openDate: formatKst(Date.now() - 60 * 60_000), closeDate: formatKst(Date.now() - 30 * 60_000) });
  await runPoll();
  await openTab(25, liveUrl(A), Date.now() - 60_000);
  fake.notifications = [];
  await setMock(A, 'OPEN', Date.now());
  await runPoll();
  assert.equal(fake.notifications.length, 0);
  assert.deepEqual(fake.reloaded, [25]);
  assert.deepEqual(fake.focused, [], '오늘 끈 채널은 포커스도 하지 않음');
});

test('방송 중 카테고리 변경 알림(채널 옵션), 간격 제한', async () => {
  await storage.upsertChannel(A, { notifyCategoryChange: true });
  await setMock(A, 'OPEN', Date.now(), { category: '저챗' });
  await runPoll();
  fake.notifications = [];
  const m = (await storage.getMockStatus())[A];
  await storage.setMockStatus(A, { ...m, category: '롤' });
  await runPoll();
  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].id, /^change\|/);
  assert.match(fake.notifications[0].contextMessage, /저챗 → 롤/);
  await storage.setMockStatus(A, { ...m, category: '발로란트' });
  await runPoll();
  assert.equal(fake.notifications.length, 1, '5분 안의 두 번째 변경은 생략');
});

test('방송 기록: 시작·시청자·카테고리·종료 기록', async () => {
  const t0 = Date.now() - 60 * 60_000;
  await setMock(A, 'OPEN', t0, { category: '저챗', viewers: 100 });
  await runPoll();
  const m = (await storage.getMockStatus())[A];
  await storage.setMockStatus(A, { ...m, category: '롤', viewers: 300 });
  await runPoll();
  await storage.setMockStatus(A, { ...m, status: 'CLOSE', closeDate: formatKst(Date.now()) });
  await runPoll();
  const h = (await storage.getHistory()).filter((r) => r.channelId === A);
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].categories, ['저챗', '롤']);
  assert.equal(h[0].peakViewers, 300);
  assert.equal(h[0].viewerSamples, 2);
  assert.ok(h[0].closeDate);
});
