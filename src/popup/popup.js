import { extractChannelId } from '../lib/chzzkUrl.js';
import { typicalStartLabel } from '../lib/stats.js';
import { fetchChannelInfo } from '../lib/statusProvider.js';
import { getAllChannelState, getChannels, getHistory, getMeta, getSettings, upsertChannel } from '../lib/storage.js';
import { formatElapsed, parseKst } from '../lib/time.js';

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function timeAgo(ms) {
  if (!ms) return '조회 기록 없음';
  const sec = Math.round((Date.now() - ms) / 1000);
  return sec < 60 ? `${sec}초 전 조회` : `${Math.round(sec / 60)}분 전 조회`;
}

function daysAgo(ms) {
  if (!ms) return null;
  const midnight = (t) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(Date.now()) - midnight(ms)) / 86_400_000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  return `${days}일 전`;
}

const avatar = (c) => (c.imageUrl ? el('img', { src: c.imageUrl, alt: '' }) : el('div', { class: 'noimg' }));

async function openLive(id) {
  await chrome.runtime.sendMessage({ type: 'openLive', channelId: id });
  window.close();
}

async function render() {
  const [channels, states, meta, settings, history] = await Promise.all([
    getChannels(),
    getAllChannelState(),
    getMeta(),
    getSettings(),
    getHistory(),
  ]);
  const ids = Object.keys(channels);
  const live = ids
    .filter((id) => states[id]?.status === 'OPEN')
    .sort((a, b) => (parseKst(states[b].openDate) ?? 0) - (parseKst(states[a].openDate) ?? 0));
  const offline = ids.filter((id) => states[id]?.status !== 'OPEN');
  const failing = ids.filter((id) => (states[id]?.failCount ?? 0) >= settings.failWarnThreshold);

  $('live-count').textContent = String(live.length);
  $('debug').hidden = !settings.debugMode;

  const warn = $('warning');
  warn.hidden = failing.length === 0;
  warn.textContent = failing.length
    ? `⚠ 상태 조회 연속 실패로 감지가 멈췄을 수 있음: ${failing.map((id) => channels[id].name || id).join(', ')}`
    : '';

  $('live-list').replaceChildren(
    ...live.map((id) => {
      const c = channels[id];
      const s = states[id];
      const item = el('li', { title: s.title || '' }, [
        avatar(c),
        el('div', {}, [
          el('div', { class: 'name' }, [
            el('span', { text: c.name || id }),
            el('span', { class: 'elapsed', 'data-open': String(parseKst(s.openDate) ?? '') }),
          ]),
          el('div', { class: 'title', text: s.title || '(제목 없음)' }),
          el('div', { class: 'meta', text: `${s.category || '카테고리 없음'} · 시청자 ${Number(s.viewers || 0).toLocaleString('ko-KR')}명` }),
        ]),
      ]);
      item.addEventListener('click', () => openLive(id));
      return item;
    }),
  );

  const empty = $('empty');
  empty.hidden = live.length > 0;
  empty.textContent = ids.length === 0 ? '등록된 채널이 없습니다. ⚙ 설정에서 채널을 추가하세요.' : '지금 라이브 중인 채널이 없습니다.';

  // 오프라인 채널: 평소 시작 시각·마지막 방송
  const offlineBox = $('offline');
  offlineBox.hidden = offline.length === 0;
  $('offline-summary').textContent = `오프라인 ${offline.length}개`;
  $('offline-list').replaceChildren(
    ...offline.map((id) => {
      const c = channels[id];
      const s = states[id];
      const typical = typicalStartLabel(history, id);
      const last = daysAgo(parseKst(s?.closeDate) ?? parseKst(s?.openDate));
      const sub = [typical && `보통 ${typical} 시작`, last && `마지막 방송 ${last}`].filter(Boolean).join(' · ') || '기록 없음';
      const item = el('li', { title: '채널 라이브 페이지 열기' }, [
        avatar(c),
        el('div', {}, [el('div', { text: c.name || id }), el('div', { class: 'sub', text: sub })]),
      ]);
      item.addEventListener('click', () => openLive(id));
      return item;
    }),
  );

  $('last-poll').textContent = timeAgo(meta.lastPollAt);
  tick();
}

function tick() {
  const now = Date.now();
  for (const node of document.querySelectorAll('.elapsed')) {
    const open = Number(node.dataset.open);
    node.textContent = open ? formatElapsed(now - open) : '';
  }
}

// 현재 탭이 치지직 채널이면 "이 채널 등록" 제안.
async function renderCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  if (!/^https:\/\/chzzk\.naver\.com\//.test(url)) return;
  const id = extractChannelId(url);
  if (!id) return;
  const channels = await getChannels();
  if (channels[id]) return;

  const box = $('current');
  const text = $('current-text');
  const btn = $('current-add');
  box.hidden = false;
  text.textContent = '현재 탭 채널 확인 중…';
  btn.disabled = true;
  let info = null;
  try {
    info = await fetchChannelInfo(id);
  } catch {
    // 아래에서 처리
  }
  if (!info) {
    text.textContent = '현재 탭의 채널 정보를 가져오지 못했습니다.';
    btn.hidden = true;
    return;
  }
  text.textContent = `현재 탭: ${info.name}`;
  btn.disabled = false;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await upsertChannel(id, { ...info, source: 'manual' });
    text.textContent = `등록됨: ${info.name}`;
    btn.hidden = true;
    chrome.runtime.sendMessage({ type: 'pollNow' }).catch(() => {});
  });
}

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('stats').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') });
  window.close();
});
$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'pollNow' });
  } finally {
    btn.disabled = false;
    render();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.channelState || changes.channels || changes.meta || changes.settings || changes.history)) render();
});

setInterval(tick, 1000);
render();
renderCurrentTab();
