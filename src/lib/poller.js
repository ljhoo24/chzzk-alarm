// 한 주기 폴링: 상태 조회 → 전이 판정 → 알림 → 새로고침 → 탭 포커스/열기 → 기록·배지·경고.

import { updateBadge } from './badge.js';
import { liveUrl } from './chzzkUrl.js';
import { applyObservation } from './history.js';
import { clearStall, focusTab, notifyLive, notifyStall, openLiveTab } from './notifier.js';
import { requestGap } from './scheduler.js';
import { chzzkProvider, createMockProvider } from './statusProvider.js';
import {
  addReloadLog,
  appendEventLog,
  getAllChannelState,
  getChannelMute,
  getChannels,
  getMeta,
  getMockStatus,
  getObservedThisSession,
  getSettings,
  markObservedThisSession,
  patchMeta,
  pruneChannelState,
  putChannelState,
  updateHistory,
} from './storage.js';
import { muteTab } from './tabAudio.js';
import { findReloadCandidates, reloadOfflineTabs, waitReloadDelay } from './tabReloader.js';
import { sleep } from './time.js';
import { evaluate, shouldOpenOnLive } from './transition.js';

const mockProvider = createMockProvider(getMockStatus);

/** 방송 시작 알림 처리. 최종 판정 사유를 돌려준다(탭 열기 여부 판단용). */
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
      await notifyLive(channel, state, ctx.settings, { kind: 'start' });
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
  return reason;
}

async function handleLiveChanged(channel, state, event, settings) {
  let reason = event.reason;
  let notified = event.notify;
  if (event.notify) {
    try {
      await notifyLive(channel, state, settings, { kind: 'change', change: event });
    } catch (e) {
      reason = `notify-error: ${e?.message ?? e}`;
      notified = false;
    }
  }
  await appendEventLog({
    at: Date.now(),
    type: 'live_changed',
    channelId: channel.id,
    name: channel.name,
    openDate: event.openDate,
    categoryFrom: event.categoryFrom,
    categoryTo: event.categoryTo,
    keywordMatched: event.keywordMatched,
    notified,
    reason,
  });
}

/**
 * 방송 시작 시 탭 포커스/열기.
 *  - 이번 주기에 새로고침한 탭이 있으면 그 탭으로 포커스(포커스 전환 설정이 켜진 경우)
 *  - 해당 채널의 라이브 탭이 하나도 없으면 새 탭으로 열기(포커스 전환이 꺼져 있으면 백그라운드 + 음소거)
 *  - 이미 방송 시작 후 연 탭이 있으면(시청 중) 건드리지 않음
 */
async function openOrFocus(channelId, reloaded, ctx) {
  const { settings, states } = ctx;
  const mine = reloaded.filter((c) => c.channelId === channelId);
  if (mine.length) {
    if (!settings.focusOnLive) return false;
    const target = mine.find((c) => c.focused) ?? mine[0];
    await focusTab({ id: target.tabId, windowId: target.windowId });
    await appendEventLog({ at: Date.now(), type: 'focus', channelId, tabId: target.tabId });
    return true;
  }
  const existing = await chrome.tabs.query({ url: `${liveUrl(channelId)}*` });
  if (existing.length) return false;

  await waitReloadDelay(settings, states[channelId]?.lastChangeAt);
  const { tab, created } = await openLiveTab(channelId, { active: settings.focusOnLive });
  if (!created) return false;
  if (tab.id == null) return true;
  // 확장이 연 탭은 이 방송에 대해 처리 완료로 기록. 감지가 빨라 로드 시각이 시계 오차 허용 범위에 들어도 다시 새로고침하지 않는다.
  if (states[channelId]?.openDate) await addReloadLog(tab.id, states[channelId].openDate, Date.now());
  const muted = !settings.focusOnLive && settings.muteBackgroundTabs;
  if (muted) await muteTab(tab.id);
  await appendEventLog({ at: Date.now(), type: 'open', channelId, tabId: tab.id, focused: settings.focusOnLive, muted });
  return true;
}

async function checkStall(channels, settings) {
  const states = await getAllChannelState();
  const failing = Object.keys(channels).filter((id) => (states[id]?.failCount ?? 0) >= settings.failWarnThreshold);
  const { stallNotified } = await getMeta();
  if (failing.length && !stallNotified) {
    // 네트워크 자체가 끊긴 경우는 API 문제가 아니므로 경고하지 않는다(배지 경고는 유지).
    if (!settings.stallNotify || globalThis.navigator?.onLine === false) return;
    await notifyStall(failing.map((id) => channels[id].name || id));
    await patchMeta({ stallNotified: true });
  } else if (!failing.length && stallNotified) {
    await clearStall();
    await patchMeta({ stallNotified: false });
  }
}

// 서비스 워커 인스턴스는 항상 하나이므로 메모리 플래그로 중복 실행을 막는다.
// 워커가 도중에 종료되면 플래그도 함께 사라져 다음 주기가 막히지 않는다.
let running = false;

/**
 * 이전 주기가 아직 진행 중이면 건너뛴다.
 * @returns 요약 { skipped?, checked, wentLive, wentOffline, changed, failed, reloaded, opened }
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
  const summary = { checked: 0, wentLive: 0, wentOffline: 0, changed: 0, failed: 0, reloaded: 0, opened: 0 };
  const [settings, channels, channelMute] = await Promise.all([getSettings(), getChannels(), getChannelMute()]);
  const provider = settings.debugMode ? mockProvider : chzzkProvider;
  const ids = Object.keys(channels);
  const gap = settings.debugMode ? 0 : requestGap(ids.length);
  const observed = await getObservedThisSession();
  const observations = [];
  const openTargets = [];

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
      mutedUntil: channelMute[id],
    });
    // 매 채널 처리 직후 저장: 도중에 워커가 종료돼도 다음 주기에 이어서 판정된다.
    await putChannelState(id, state);
    observations.push({ channel, obs, now });
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
        const reason = await handleWentLive(channel, state, ev, { channels, states, settings });
        if (shouldOpenOnLive(channel, reason)) openTargets.push(id);
      } else if (ev.type === 'live_changed') {
        summary.changed++;
        await handleLiveChanged(channel, state, ev, settings);
      } else if (ev.type === 'went_offline') {
        summary.wentOffline++;
        await appendEventLog({ at: now, type: 'went_offline', channelId: id, name: channel.name, openDate: ev.openDate });
      }
    }
    if (events.length || (prev?.failCount ?? 0) !== state.failCount) await updateBadge();
  }

  await pruneChannelState(new Set(ids));
  const states = await getAllChannelState();
  const ctx = { channels, states, settings };
  // 곧 포커스할 채널의 탭은 음소거하지 않는다.
  const noMute = settings.focusOnLive ? new Set(openTargets) : new Set();
  const reloaded = await reloadOfflineTabs(ctx, { noMute });
  summary.reloaded = reloaded.length;

  for (const id of openTargets) {
    try {
      if (await openOrFocus(id, reloaded, ctx)) summary.opened++;
    } catch (e) {
      await appendEventLog({ at: Date.now(), type: 'open-failed', channelId: id, error: String(e?.message ?? e) });
    }
  }

  // 기록은 주기당 한 번에 저장(레코드가 많아도 쓰기 횟수 유지).
  await updateHistory((history) => observations.reduce((h, o) => applyObservation(h, o.channel, o.obs, o.now), history));

  await updateBadge();
  await checkStall(channels, settings);
  await patchMeta({
    lastPollAt: startedAt,
    lastPollDurationMs: Date.now() - startedAt,
    provider: provider.name,
    lastSummary: summary,
  });
  return summary;
}

/** 30분 뒤 다시 알림: 같은 방송이 아직 진행 중이고 오늘 끄기 상태가 아니면 재알림. */
export async function handleSnooze({ channelId, openDate }) {
  const [channels, states, settings, mute] = await Promise.all([getChannels(), getAllChannelState(), getSettings(), getChannelMute()]);
  const channel = channels[channelId];
  const state = states[channelId];
  if (!channel || state?.status !== 'OPEN' || state.openDate !== openDate) return false;
  if ((mute[channelId] ?? 0) > Date.now()) return false;
  await notifyLive(channel, state, settings, { kind: 'reminder' });
  await appendEventLog({ at: Date.now(), type: 'reminder', channelId, name: channel.name, openDate });
  return true;
}
