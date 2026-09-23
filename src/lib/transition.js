// TransitionEngine: 이전 상태 + 새 관측 → 다음 상태 + 이벤트. 순수 함수.
//
// 원칙
//  - 알림은 "새 방송 식별자(openDate)가 처음 OPEN으로 관측된 순간"에만 판정한다.
//  - 조회 실패는 어떤 경우에도 status를 바꾸지 않는다(실패 횟수만 증가).
//  - 알림 판정 결과는 alertedOpenDate로 기록해 같은 방송에 대해 두 번 판정하지 않는다.

import { parseKst, isWithinDailyWindow } from './time.js';

export const INITIAL_STATE = Object.freeze({
  status: 'UNKNOWN',
  openDate: null,
  closeDate: null,
  lastChangeAt: null,
  lastCloseAt: null,
  alertedOpenDate: null,
  failCount: 0,
  lastError: null,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastChangeNotifiedAt: null,
  title: '',
  category: '',
  viewers: 0,
});

/** 제목·카테고리 키워드 필터. 키워드가 없으면 통과. */
export function matchesKeywords(keywords, title, category) {
  const list = (keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const hay = `${title || ''}\n${category || ''}`.toLowerCase();
  return list.some((k) => hay.includes(k));
}

/**
 * 새 방송에 대한 알림 여부 판정.
 * @returns {{notify: boolean, reason: string}}
 */
export function decideNotify(prev, obs, ctx) {
  const { now, settings, channel, firstObsThisSession } = ctx;
  const graceMs = settings.restartGraceMin * 60_000;
  const openMs = parseKst(obs.openDate);

  if (prev.alertedOpenDate && prev.alertedOpenDate === obs.openDate) {
    return { notify: false, reason: 'already-alerted' };
  }

  // 송출 끊김 후 재시작: 알림만 억제(새로고침은 별도로 판정).
  if (prev.status === 'CLOSE' && prev.lastCloseAt != null && openMs != null && openMs - prev.lastCloseAt < graceMs) {
    return { notify: false, reason: 'restart-grace' };
  }
  // CLOSE를 관측하지 못한 채 openDate만 바뀐 경우(한 주기 안에 끊김·재시작).
  if (prev.status === 'OPEN' && prev.lastSuccessAt != null && now - prev.lastSuccessAt <= graceMs) {
    return { notify: false, reason: 'restart-grace' };
  }

  const startup = prev.status === 'UNKNOWN' || firstObsThisSession;
  if (startup && !settings.notifyExistingOnStartup) {
    return { notify: false, reason: 'startup-disabled' };
  }
  if (!channel.notify) return { notify: false, reason: 'channel-off' };
  if (isMuted(ctx)) return { notify: false, reason: 'muted-today' };
  if (!matchesKeywords(channel.keywords, obs.title, obs.category)) {
    return { notify: false, reason: 'keyword-filter' };
  }
  if (inQuietHours(ctx)) return { notify: false, reason: 'quiet-hours' };
  return { notify: true, reason: startup ? 'startup' : 'went-live' };
}

const isMuted = ({ mutedUntil, now }) => Number.isFinite(mutedUntil) && mutedUntil > now;
const inQuietHours = ({ settings, now }) =>
  settings.quietHours.enabled && isWithinDailyWindow(now, settings.quietHours.start, settings.quietHours.end);

// 방송 중 변경 알림의 채널별 최소 간격(카테고리가 오락가락할 때 폭주 방지).
export const CHANGE_NOTIFY_COOLDOWN_MS = 5 * 60_000;

/**
 * 같은 방송 안에서의 변경 판정. 알릴 만한 변경이 없으면 null.
 *  - 카테고리 변경: 채널의 notifyCategoryChange가 켜져 있고, 새 제목·카테고리가 키워드 필터를 통과할 때
 *  - 키워드 새로 일치: 키워드가 있고, 이전에는 불일치였다가 이번에 일치할 때(시작 알림이 키워드로 생략된 경우 포함)
 */
export function decideChange(prev, obs, ctx) {
  const { channel, now } = ctx;
  const categoryChanged = !!prev.category && !!obs.category && prev.category !== obs.category;
  const hasKeywords = (channel.keywords || []).some((k) => String(k).trim());
  const keywordMatched =
    hasKeywords &&
    !matchesKeywords(channel.keywords, prev.title, prev.category) &&
    matchesKeywords(channel.keywords, obs.title, obs.category);
  const wanted =
    (categoryChanged && channel.notifyCategoryChange && matchesKeywords(channel.keywords, obs.title, obs.category)) ||
    keywordMatched;
  if (!wanted) return null;

  const change = {
    type: 'live_changed',
    openDate: obs.openDate,
    categoryFrom: categoryChanged ? prev.category : null,
    categoryTo: categoryChanged ? obs.category : null,
    keywordMatched,
  };
  let reason = null;
  if (!channel.notify) reason = 'channel-off';
  else if (isMuted(ctx)) reason = 'muted-today';
  else if (inQuietHours(ctx)) reason = 'quiet-hours';
  else if (prev.lastChangeNotifiedAt != null && now - prev.lastChangeNotifiedAt < CHANGE_NOTIFY_COOLDOWN_MS) reason = 'cooldown';
  return { ...change, notify: reason == null, reason: reason ?? (keywordMatched ? 'keyword-matched' : 'category-changed') };
}

// 방송 시작 시 탭 포커스·새 탭 열기를 허용하는 판정 결과.
// 재시작 유예·키워드 불일치·알림 금지 시간·오늘 끄기, 브라우저 시작 직후(여러 탭이 한꺼번에 열림)는 제외한다.
// 제외돼도 오프라인 탭 자동 새로고침은 별개로 동작한다.
const OPEN_ON_LIVE_REASONS = new Set(['went-live', 'channel-off', 'active-tab-reload']);

export function shouldOpenOnLive(channel, reason) {
  return !!channel.openOnLive && OPEN_ON_LIVE_REASONS.has(reason);
}

/**
 * @param prev 이전 상태(없으면 INITIAL_STATE)
 * @param obs  StatusProvider Observation
 * @param ctx  { now, settings, channel, firstObsThisSession, mutedUntil }
 * @returns {{ state, events: Array<{type: 'went_live'|'went_offline'|'live_changed', ...}> }}
 */
export function evaluate(prevIn, obs, ctx) {
  const prev = { ...INITIAL_STATE, ...(prevIn || {}) };
  const { now } = ctx;
  const events = [];

  if (!obs.ok) {
    return {
      state: { ...prev, failCount: prev.failCount + 1, lastError: obs.error ?? 'unknown', lastCheckedAt: now },
      events,
    };
  }

  const base = {
    ...prev,
    failCount: 0,
    lastError: null,
    lastCheckedAt: now,
    lastSuccessAt: now,
    title: obs.title,
    category: obs.category,
    viewers: obs.viewers,
  };

  if (obs.status === 'OPEN') {
    const isNewBroadcast = prev.status !== 'OPEN' || prev.openDate !== obs.openDate;
    if (!isNewBroadcast) {
      const change = decideChange(prev, obs, ctx);
      if (change) events.push(change);
      return {
        state: { ...base, status: 'OPEN', lastChangeNotifiedAt: change?.notify ? now : prev.lastChangeNotifiedAt },
        events,
      };
    }
    const decision = decideNotify(prev, obs, ctx);
    events.push({
      type: 'went_live',
      openDate: obs.openDate,
      fromStatus: prev.status,
      notify: decision.notify,
      reason: decision.reason,
    });
    return {
      state: {
        ...base,
        status: 'OPEN',
        openDate: obs.openDate,
        closeDate: null,
        lastChangeAt: now,
        alertedOpenDate: obs.openDate,
        lastChangeNotifiedAt: null,
      },
      events,
    };
  }

  // CLOSE
  if (prev.status === 'CLOSE') {
    return { state: { ...base, status: 'CLOSE' }, events };
  }
  const closeMs = parseKst(obs.closeDate);
  if (prev.status === 'OPEN') {
    events.push({ type: 'went_offline', openDate: prev.openDate });
  }
  return {
    state: {
      ...base,
      status: 'CLOSE',
      openDate: obs.openDate ?? prev.openDate,
      closeDate: obs.closeDate,
      lastChangeAt: now,
      // UNKNOWN → CLOSE는 서버 종료 시각만 기록(없으면 null). OPEN → CLOSE는 없으면 관측 시각.
      lastCloseAt: closeMs ?? (prev.status === 'OPEN' ? now : null),
    },
    events,
  };
}
