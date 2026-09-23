// 오프라인 라이브 페이지 자동 새로고침 판정. 순수 함수.
//
// "오프라인 화면을 보고 있는 탭"은 DOM이 아니라 탭 로드 시각과 방송 시작 시각(openDate)의 비교로 판정한다.
// 판정 조건(모두 충족 시 새로고침):
//  1. 탭 URL이 등록 채널의 라이브 페이지이고, 해당 채널의 자동 새로고침이 켜져 있음
//  2. 해당 채널이 OPEN 상태(= went_live 이후)
//  3. 탭의 마지막 로드·URL 변경 시각이 openDate보다 이전(시계 오차 허용)
//  4. reloadLog에 (탭 ID, openDate) 기록 없음
//  5. 새로고침 대상 범위에 포함
//
// 이벤트가 아니라 매 주기 상태 기반으로 판정하므로, 새로고침 직전에 워커가 종료돼도 다음 주기에 이어서 처리된다.
// 중복은 reloadLog가 막는다.

import { liveChannelIdFromUrl } from './chzzkUrl.js';
import { parseKst } from './time.js';
import { reloadLogKey } from './reloadLogKey.js';

/**
 * @param {object} p
 * @param {Array<{id:number,url:string,active?:boolean}>} p.tabs
 * @param {Record<string, object>} p.channels
 * @param {Record<string, object>} p.states
 * @param {Record<string, {channelId:string, loadedAt:number}>} p.tabState
 * @param {Record<string, number>} p.reloadLog
 * @param {object} p.settings
 * @returns {Array<{tabId:number, channelId:string, openDate:string, active:boolean}>}
 */
export function selectTabsToReload({ tabs, channels, states, tabState, reloadLog, settings }) {
  const skewMs = (settings.clockSkewSec ?? 0) * 1000;
  const result = [];
  for (const tab of tabs) {
    const channelId = liveChannelIdFromUrl(tab.url);
    if (!channelId) continue;

    const channel = channels[channelId];
    if (!channel || !channel.autoReload) continue;

    const state = states[channelId];
    if (!state || state.status !== 'OPEN') continue;
    const openMs = parseKst(state.openDate);
    if (openMs == null) continue;

    const track = tabState[tab.id];
    if (!track || track.channelId !== channelId || !Number.isFinite(track.loadedAt)) continue;
    if (track.loadedAt >= openMs + skewMs) continue; // 방송 시작 후 열린 탭 = 이미 라이브 시청 중

    if (reloadLog[reloadLogKey(tab.id, state.openDate)]) continue;

    if (settings.reloadScope === 'active' && !tab.active) continue;

    result.push({ tabId: tab.id, channelId, openDate: state.openDate, active: !!tab.active });
  }
  return result;
}
