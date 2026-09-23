// TabReloader: 오프라인 라이브 탭을 방송당 탭별 1회 새로고침한다.

import { LIVE_URL_PATTERN } from './chzzkUrl.js';
import { selectTabsToReload } from './reloadPolicy.js';
import { addReloadLog, appendEventLog, getReloadLog, getTabState } from './storage.js';
import { sleep } from './time.js';

/** 현재 조건을 만족하는 새로고침 후보. 창 포커스 여부(focused)도 함께 돌려준다. */
export async function findReloadCandidates({ channels, states, settings }) {
  const [tabs, tabState, reloadLog, focusedWin] = await Promise.all([
    chrome.tabs.query({ url: LIVE_URL_PATTERN }),
    getTabState(),
    getReloadLog(),
    chrome.windows.getLastFocused().catch(() => null),
  ]);
  const windowOf = new Map(tabs.map((t) => [t.id, t.windowId]));
  return selectTabsToReload({ tabs, channels, states, tabState, reloadLog, settings }).map((c) => ({
    ...c,
    focused: c.active && !!focusedWin?.focused && windowOf.get(c.tabId) === focusedWin.id,
  }));
}

/**
 * 후보를 찾아 (지연 후) 새로고침한다.
 * 지연 중 상태가 바뀔 수 있으므로 지연 후 다시 판정하고, 실행 직전에 reloadLog를 먼저 기록한다.
 * 기록 후 워커가 종료돼도 다음 주기에 중복 실행되지 않는다(1회 보장, 재시도 없음).
 */
export async function reloadOfflineTabs(ctx) {
  const first = await findReloadCandidates(ctx);
  if (first.length === 0) return [];

  const delayMs = Math.max(0, (ctx.settings.reloadDelaySec ?? 0) * 1000);
  // 지연은 방송 감지 시각 기준. 이전 주기에 감지됐다면 이미 지난 만큼 뺀다.
  const detectedAt = Math.min(...first.map((c) => ctx.states[c.channelId]?.lastChangeAt ?? Date.now()));
  const wait = delayMs - (Date.now() - detectedAt);
  if (wait > 0) await sleep(wait);

  const candidates = await findReloadCandidates(ctx);
  const done = [];
  for (const c of candidates) {
    await addReloadLog(c.tabId, c.openDate, Date.now());
    try {
      await chrome.tabs.reload(c.tabId);
      done.push(c);
      await appendEventLog({ at: Date.now(), type: 'reload', channelId: c.channelId, tabId: c.tabId, openDate: c.openDate });
    } catch (e) {
      // 탭이 닫힌 경우 등. 재시도하지 않는다.
      await appendEventLog({ at: Date.now(), type: 'reload-failed', channelId: c.channelId, tabId: c.tabId, error: String(e?.message ?? e) });
    }
  }
  return done;
}
