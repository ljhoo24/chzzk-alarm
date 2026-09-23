// 구글 계정 동기화 흐름: chrome.storage.sync를 메모리 구현으로 두고 두 기기를 흉내 낸다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function createArea({ quota = Infinity } = {}) {
  let data = {};
  const bytes = () => Object.entries(data).reduce((s, [k, v]) => s + k.length + JSON.stringify(v).length, 0);
  return {
    async get(key) {
      if (key == null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      const next = { ...data, ...structuredClone(obj) };
      const size = Object.entries(next).reduce((s, [k, v]) => s + k.length + JSON.stringify(v).length, 0);
      if (size > quota) throw new Error('QUOTA_BYTES quota exceeded');
      data = next;
    },
    async remove(key) {
      for (const k of [].concat(key)) delete data[k];
    },
    async getBytesInUse() {
      return bytes();
    },
    _data: () => data,
    _replace(next) {
      data = structuredClone(next);
    },
    _reset() {
      data = {};
    },
  };
}

const syncArea = createArea();
globalThis.chrome = {
  storage: { local: createArea(), session: createArea(), sync: syncArea, onChanged: { addListener() {} } },
};

const storage = await import('../src/lib/storage.js');
const sync = await import('../src/lib/sync.js');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

beforeEach(() => {
  chrome.storage.local._reset();
  chrome.storage.session._reset();
  syncArea._reset();
});

test('처음 켤 때: local 채널을 sync로 올림, 기기별 설정 제외', async () => {
  await storage.upsertChannel(A, { name: 'A' });
  await storage.saveSettings({ restartGraceMin: 7, debugMode: true });
  await sync.startSync();
  const remote = syncArea._data();
  assert.equal(remote[`ch:${A}`].name, 'A');
  assert.equal(remote.settings.restartGraceMin, 7);
  assert.equal(remote.settings.debugMode, undefined);
  assert.equal((await sync.getSyncStatus()).state, 'ok');
});

test('새 기기: 원격 채널·설정을 받아오고 local에만 있던 채널도 유지(합집합)', async () => {
  syncArea._replace({ [`ch:${A}`]: { name: 'remote-A', addedAt: 1 }, settings: { restartGraceMin: 9 } });
  await storage.upsertChannel(B, { name: 'local-B' });
  await sync.startSync();
  const channels = await storage.getChannels();
  assert.deepEqual(Object.keys(channels).sort(), [A, B].sort());
  assert.equal((await storage.getSettings()).restartGraceMin, 9);
  assert.ok(syncArea._data()[`ch:${B}`], '합친 결과를 다시 올림');
});

test('다른 기기에서 삭제·수정 → pull로 반영, 이 기기 삭제 → push로 반영', async () => {
  await storage.upsertChannel(A, { name: 'A' });
  await storage.upsertChannel(B, { name: 'B' });
  await sync.startSync();
  // 다른 기기: B 삭제, A 이름 변경
  const remote = syncArea._data();
  syncArea._replace({ ...remote, [`ch:${A}`]: { ...remote[`ch:${A}`], name: 'A2' }, [`ch:${B}`]: undefined });
  await syncArea.remove(`ch:${B}`);
  await sync.pullFromSync();
  const channels = await storage.getChannels();
  assert.deepEqual(Object.keys(channels), [A]);
  assert.equal(channels[A].name, 'A2');
  // 이 기기에서 A 삭제
  await storage.removeChannel(A);
  await sync.pushToSync();
  assert.equal(syncArea._data()[`ch:${A}`], undefined);
});

test('용량 초과: 쓰지 않고 quota 상태, 그동안 pull이 local을 덮지 않음', async () => {
  await sync.startSync();
  // 채널 400개(항목 분할로도 총량 90% 초과)
  const channels = {};
  for (let i = 0; i < 400; i++) {
    const id = i.toString(16).padStart(32, '0');
    channels[id] = { id, name: `채널${i}`, imageUrl: `https://nng-phinf.pstatic.net/${'x'.repeat(120)}.png`, addedAt: i + 1 };
  }
  await storage.saveChannels(channels);
  await sync.pushToSync();
  const st = await sync.getSyncStatus();
  assert.equal(st.state, 'quota');
  assert.equal(st.reason, 'total');
  assert.equal(Object.keys(syncArea._data()).filter((k) => k.startsWith('ch:')).length, 0);
  await sync.pullFromSync();
  assert.equal(Object.keys(await storage.getChannels()).length, 400, 'local 유지');
});

test('동기화 끔: 상태 off, push 안 함', async () => {
  await storage.saveSettings({ syncEnabled: false });
  await storage.upsertChannel(A, { name: 'A' });
  await sync.startSync();
  await sync.pushToSync();
  assert.deepEqual(syncArea._data(), {});
  assert.equal((await sync.getSyncStatus()).state, 'off');
});
