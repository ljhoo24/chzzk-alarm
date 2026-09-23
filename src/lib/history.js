// 방송 기록. 순수 함수.
// 방송 1회 = openDate. 폴링으로 관측한 동안 시청자 수 표본·카테고리를 모으고, 종료 시 closeDate를 채운다.
// 크롬이 꺼져 있어 시작을 못 본 방송도, 이후 CLOSE 응답에 마지막 방송의 openDate/closeDate가 오면 기록에 추가한다(observed=false).
//
// 레코드: { channelId, name, openDate, closeDate, title, categories[], peakViewers, viewerSum, viewerSamples, lastSeenAt, observed }

export const HISTORY_MAX = 3000;
const MAX_CATEGORIES = 10;

const keyOf = (channelId, openDate) => `${channelId}|${openDate}`;

function addCategory(list, category) {
  if (!category || list.includes(category)) return list;
  return [...list, category].slice(0, MAX_CATEGORIES);
}

/**
 * 관측 1건을 기록에 반영한 새 배열을 돌려준다. 바뀐 게 없으면 원래 배열 그대로.
 * @param history 기존 기록
 * @param channel { id, name }
 * @param obs     StatusProvider Observation
 * @param now     관측 시각(ms)
 */
export function applyObservation(history, channel, obs, now) {
  if (!obs?.ok || !obs.openDate) return history;
  const key = keyOf(channel.id, obs.openDate);
  const idx = history.findIndex((r) => keyOf(r.channelId, r.openDate) === key);
  const existing = idx >= 0 ? history[idx] : null;

  let next;
  if (obs.status === 'OPEN') {
    const base = existing ?? {
      channelId: channel.id,
      name: channel.name,
      openDate: obs.openDate,
      closeDate: null,
      title: '',
      categories: [],
      peakViewers: 0,
      viewerSum: 0,
      viewerSamples: 0,
      lastSeenAt: now,
      observed: true,
    };
    next = {
      ...base,
      name: channel.name || base.name,
      closeDate: null,
      title: obs.title || base.title,
      categories: addCategory(base.categories, obs.category),
      peakViewers: Math.max(base.peakViewers, obs.viewers || 0),
      viewerSum: base.viewerSum + (obs.viewers || 0),
      viewerSamples: base.viewerSamples + 1,
      lastSeenAt: now,
    };
  } else {
    // CLOSE: 이미 종료 기록이 있으면 그대로.
    if (existing?.closeDate) return history;
    if (!obs.closeDate) return history;
    next = existing
      ? { ...existing, closeDate: obs.closeDate }
      : {
          channelId: channel.id,
          name: channel.name,
          openDate: obs.openDate,
          closeDate: obs.closeDate,
          title: obs.title || '',
          categories: addCategory([], obs.category),
          peakViewers: 0,
          viewerSum: 0,
          viewerSamples: 0,
          lastSeenAt: null,
          observed: false,
        };
  }

  const out = history.slice();
  if (idx >= 0) out[idx] = next;
  else out.push(next);
  if (out.length > HISTORY_MAX) {
    out.sort((a, b) => (a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0));
    out.splice(0, out.length - HISTORY_MAX);
  }
  return out;
}

/** 가져오기용 병합: (channelId, openDate) 기준 중복 제거, 기존 레코드 우선. */
export function mergeHistory(current, incoming) {
  const seen = new Set(current.map((r) => keyOf(r.channelId, r.openDate)));
  const add = (incoming || []).filter(
    (r) => r && typeof r.channelId === 'string' && typeof r.openDate === 'string' && !seen.has(keyOf(r.channelId, r.openDate)),
  );
  return [...current, ...add].sort((a, b) => (a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0)).slice(-HISTORY_MAX);
}
