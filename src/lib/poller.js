// 한 주기 폴링: 상태 조회 → 전이 판정 → 알림 → 새로고침 → 배지.

import { updateBadge } from './badge.js';
import { notifyLive } from './notifier.js';
import { requestGap } from './scheduler.js';
import { chzzkProvider, createMockProvider } from './statusProvider.js';
import {
  appendEventLog,
  getAllChannelState,
  getChannels,
  getMockStatus,
  getObservedThisSession,
  getSettings,
  markObservedThisSession,
  patchMeta,
  pruneChannelState,
  putChannelState,
} from './storage.js';
import { findReloadCandidates, reloadOfflineTabs } from './tabReloader.js';
import { sleep } from './time.js';
import { evaluate } from './transition.js';

const mockProvider = createMockProvider(getMockStatus);

async function handleWentLive(channel, state, event, ctx) {
  let notify = event.notify;
  let reason = event.reason;
  if (notify && ctx.settings.skipNotifyIfActiveReload) {
    const candidates = await findReloadCandidates(ctx);
    if (candidates.some((c) => c.channelId === channel.id && c.focused)) {
      notify = false;
      reason = 'active-tab-reload';
    }
  }
  if (notify) {
    try {
      await notifyLive(channel, state, ctx.settings);
    } catch (e) {
      reason = `notify-error: ${e?.message ?? e}`;
      notify = false;
    }
  }
  await appendEventLog({
    at: Date.now(),
    type: 'went_live',
    channelId: channel.id,
    name: channel.name,
    openDate: event.openDate,
    title: state.title,
    notified: notify,
    reason,
  });
}

// 서비스 워커 인스턴스는 항상 하나이므로 메모리 플래그로 중복 실행을 막는다.
// 워커가 도중에 종료되면 플래그도 함께 사라져 다음 주기가 막히지 않는다.
let running = false;

/**
 * 이전 주기가 아직 진행 중이면 건너뛴다.
 * @returns 요약 { skipped?, checked, wentLive, wentOffline, failed, reloaded }
 */
export async function runPoll() {
  if (running) return { skipped: true };
  running = true;
  try {
    return await pollOnce();
  } finally {
    running = false;
  }
}

async function pollOnce() {
  const startedAt = Date.now();
  const summary = { checked: 0, wentLive: 0, wentOffline: 0, failed: 0, reloaded: 0 };
  const [settings, channels] = await Promise.all([getSettings(), getChannels()]);
  const provider = settings.debugMode ? mockProvider : chzzkProvider;
  const ids = Object.keys(channels);
  const gap = settings.debugMode ? 0 : requestGap(ids.length);
  const observed = await getObservedThisSession();

  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && gap) await sleep(gap);
    const id = ids[i];
    const channel = channels[id];
    const obs = await provider.fetchStatus(id);
    const now = Date.now();
    const prev = (await getAllChannelState())[id];
    const { state, events } = evaluate(prev, obs, {
      now,
      settings,
      channel,
      firstObsThisSession: !observed[id],
    });
    // 매 채널 처리 직후 저장: 도중에 워커가 종료돼도 다음 주기에 이어서 판정된다.
    await putChannelState(id, state);
    summary.checked++;
    if (!obs.ok) summary.failed++;
    else if (!observed[id]) {
      observed[id] = true;
      await markObservedThisSession(id);
    }

    for (const ev of events) {
      if (ev.type === 'went_live') {
        summary.wentLive++;
        const states = await getAllChannelState();
        await handleWentLive(channel, state, ev, { channels, states, settings });
      } else if (ev.type === 'went_offline') {
        summary.wentOffline++;
        await appendEventLog({ at: now, type: 'went_offline', channelId: id, name: channel.name, openDate: ev.openDate });
      }
    }
    if (events.length || (prev?.failCount ?? 0) !== state.failCount) await updateBadge();
  }

  await pruneChannelState(new Set(ids));
  const states = await getAllChannelState();
  const reloaded = await reloadOfflineTabs({ channels, states, settings });
  summary.reloaded = reloaded.length;

  await updateBadge();
  await patchMeta({
    lastPollAt: startedAt,
    lastPollDurationMs: Date.now() - startedAt,
    provider: provider.name,
    lastSummary: summary,
  });
  return summary;
}
