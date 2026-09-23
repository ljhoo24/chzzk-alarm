import { getAllChannelState, getChannels, getMeta, getSettings } from '../lib/storage.js';
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

async function render() {
  const [channels, states, meta, settings] = await Promise.all([getChannels(), getAllChannelState(), getMeta(), getSettings()]);
  const ids = Object.keys(channels);
  const live = ids
    .filter((id) => states[id]?.status === 'OPEN')
    .sort((a, b) => (parseKst(states[b].openDate) ?? 0) - (parseKst(states[a].openDate) ?? 0));
  const failing = ids.filter((id) => (states[id]?.failCount ?? 0) >= settings.failWarnThreshold);

  $('live-count').textContent = String(live.length);
  $('debug').hidden = !settings.debugMode;

  const warn = $('warning');
  warn.hidden = failing.length === 0;
  warn.textContent = failing.length
    ? `⚠ 상태 조회 연속 실패로 감지가 멈췄을 수 있음: ${failing.map((id) => channels[id].name || id).join(', ')}`
    : '';

  const list = $('live-list');
  list.replaceChildren(
    ...live.map((id) => {
      const c = channels[id];
      const s = states[id];
      const avatar = c.imageUrl ? el('img', { src: c.imageUrl, alt: '' }) : el('div', { class: 'noimg' });
      const item = el('li', { title: s.title || '' }, [
        avatar,
        el('div', {}, [
          el('div', { class: 'name' }, [
            el('span', { text: c.name || id }),
            el('span', { class: 'elapsed', 'data-open': String(parseKst(s.openDate) ?? '') }),
          ]),
          el('div', { class: 'title', text: s.title || '(제목 없음)' }),
          el('div', { class: 'meta', text: `${s.category || '카테고리 없음'} · 시청자 ${Number(s.viewers || 0).toLocaleString('ko-KR')}명` }),
        ]),
      ]);
      item.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'openLive', channelId: id });
        window.close();
      });
      return item;
    }),
  );

  const empty = $('empty');
  empty.hidden = live.length > 0;
  empty.textContent = ids.length === 0 ? '등록된 채널이 없습니다. ⚙ 설정에서 채널을 추가하세요.' : '지금 라이브 중인 채널이 없습니다.';

  $('offline-count').textContent = ids.length ? `오프라인 ${ids.length - live.length}개` : '';
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

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
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
  if (area === 'local' && (changes.channelState || changes.channels || changes.meta || changes.settings)) render();
});

setInterval(tick, 1000);
render();
