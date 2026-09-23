import { extractChannelId } from '../lib/chzzkUrl.js';
import { fetchChannelInfo } from '../lib/statusProvider.js';
import {
  getAllChannelState,
  getChannels,
  getEventLog,
  getMockStatus,
  getSettings,
  removeChannel,
  saveSettings,
  setMockStatus,
  upsertChannel,
} from '../lib/storage.js';
import { formatKst } from '../lib/time.js';

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function showMsg(node, text, isError = false) {
  node.hidden = !text;
  node.textContent = text;
  node.classList.toggle('error', isError);
}

function stateBadge(state, settings) {
  if (!state) return el('span', { class: 'badge', text: '미조회' });
  if ((state.failCount ?? 0) >= settings.failWarnThreshold) {
    return el('span', { class: 'badge fail', text: `실패 ${state.failCount}회`, title: state.lastError ?? '' });
  }
  if (state.status === 'OPEN') return el('span', { class: 'badge open', text: 'LIVE', title: state.title });
  if (state.status === 'CLOSE') return el('span', { class: 'badge', text: '오프라인' });
  return el('span', { class: 'badge', text: '미확인' });
}

// ---- 채널 목록 ----
async function renderChannels() {
  const tbody = $('channel-rows');
  // 키워드 입력 중에는 다시 그리지 않는다(입력 내용 보존).
  if (tbody.contains(document.activeElement) && document.activeElement.type === 'text') return;

  const [channels, states, settings] = await Promise.all([getChannels(), getAllChannelState(), getSettings()]);
  const ids = Object.keys(channels);
  $('no-channels').hidden = ids.length > 0;
  $('channel-table').hidden = ids.length === 0;

  tbody.replaceChildren(
    ...ids.map((id) => {
      const c = channels[id];
      return el('tr', {}, [
        el('td', { class: 'ch' }, [
          c.imageUrl ? el('img', { src: c.imageUrl, alt: '' }) : '',
          el('div', {}, [
            el('a', { href: `https://chzzk.naver.com/live/${id}`, target: '_blank', text: c.name || id }),
            el('small', { text: id }),
          ]),
        ]),
        el('td', {}, [stateBadge(states[id], settings)]),
        el('td', {}, [
          el('input', { type: 'checkbox', checked: c.notify, onchange: (e) => upsertChannel(id, { notify: e.target.checked }) }),
        ]),
        el('td', {}, [
          el('input', { type: 'checkbox', checked: c.autoReload, onchange: (e) => upsertChannel(id, { autoReload: e.target.checked }) }),
        ]),
        el('td', {}, [
          el('input', {
            type: 'text',
            value: (c.keywords || []).join(', '),
            placeholder: '예: 롤, 합방',
            onchange: (e) =>
              upsertChannel(id, {
                keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              }),
          }),
        ]),
        el('td', {}, [
          el('button', {
            type: 'button',
            class: 'danger',
            text: '삭제',
            onclick: async () => {
              if (!confirm(`${c.name || id} 채널을 삭제할까요?`)) return;
              await removeChannel(id);
              await setMockStatus(id, null);
            },
          }),
        ]),
      ]);
    }),
  );
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-msg');
  const input = $('add-input');
  const id = extractChannelId(input.value);
  if (!id) return showMsg(msg, '채널 ID를 찾을 수 없습니다. 치지직 채널/라이브 URL 또는 32자리 채널 ID를 입력하세요.', true);

  const channels = await getChannels();
  if (channels[id]) return showMsg(msg, `이미 등록된 채널입니다: ${channels[id].name || id}`, true);

  showMsg(msg, '채널 정보 조회 중…');
  let info;
  try {
    info = await fetchChannelInfo(id);
  } catch (err) {
    return showMsg(msg, `채널 정보 조회 실패: ${err.message}`, true);
  }
  if (!info) return showMsg(msg, '존재하지 않는 채널입니다.', true);

  await upsertChannel(id, { ...info, source: 'manual' });
  input.value = '';
  showMsg(msg, `추가됨: ${info.name}`);
  chrome.runtime.sendMessage({ type: 'pollNow' }).catch(() => {});
});

// ---- 설정 ----
const form = $('settings-form');

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

async function renderSettings() {
  const s = await getSettings();
  for (const input of form.querySelectorAll('input[name]')) {
    const v = getPath(s, input.name);
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v ?? '';
  }
  $('debug-mode').checked = s.debugMode;
  $('debug-panel').hidden = !s.debugMode;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = { quietHours: {} };
  for (const input of form.querySelectorAll('input[name]')) {
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    const [a, b] = input.name.split('.');
    if (b) patch[a][b] = value;
    else patch[a] = value;
  }
  await saveSettings(patch);
  await renderSettings();
  const msg = $('settings-msg');
  showMsg(msg, '저장됨. 다음 주기부터 반영됩니다.');
  setTimeout(() => showMsg(msg, ''), 2500);
});

$('debug-mode').addEventListener('change', async (e) => {
  await saveSettings({ debugMode: e.target.checked });
  await renderSettings();
  await renderMock();
});

$('test-notify').addEventListener('click', () => {
  chrome.notifications.create(`test|${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '치지직 라이브 알림 테스트',
    message: '이 알림이 보이면 Windows 알림 설정이 정상입니다.',
    priority: 2,
  });
});

// ---- 디버그: 모의 상태 ----
async function renderMock() {
  const [channels, mock, settings] = await Promise.all([getChannels(), getMockStatus(), getSettings()]);
  if (!settings.debugMode) return;
  const set = async (id, value) => {
    await setMockStatus(id, value);
    await renderMock();
  };
  $('mock-rows').replaceChildren(
    ...Object.keys(channels).map((id) => {
      const m = mock[id];
      const label = !m ? 'CLOSE(기본)' : `${m.status}${m.openDate ? ` · open ${m.openDate}` : ''}${m.fail ? ' · 조회 실패' : ''}`;
      return el('tr', {}, [
        el('td', { text: channels[id].name || id }),
        el('td', { text: label }),
        el('td', {}, [
          el('div', { class: 'mock-actions' }, [
            el('button', {
              type: 'button',
              text: 'OPEN (새 방송)',
              onclick: () =>
                set(id, { status: 'OPEN', openDate: formatKst(Date.now()), title: `모의 방송 ${formatKst(Date.now()).slice(11)}`, category: '테스트', viewers: 123 }),
            }),
            el('button', {
              type: 'button',
              text: 'CLOSE',
              onclick: () => set(id, { ...(m || {}), status: 'CLOSE', closeDate: formatKst(Date.now()), fail: false }),
            }),
            el('button', {
              type: 'button',
              text: m?.fail ? '실패 해제' : '조회 실패',
              onclick: () => set(id, { status: 'CLOSE', ...(m || {}), fail: !m?.fail }),
            }),
          ]),
        ]),
      ]);
    }),
  );
}

$('poll-now').addEventListener('click', async () => {
  const msg = $('poll-msg');
  showMsg(msg, '폴링 중…');
  const res = await chrome.runtime.sendMessage({ type: 'pollNow' });
  if (!res?.ok) return showMsg(msg, `실패: ${res?.error}`, true);
  const r = res.result;
  showMsg(
    msg,
    r.skipped
      ? '이전 주기가 진행 중이라 건너뜀'
      : `조회 ${r.checked} · 시작 ${r.wentLive} · 종료 ${r.wentOffline} · 실패 ${r.failed} · 새로고침 ${r.reloaded}`,
  );
});

// ---- 이벤트 로그 ----
const REASON_LABEL = {
  'went-live': '알림',
  startup: '알림(시작 시 진행 중)',
  'already-alerted': '생략: 이미 알림',
  'restart-grace': '생략: 재시작 유예',
  'startup-disabled': '생략: 시작 시 알림 꺼짐',
  'channel-off': '생략: 채널 알림 꺼짐',
  'keyword-filter': '생략: 키워드 불일치',
  'quiet-hours': '생략: 알림 금지 시간',
  'active-tab-reload': '생략: 보고 있는 탭 새로고침',
};

async function renderLog() {
  const [log, channels] = await Promise.all([getEventLog(), getChannels()]);
  const name = (e) => e.name || channels[e.channelId]?.name || e.channelId;
  $('event-log').replaceChildren(
    ...log.map((e) => {
      const t = new Date(e.at).toLocaleString('ko-KR');
      let text;
      if (e.type === 'went_live') text = `방송 시작 ${name(e)} — ${REASON_LABEL[e.reason] ?? e.reason} (open ${e.openDate})`;
      else if (e.type === 'went_offline') text = `방송 종료 ${name(e)}`;
      else if (e.type === 'reload') text = `새로고침 ${name(e)} 탭 #${e.tabId}`;
      else if (e.type === 'reload-failed') text = `새로고침 실패 ${name(e)} 탭 #${e.tabId}: ${e.error}`;
      else text = JSON.stringify(e);
      return el('li', { text: `${t}  ${text}` });
    }),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.channels || changes.channelState || changes.settings) renderChannels();
  if (changes.channels || changes.mockStatus) renderMock();
  if (changes.eventLog) renderLog();
});

renderChannels();
renderSettings().then(renderMock);
renderLog();
