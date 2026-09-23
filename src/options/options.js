import { buildBackup, parseBackup } from '../lib/backup.js';
import { extractChannelId } from '../lib/chzzkUrl.js';
import { mergeHistory } from '../lib/history.js';
import { fetchChannelInfo } from '../lib/statusProvider.js';
import {
  getAllChannelState,
  getChannelMute,
  getChannels,
  getEventLog,
  getHistory,
  getMockStatus,
  getSettings,
  removeChannel,
  saveChannels,
  saveSettings,
  setChannelMute,
  setMockStatus,
  updateHistory,
  upsertChannel,
} from '../lib/storage.js';
import { QUOTA_BYTES, QUOTA_BYTES_PER_ITEM } from '../lib/syncCodec.js';
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

  const [channels, states, settings, mute] = await Promise.all([getChannels(), getAllChannelState(), getSettings(), getChannelMute()]);
  const ids = Object.keys(channels);
  $('no-channels').hidden = ids.length > 0;
  $('channel-table').hidden = ids.length === 0;

  const toggle = (id, key, label) =>
    el('td', { 'data-label': label }, [
      el('input', { type: 'checkbox', title: label, checked: channels[id][key], onchange: (e) => upsertChannel(id, { [key]: e.target.checked }) }),
    ]);

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
        el('td', {}, [
          stateBadge(states[id], settings),
          (mute[id] ?? 0) > Date.now()
            ? el('span', {
                class: 'badge muted-today',
                text: '오늘 알림 끔 ✕',
                title: '클릭하면 다시 알림',
                onclick: async () => {
                  await setChannelMute(id, null);
                  renderChannels();
                },
              })
            : '',
        ]),
        toggle(id, 'notify', '알림'),
        toggle(id, 'autoReload', '새로고침'),
        toggle(id, 'openOnLive', '탭 열기'),
        toggle(id, 'notifyCategoryChange', '카테고리 변경'),
        el('td', { class: 'kw' }, [
          el('input', {
            type: 'text',
            value: (c.keywords || []).join(', '),
            placeholder: '키워드 예: 롤, 합방',
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

// ---- 동기화 ----
const formatKB = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;

async function renderSync() {
  const [settings, { syncStatus: st = { state: 'off' } }] = await Promise.all([getSettings(), chrome.storage.local.get('syncStatus')]);
  $('sync-enabled').checked = settings.syncEnabled;
  $('sync-now').disabled = !settings.syncEnabled;
  const msg = $('sync-status');
  msg.classList.toggle('warn', settings.syncEnabled && (st.state === 'quota' || st.state === 'error'));
  const when = st.at ? ` (${new Date(st.at).toLocaleString('ko-KR')})` : '';
  if (!settings.syncEnabled || st.state === 'off') {
    msg.textContent = '동기화 꺼짐. 아래 파일 백업을 사용하세요.';
  } else if (st.state === 'ok') {
    msg.textContent = `동기화됨 — 사용량 ${formatKB(st.totalBytes ?? 0)} / ${formatKB(QUOTA_BYTES)}, 항목 ${st.itemCount ?? 0}개${when}`;
  } else if (st.state === 'quota') {
    const why =
      st.reason === 'item'
        ? `항목 하나가 ${formatKB(QUOTA_BYTES_PER_ITEM)}를 넘습니다(키워드가 매우 긴 채널 등)`
        : st.reason === 'items'
          ? '항목 수 제한(512개)을 넘습니다'
          : `저장 용량(${formatKB(QUOTA_BYTES)})의 90%를 넘습니다(현재 약 ${formatKB(st.totalBytes ?? 0)})`;
    msg.textContent =
      `⚠ 구글 계정 동기화 용량 초과: ${why}. 이 기기의 변경은 동기화되지 않고 있습니다. ` +
      `"파일로 내보내기"로 백업한 뒤 다른 기기에서 "파일에서 가져오기"를 사용하거나, 채널·키워드를 줄이고 "지금 동기화"를 누르세요.${when}`;
  } else {
    msg.textContent = `⚠ 동기화 오류: ${st.error ?? '알 수 없음'}. 파일 백업을 사용하거나 "지금 동기화"로 다시 시도하세요.${when}`;
  }
}

$('sync-enabled').addEventListener('change', async (e) => {
  await saveSettings({ syncEnabled: e.target.checked });
  renderSync();
});

$('sync-now').addEventListener('click', async () => {
  // 실패 상태면 이 기기 값을 다시 올리고, 정상이면 원격 변경을 반영한다.
  const res = await chrome.runtime.sendMessage({ type: 'syncNow' });
  if (!res?.ok) showMsg($('sync-status'), `실패: ${res?.error}`, true);
  renderSync();
});

// ---- 파일 백업 ----
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('export').addEventListener('click', async () => {
  const withHistory = $('export-history').checked;
  const [channels, settings, history] = await Promise.all([getChannels(), getSettings(), withHistory ? getHistory() : null]);
  const data = buildBackup({ channels, settings, history, appVersion: chrome.runtime.getManifest().version });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`chzzk-alarm-backup-${stamp}.json`, JSON.stringify(data, null, 2));
  showMsg($('backup-msg'), `내보냄: 채널 ${data.channels.length}개${history ? `, 방송 기록 ${history.length}건` : ''}`);
});

$('import').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const msg = $('backup-msg');
  let data;
  try {
    data = parseBackup(await file.text());
  } catch (err) {
    return showMsg(msg, `가져오기 실패: ${err.message}`, true);
  }
  const replace = $('import-replace').checked;
  const count = Object.keys(data.channels).length;
  const question = replace
    ? `기존 채널을 모두 지우고 채널 ${count}개로 바꿉니다. 설정도 파일 값으로 바뀝니다. 계속할까요?`
    : `채널 ${count}개를 합칩니다(같은 채널은 파일 값으로 덮어씀). 설정도 파일 값으로 바뀝니다. 계속할까요?`;
  if (!confirm(question)) return;

  const current = await getChannels();
  await saveChannels(replace ? data.channels : { ...current, ...data.channels });
  if (data.settings) {
    const { debugMode: _d, syncEnabled: _s, ...rest } = data.settings;
    await saveSettings(rest);
  }
  if (data.history) await updateHistory((h) => mergeHistory(h, data.history));
  await renderSettings();
  showMsg(msg, `가져옴: 채널 ${count}개${data.history ? `, 방송 기록 ${data.history.length}건 병합` : ''}`);
  chrome.runtime.sendMessage({ type: 'pollNow' }).catch(() => {});
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
      const label = !m
        ? 'CLOSE(기본)'
        : `${m.status}${m.openDate ? ` · open ${m.openDate}` : ''}${m.category ? ` · ${m.category}` : ''}${m.fail ? ' · 조회 실패' : ''}`;
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
              text: '카테고리 변경',
              disabled: m?.status !== 'OPEN',
              onclick: () => set(id, { ...m, category: m.category === '테스트' ? '다른 게임' : '테스트', viewers: (m.viewers ?? 0) + 50 }),
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
      : `조회 ${r.checked} · 시작 ${r.wentLive} · 변경 ${r.changed} · 종료 ${r.wentOffline} · 실패 ${r.failed} · 새로고침 ${r.reloaded} · 탭 열기/포커스 ${r.opened}`,
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
  'muted-today': '생략: 오늘 알림 끔',
  'keyword-filter': '생략: 키워드 불일치',
  'quiet-hours': '생략: 알림 금지 시간',
  'active-tab-reload': '생략: 보고 있는 탭 새로고침',
  cooldown: '생략: 변경 알림 간격',
  'keyword-matched': '알림: 키워드 일치',
  'category-changed': '알림: 카테고리 변경',
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
      else if (e.type === 'live_changed')
        text = `방송 중 변경 ${name(e)} — ${e.categoryTo ? `${e.categoryFrom} → ${e.categoryTo}` : '키워드 일치'} (${REASON_LABEL[e.reason] ?? e.reason})`;
      else if (e.type === 'reload') text = `새로고침 ${name(e)} 탭 #${e.tabId}${e.muted ? ' (음소거)' : ''}`;
      else if (e.type === 'reload-failed') text = `새로고침 실패 ${name(e)} 탭 #${e.tabId}: ${e.error}`;
      else if (e.type === 'focus') text = `탭 포커스 ${name(e)} 탭 #${e.tabId}`;
      else if (e.type === 'open') text = `새 탭 열기 ${name(e)} 탭 #${e.tabId}${e.focused ? '' : ' (백그라운드)'}${e.muted ? ' (음소거)' : ''}`;
      else if (e.type === 'open-failed') text = `탭 열기 실패 ${name(e)}: ${e.error}`;
      else if (e.type === 'reminder') text = `다시 알림 ${name(e)}`;
      else text = JSON.stringify(e);
      return el('li', { text: `${t}  ${text}` });
    }),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.channels || changes.channelState || changes.settings || changes.channelMute) renderChannels();
  if (changes.channels || changes.mockStatus) renderMock();
  if (changes.syncStatus || changes.settings) renderSync();
  if (changes.eventLog) renderLog();
});

renderChannels();
renderSettings().then(renderMock);
renderLog();
renderSync();
