# 치지직 라이브 알림 (Chrome 확장, MV3)

등록한 치지직 채널의 방송 시작을 30초 주기로 감지해 Windows 알림을 띄우고, 해당 채널의 **오프라인 라이브 페이지가 열려 있으면 방송당 탭별 1회 자동 새로고침**하는 개인용 확장입니다. 설계는 [docs/구현계획.md](docs/구현계획.md)를 따릅니다.

## 설치 (개발자 모드)

1. [Releases](https://github.com/ljhoo24/chzzk-alarm/releases)에서 `chzzk-alarm-vX.Y.Z.zip`을 받아 원하는 폴더에 압축 해제(또는 이 저장소를 클론)
2. `chrome://extensions` → 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** → `manifest.json`이 있는 폴더 선택
4. 설치 직후 열리는 설정 페이지에서 채널 URL을 붙여 넣어 등록
5. 설정 페이지의 **초기 설정 체크리스트** 확인(Windows 알림 권한, 방해 금지 모드, 테스트 알림)

코드 수정 후에는 확장 카드의 새로고침 버튼으로 다시 로드합니다. 압축 해제한 폴더를 지우거나 옮기면 확장이 사라지므로 고정된 위치에 두세요.

### 배포용 zip 만들기

```bash
npm run package
```

커밋된 HEAD 기준으로 `manifest.json`, `src/`, `icons/`만 담아 `dist/chzzk-alarm-v{manifest 버전}.zip`을 만듭니다.

## 구현 범위

| 단계 | 상태 | 내용 |
| --- | --- | --- |
| 0. 사전 검증 | 일부 완료 | 아래 "사전 검증 결과" 참고 |
| 1. 감지·알림 | 완료 | 수동 채널 등록, 30초 폴링, 전이 판정, 알림, 클릭 시 탭 열기/활성화 |
| 2. 자동 새로고침 | 완료 | TabTracker, TabReloader, reloadLog |
| 3. 표시 | 완료 | 툴바 배지, 팝업 라이브 목록(제목·시청자·경과), 연속 실패 경고 |
| 4. 팔로잉 동기화 | 미구현 | 0단계 쿠키 전달 검증 후 진행 |
| 5. 설정 확장 | 완료 | 채널별 알림/새로고침 on/off, 키워드 필터, 알림 금지 시간대, 활성 탭 알림 생략 |

## 사전 검증 결과 (2026-09-23)

| 항목 | 결과 |
| --- | --- |
| 비공식 상태 조회 | `GET https://api.chzzk.naver.com/polling/v2/channels/{id}/live-status` 로그인 없이 동작. `content.status`(OPEN/CLOSE), `openDate`, `closeDate`, `liveTitle`, `concurrentUserCount`, `liveCategoryValue` 확인. 시각은 **KST** 문자열(`2026-09-23 16:52:15`). 방송 이력이 없는 채널은 `content: null`, 없는 채널은 `code: 404`. 오프라인 채널도 마지막 방송의 openDate/closeDate를 돌려줌 |
| 채널 정보 | `GET /service/v1/channels/{id}` → `channelName`, `channelImageUrl`. User-Agent가 `node`면 연결이 끊김(브라우저 UA는 정상) |
| 프로필 이미지 | `nng-phinf.pstatic.net`은 CORS 헤더가 없어 알림 아이콘용 data URL 변환에 **호스트 권한 추가**가 필요했음 |
| 오프라인 페이지 자동 전환 | **미확인** — 실제 방송 시작 시점에 확인 필요. 자동 전환한다면 재생 상태 확인 보조 조건 추가 검토 |
| 서비스 워커 로그인 쿠키 전달 | **미확인** — 4단계 착수 전 확인 |

## 구조

```
manifest.json
src/
  background.js          서비스 워커 진입점(이벤트 연결만, 무상태)
  lib/
    statusProvider.js    StatusProvider — 비공식 API는 여기에만 존재(+ 모의 제공자)
    transition.js        TransitionEngine — 순수 함수, 알림 판정
    reloadPolicy.js      새로고침 대상 판정 — 순수 함수
    tabReloader.js       TabReloader — reloadLog 선기록 후 새로고침
    tabTracker.js        TabTracker — 라이브 탭 로드·URL 변경 시각 기록
    notifier.js          Notifier — 알림 생성, 클릭 시 탭 열기
    badge.js             BadgeUpdater
    scheduler.js         알람 등록·재등록, 요청 간격 분산
    poller.js            한 주기 오케스트레이션
    storage.js           chrome.storage 접근(local/session)
    settings.js, time.js, chzzkUrl.js, reloadLogKey.js
  popup/                 툴바 팝업
  options/               채널 등록·설정·디버그(모의 상태)·이벤트 로그
tests/                   node:test 단위·통합 테스트
tools/make-icons.mjs     아이콘 PNG 생성
tools/package.mjs        배포용 zip 생성
```

## 테스트

```bash
npm test
```

외부 의존성 없이 Node 20+에서 실행됩니다. `tests/poller.test.js`는 chrome API를 메모리 구현으로 대체하고 모의 상태 제공자로 검증 계획 T1~T12 시나리오를 재현합니다.

브라우저에서 수동 검증하려면 설정 페이지 → **디버그 모드**를 켜고, 채널별 `OPEN (새 방송)` / `CLOSE` / `조회 실패` 버튼으로 상태를 바꾼 뒤 **지금 폴링**을 누릅니다. 결과는 "최근 이벤트"에 기록됩니다.

## 계획 대비 구현 결정

- **권한 6개**: 계획의 5개에 프로필 이미지 호스트(`nng-phinf.pstatic.net`)를 추가. 알림 API가 원격 이미지 URL을 받지 않고, 해당 호스트가 CORS를 허용하지 않기 때문. 빼면 기본 아이콘으로 동작함.
- **새로고침은 상태 기반 판정**: went_live 이벤트 시점에만 판정하지 않고, 매 주기 "OPEN 채널 × 로드 시각 < openDate × reloadLog 없음"을 판정. 새로고침 지연 중 워커가 종료돼도 다음 주기에 이어서 처리되고, 중복은 reloadLog가 막음.
- **UNKNOWN(브라우저 시작 직후) 판정**: 상태는 local 저장소에 남으므로 재시작 후에도 이전 상태가 있음. 대신 "이번 브라우저 세션에서 처음 관측한 채널"(session 저장소)을 시작 직후로 보고 `브라우저 시작 시 이미 진행 중인 방송도 알림` 설정을 적용. 이미 알린 openDate는 재알림하지 않음.
- **한 주기 안의 재시작**: CLOSE를 관측하지 못하고 openDate만 바뀐 경우, 직전 성공 조회가 유예 시간 이내면 재시작으로 보고 알림만 억제.
- **API가 잠깐 CLOSE → 같은 openDate로 OPEN**: `alertedOpenDate`로 중복 알림 차단.
- **폴링 중복 실행 방지**: 워커 인스턴스는 하나이므로 메모리 플래그 사용(워커 종료 시 자동 해제).
- **시계 오차**: 탭 로드 시각이 `openDate + 10초`보다 이전이면 새로고침 대상(누락 방지 우선).

미결정 사항의 기본값(설정에서 변경 가능):

| 항목 | 기본값 |
| --- | --- |
| 새로고침 실행 지연 | 3초 |
| 재시작 유예 시간 | 5분 |
| 새로고침한 탭이 활성 탭일 때 알림 생략 | 끔 |
