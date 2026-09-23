import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractChannelId, liveChannelIdFromUrl } from '../src/lib/chzzkUrl.js';
import { normalizeLiveStatus } from '../src/lib/statusProvider.js';
import { formatElapsed, formatKst, isWithinDailyWindow, parseKst } from '../src/lib/time.js';
import { requestGap } from '../src/lib/scheduler.js';

const ID = '7c142828b058c160e125d370e2c6c80f';

test('extractChannelId: URL/ID 형식', () => {
  assert.equal(extractChannelId(ID), ID);
  assert.equal(extractChannelId(ID.toUpperCase()), ID);
  assert.equal(extractChannelId(`https://chzzk.naver.com/live/${ID}`), ID);
  assert.equal(extractChannelId(`https://chzzk.naver.com/${ID}`), ID);
  assert.equal(extractChannelId(`https://chzzk.naver.com/${ID}/videos?x=1`), ID);
  assert.equal(extractChannelId(`chzzk.naver.com/live/${ID}`), ID);
  assert.equal(extractChannelId(`  https://m.chzzk.naver.com/live/${ID}  `), ID);
  assert.equal(extractChannelId(`https://example.com/live/${ID}`), null);
  assert.equal(extractChannelId('https://chzzk.naver.com/lives'), null);
  assert.equal(extractChannelId(''), null);
});

test('liveChannelIdFromUrl: 라이브 페이지만', () => {
  assert.equal(liveChannelIdFromUrl(`https://chzzk.naver.com/live/${ID}`), ID);
  assert.equal(liveChannelIdFromUrl(`https://chzzk.naver.com/live/${ID}?t=1#x`), ID);
  assert.equal(liveChannelIdFromUrl(`https://chzzk.naver.com/${ID}`), null);
  assert.equal(liveChannelIdFromUrl('https://chzzk.naver.com/live/abc'), null);
  assert.equal(liveChannelIdFromUrl(undefined), null);
});

test('parseKst / formatKst', () => {
  assert.equal(parseKst('2026-09-23 16:52:15'), Date.parse('2026-09-23T07:52:15Z'));
  assert.equal(parseKst('bad'), null);
  assert.equal(parseKst(null), null);
  assert.equal(formatKst(Date.parse('2026-09-23T07:52:15Z')), '2026-09-23 16:52:15');
});

test('isWithinDailyWindow: 자정 넘는 구간', () => {
  const at = (h, m) => new Date(2026, 8, 23, h, m).getTime();
  assert.equal(isWithinDailyWindow(at(2, 0), '01:00', '08:00'), true);
  assert.equal(isWithinDailyWindow(at(8, 0), '01:00', '08:00'), false);
  assert.equal(isWithinDailyWindow(at(23, 30), '23:00', '07:00'), true);
  assert.equal(isWithinDailyWindow(at(6, 59), '23:00', '07:00'), true);
  assert.equal(isWithinDailyWindow(at(12, 0), '23:00', '07:00'), false);
  assert.equal(isWithinDailyWindow(at(12, 0), '12:00', '12:00'), false);
});

test('formatElapsed', () => {
  assert.equal(formatElapsed(65_000), '1:05');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
});

test('requestGap: NFR-4 요청 분산', () => {
  assert.equal(requestGap(1), 0);
  assert.equal(requestGap(5), 1000);
  assert.equal(requestGap(40), 500);
  assert.ok(requestGap(100) * 100 <= 20_000);
});

test('normalizeLiveStatus: 실제 응답 형식', () => {
  const open = normalizeLiveStatus({
    liveTitle: 't', status: 'OPEN', concurrentUserCount: 9286, openDate: '2026-09-23 08:50:08', closeDate: null, liveCategoryValue: '2026 아시안게임',
  });
  assert.deepEqual(open, { ok: true, status: 'OPEN', openDate: '2026-09-23 08:50:08', closeDate: null, title: 't', category: '2026 아시안게임', viewers: 9286 });

  const closed = normalizeLiveStatus({ status: 'CLOSE', openDate: '2026-08-30 13:30:02', closeDate: '2026-08-30 18:26:45', liveTitle: 'x' });
  assert.equal(closed.status, 'CLOSE');
  assert.equal(closed.closeDate, '2026-08-30 18:26:45');

  // 한 번도 방송하지 않은 채널
  assert.equal(normalizeLiveStatus(null).status, 'CLOSE');

  // 형식 변경은 조회 실패로 취급(throw)
  assert.throws(() => normalizeLiveStatus({ status: 'LIVE' }));
  assert.throws(() => normalizeLiveStatus({ status: 'OPEN' }));
  assert.throws(() => normalizeLiveStatus(undefined));
});
