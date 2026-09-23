// StatusProvider: 채널 라이브 상태 조회.
// 비공식 치지직 API 호출은 이 모듈에만 존재한다(NFR-5). 엔드포인트가 바뀌면 여기만 고친다.
//
// 반환 형식(Observation):
//   성공: { ok: true, status: 'OPEN'|'CLOSE', openDate, closeDate, title, category, viewers }
//   실패: { ok: false, error }
// openDate/closeDate는 서버가 준 원문 문자열(KST). openDate는 방송 1회를 식별하는 키로 쓴다.

const API = 'https://api.chzzk.naver.com';

async function getJson(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 200) throw new Error(`API code ${body?.code}: ${body?.message ?? ''}`);
  return body.content;
}

/** live-status 응답의 content를 Observation으로 정규화한다. 형식이 이상하면 throw(=조회 실패). */
export function normalizeLiveStatus(content) {
  // 한 번도 방송하지 않은 채널은 content가 null.
  if (content === null) {
    return { ok: true, status: 'CLOSE', openDate: null, closeDate: null, title: '', category: '', viewers: 0 };
  }
  if (typeof content !== 'object' || (content.status !== 'OPEN' && content.status !== 'CLOSE')) {
    throw new Error('unexpected live-status format');
  }
  if (content.status === 'OPEN' && typeof content.openDate !== 'string') {
    throw new Error('OPEN without openDate');
  }
  return {
    ok: true,
    status: content.status,
    openDate: content.openDate ?? null,
    closeDate: content.closeDate ?? null,
    title: content.liveTitle ?? '',
    category: content.liveCategoryValue ?? '',
    viewers: Number(content.concurrentUserCount) || 0,
  };
}

export const chzzkProvider = {
  name: 'chzzk',
  async fetchStatus(channelId) {
    try {
      const content = await getJson(`${API}/polling/v2/channels/${channelId}/live-status`);
      return normalizeLiveStatus(content);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

/** 채널 정보(이름, 프로필 이미지). 등록 시 사용. 채널이 없으면 null. */
export async function fetchChannelInfo(channelId) {
  const content = await getJson(`${API}/service/v1/channels/${channelId}`);
  if (!content?.channelId) return null;
  return { name: content.channelName ?? '', imageUrl: content.channelImageUrl ?? '' };
}

/**
 * 모의 상태 제공자. 옵션 페이지 디버그 모드에서 저장한 mockStatus를 그대로 돌려준다.
 * mockStatus[id] = { status, openDate, title, category, viewers, fail }
 */
export function createMockProvider(getMockStatus) {
  return {
    name: 'mock',
    async fetchStatus(channelId) {
      const all = await getMockStatus();
      const m = all[channelId];
      if (!m) return { ok: true, status: 'CLOSE', openDate: null, closeDate: null, title: '', category: '', viewers: 0 };
      if (m.fail) return { ok: false, error: 'mock failure' };
      return {
        ok: true,
        status: m.status,
        openDate: m.openDate ?? null,
        closeDate: m.closeDate ?? null,
        title: m.title ?? '(모의 방송)',
        category: m.category ?? '',
        viewers: m.viewers ?? 0,
      };
    },
  };
}
