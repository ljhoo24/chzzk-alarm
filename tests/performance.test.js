import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { diffItems } from '../src/lib/syncCodec.js';

function area() {
  let data = {};
  return {
    writes: 0,
    async get(key) { return structuredClone(key == null ? data : { [key]: data[key] }); },
    async set(values) { this.writes++; Object.assign(data, structuredClone(values)); },
    reset() { data = {}; this.writes = 0; },
  };
}
globalThis.chrome = { storage: { local: area(), session: area() } };
const storage = await import('../src/lib/storage.js');
const tracker = await import('../src/lib/tabTracker.js');
const audio = await import('../src/lib/tabAudio.js');

beforeEach(() => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
});

test('unchanged sync values do not write when object keys are reordered', () => {
  const wanted = { settings: { quietHours: { enabled: true, start: '01:00' }, keywords: ['a', 'b'] } };
  const remote = { settings: { keywords: ['a', 'b'], quietHours: { start: '01:00', enabled: true } } };
  assert.equal(diffItems(wanted, remote).changed, false);
  remote.settings.keywords.reverse();
  assert.equal(diffItems(wanted, remote).changed, true, 'array order still matters');
});

test('closing 100 unrelated tabs makes no session writes', async () => {
  for (let id = 1; id <= 100; id++) {
    await Promise.all([tracker.onTabRemoved(id), audio.onTabRemovedAudio(id)]);
  }
  assert.equal(chrome.storage.session.writes, 0);
});

test('tracked tab removal still clears state, reload history and mute tracking', async () => {
  await storage.putTabState(1, { channelId: 'a'.repeat(32), loadedAt: 123 });
  await storage.addReloadLog(1, 'broadcast', 123);
  await storage.setMutedByUs(1, true);
  await Promise.all([tracker.onTabRemoved(1), audio.onTabRemovedAudio(1)]);
  assert.deepEqual(await storage.getTabState(), {});
  assert.deepEqual(await storage.getReloadLog(), {});
  assert.deepEqual(await storage.getMutedByUs(), {});
});

test('unchanged history does not rewrite stored broadcast records', async () => {
  await storage.updateHistory(() => [{ channelId: 'a', openDate: 'broadcast' }]);
  const writes = chrome.storage.local.writes;
  await storage.updateHistory(history => history);
  assert.equal(chrome.storage.local.writes, writes);
  await storage.updateHistory(history => [...history, { channelId: 'b', openDate: 'next' }]);
  assert.equal((await storage.getHistory()).length, 2);
});
