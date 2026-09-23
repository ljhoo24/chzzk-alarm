// 전역 설정 기본값과 병합. 순수 모듈.

export const MIN_POLL_INTERVAL_SEC = 30;

export const DEFAULT_SETTINGS = Object.freeze({
  pollIntervalSec: 30,
  // 송출 끊김 후 이 시간 안에 새 방송이 시작되면 알림만 억제한다.
  restartGraceMin: 5,
  // 브라우저 시작 직후(또는 신규 등록 직후) 이미 진행 중인 방송도 알림.
  notifyExistingOnStartup: true,
  // 새로고침 대상 범위: 'all' = 백그라운드 탭 포함 열린 탭 전부.
  reloadScope: 'all',
  // 방송 감지 후 새로고침까지 대기(플레이어 스트림 준비 시간).
  reloadDelaySec: 3,
  // 탭 로드 시각(로컬)과 openDate(서버) 비교 시 허용 오차.
  clockSkewSec: 10,
  // 알림을 사용자가 닫을 때까지 유지.
  requireInteraction: true,
  // 새로고침한 탭이 현재 보고 있는 탭이면 알림 생략.
  skipNotifyIfActiveReload: false,
  quietHours: { enabled: false, start: '01:00', end: '08:00' },
  // 연속 조회 실패가 이 횟수 이상이면 배지 경고.
  failWarnThreshold: 3,
  // 연속 실패 기준을 넘는 순간 Windows 알림으로도 1회 경고.
  stallNotify: true,
  // 방송 시작 시 새로고침한 탭(없으면 새로 연 탭)으로 포커스 전환. 끄면 백그라운드로 두고 음소거.
  focusOnLive: true,
  // 자동 새로고침·자동 열기한 백그라운드 탭을 음소거(탭을 보면 해제).
  muteBackgroundTabs: true,
  // 채널·설정을 구글 계정(chrome.storage.sync)에 동기화. 기기별 설정이라 동기화 대상 아님.
  syncEnabled: true,
  // 모의 상태 제공자 사용(옵션 페이지에서 상태를 수동 전환).
  debugMode: false,
});

// 기기마다 다르게 둘 설정(동기화하지 않음).
export const DEVICE_ONLY_SETTINGS = Object.freeze(['debugMode', 'syncEnabled']);

export const DEFAULT_CHANNEL = Object.freeze({
  name: '',
  imageUrl: '',
  notify: true,
  autoReload: true,
  // 방송 시작 시 새로고침한 탭으로 포커스, 열린 탭이 없으면 새 탭으로 열기.
  openOnLive: true,
  // 방송 중 카테고리가 바뀌면 알림.
  notifyCategoryChange: false,
  keywords: [],
  source: 'manual',
  addedAt: 0,
});

export function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  s.quietHours = { ...DEFAULT_SETTINGS.quietHours, ...(stored?.quietHours || {}) };
  s.pollIntervalSec = Math.max(MIN_POLL_INTERVAL_SEC, Number(s.pollIntervalSec) || MIN_POLL_INTERVAL_SEC);
  return s;
}

export function normalizeChannel(id, stored) {
  return { ...DEFAULT_CHANNEL, ...(stored || {}), id };
}
