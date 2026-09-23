// 방송 기록·통계 페이지. 차트는 외부 라이브러리 없이 SVG로 그린다(확장 CSP상 원격 스크립트 불가).
// 모든 차트는 단일 계열: 막대·선은 --series-1, 히트맵은 한 색상 순차 단계(--seq-*).

import { getChannels, getHistory } from '../lib/storage.js';
import {
  WEEKDAYS,
  categoryHours,
  filterRecords,
  formatMinute,
  periodStart,
  spanOf,
  startHeatmap,
  summarizeRecords,
  weeklyTotals,
} from '../lib/stats.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const PAGE_SIZE = 30;

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

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

const nf = new Intl.NumberFormat('ko-KR');
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });

function formatDuration(ms) {
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

const formatHours = (h) => (h >= 10 ? `${Math.round(h)}시간` : `${h.toFixed(1)}시간`);

function formatDate(ms, withTime = true) {
  const d = new Date(ms);
  const date = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[(d.getDay() + 6) % 7]})`;
  return withTime ? `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : date;
}

/** 0부터 max를 덮는 깔끔한 눈금(1·2·5 단위). */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
  return ticks;
}

/** 위쪽만 둥근 세로 막대(바닥은 기준선에 각지게 붙음). */
function columnPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** 오른쪽 끝만 둥근 가로 막대. */
function barPath(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

// ---- 툴팁 ----
const tooltip = $('tooltip');
function showTip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 12;
  const { innerWidth: vw, innerHeight: vh } = window;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > vw - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > vh - 8) y = evt.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => {
  tooltip.hidden = true;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function emptyChart(container, text) {
  container.replaceChildren(el('p', { class: 'sub', text }));
}

// ---- 히트맵: 요일 × 시간 ----
function drawHeatmap(container, grid) {
  const width = container.clientWidth || 600;
  const labelW = 26;
  const topH = 16;
  const cell = Math.max(10, Math.min(28, (width - labelW) / 24));
  const w = labelW + cell * 24;
  const h = topH + cell * 7;
  const max = Math.max(0, ...grid.flat());
  if (max === 0) return emptyChart(container, '기록이 없습니다.');

  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '요일·시간대별 방송 시작 횟수 히트맵' });
  const step = (v) => (v === 0 ? 0 : Math.max(1, Math.ceil((v / max) * 7)));
  for (let hr = 0; hr < 24; hr += cell < 18 ? 3 : 2) {
    svg.append(svgEl('text', { x: labelW + hr * cell + cell / 2, y: 11, 'text-anchor': 'middle' }, String(hr)));
  }
  grid.forEach((row, d) => {
    svg.append(svgEl('text', { x: 0, y: topH + d * cell + cell / 2 + 4 }, WEEKDAYS[d]));
    row.forEach((v, hr) => {
      const rect = svgEl('rect', {
        class: 'cell',
        x: labelW + hr * cell,
        y: topH + d * cell,
        width: cell,
        height: cell,
        rx: 3,
        fill: `var(--seq-${step(v)})`,
      });
      rect.addEventListener('mousemove', (e) => {
        rect.classList.add('hover');
        showTip(e, `<b>${WEEKDAYS[d]}요일 ${hr}시대</b><br><span class="t-sub">방송 시작 ${v}회</span>`);
      });
      rect.addEventListener('mouseleave', () => {
        rect.classList.remove('hover');
        hideTip();
      });
      svg.append(rect);
    });
  });

  const legend = el('div', { class: 'legend' }, [el('span', { text: '적음' })]);
  for (let i = 0; i <= 7; i++) legend.append(el('span', { class: 'swatch', style: `background: var(--seq-${i})` }));
  legend.append(el('span', { text: `많음 (최대 ${max}회)` }));
  container.replaceChildren(svg, legend);
}

// ---- 세로 막대: 주별 방송 시간 ----
function drawWeekly(container, weeks) {
  const width = container.clientWidth || 600;
  const height = 220;
  const m = { top: 20, right: 8, bottom: 26, left: 36 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const max = Math.max(0, ...weeks.map((w) => w.hours));
  if (max === 0) return emptyChart(container, '최근 12주 동안 기록이 없습니다.');
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const y = (v) => m.top + ph - (v / top) * ph;
  const band = pw / weeks.length;
  const barW = Math.min(24, band * 0.6);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '주별 방송 시간 막대 차트' });
  for (const t of ticks) {
    svg.append(svgEl('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }));
    svg.append(svgEl('text', { x: m.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, `${nf.format(t)}`));
  }

  const labelEvery = band < 40 ? 2 : 1;
  const peakIdx = weeks.reduce((best, w, i) => (w.hours > weeks[best].hours ? i : best), 0);
  weeks.forEach((wk, i) => {
    const cx = m.left + band * i + band / 2;
    const bar = svgEl('path', { class: 'bar', d: columnPath(cx - barW / 2, y(wk.hours), barW, y(0) - y(wk.hours)) });
    const hit = svgEl('rect', { class: 'hit', x: m.left + band * i, y: m.top, width: band, height: ph });
    hit.addEventListener('mousemove', (e) => {
      bar.classList.add('hover');
      showTip(e, `<b>${formatDate(wk.weekStart, false)} 주</b><br>${formatHours(wk.hours)} · 방송 ${wk.count}회`);
    });
    hit.addEventListener('mouseleave', () => {
      bar.classList.remove('hover');
      hideTip();
    });
    svg.append(bar, hit);
    if (i % labelEvery === (weeks.length - 1) % labelEvery) {
      const d = new Date(wk.weekStart);
      svg.append(svgEl('text', { x: cx, y: height - 8, 'text-anchor': 'middle' }, `${d.getMonth() + 1}/${d.getDate()}`));
    }
    if (i === peakIdx && wk.hours > 0) {
      svg.append(svgEl('text', { class: 'value-label', x: cx, y: y(wk.hours) - 6, 'text-anchor': 'middle' }, formatHours(wk.hours)));
    }
  });
  container.replaceChildren(svg);
}

// ---- 가로 막대: 카테고리별 시간 ----
function drawCategories(container, cats) {
  if (cats.length === 0) return emptyChart(container, '기록이 없습니다.');
  const width = container.clientWidth || 400;
  const rowH = 28;
  const barH = Math.min(18, rowH - 8);
  const labelW = Math.min(130, width * 0.35);
  const valueW = 64;
  const pw = Math.max(40, width - labelW - valueW);
  const height = cats.length * rowH;
  const max = Math.max(...cats.map((c) => c.hours));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '카테고리별 방송 시간 막대 차트' });
  cats.forEach((c, i) => {
    const yy = i * rowH;
    const name = c.name.length > 12 ? `${c.name.slice(0, 11)}…` : c.name;
    svg.append(svgEl('text', { x: labelW - 8, y: yy + rowH / 2 + 4, 'text-anchor': 'end' }, name));
    const w = (c.hours / max) * pw;
    const bar = svgEl('path', { class: 'bar', d: barPath(labelW, yy + (rowH - barH) / 2, Math.max(2, w), barH) });
    svg.append(bar);
    svg.append(svgEl('text', { x: labelW + w + 6, y: yy + rowH / 2 + 4 }, formatHours(c.hours)));
    const hit = svgEl('rect', { class: 'hit', x: 0, y: yy, width, height: rowH });
    hit.addEventListener('mousemove', (e) => {
      bar.classList.add('hover');
      showTip(e, `<b>${esc(c.name)}</b><br>${formatHours(c.hours)}`);
    });
    hit.addEventListener('mouseleave', () => {
      bar.classList.remove('hover');
      hideTip();
    });
    svg.append(hit);
  });
  container.replaceChildren(svg);
}

// ---- 선: 방송별 최고 시청자 ----
function drawViewers(container, records, channels) {
  const points = records
    .filter((r) => r.viewerSamples > 0)
    .map((r) => ({ r, start: spanOf(r).start }))
    .sort((a, b) => a.start - b.start)
    .slice(-30);
  if (points.length < 2) return emptyChart(container, '시청자 수를 관측한 방송이 2회 이상 필요합니다.');

  const width = container.clientWidth || 400;
  const height = 200;
  const m = { top: 16, right: 16, bottom: 24, left: 44 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const ticks = niceTicks(Math.max(...points.map((p) => p.r.peakViewers)));
  const top = ticks[ticks.length - 1];
  const x = (i) => m.left + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const y = (v) => m.top + ph - (v / top) * ph;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '방송별 최고 시청자 선 차트' });
  for (const t of ticks) {
    svg.append(svgEl('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }));
    svg.append(svgEl('text', { x: m.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, compact.format(t)));
  }
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.r.peakViewers)}`).join('');
  svg.append(svgEl('path', { class: 'area', d: `${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }));
  svg.append(svgEl('path', { class: 'line', d }));
  svg.append(svgEl('text', { x: x(0), y: height - 6, 'text-anchor': 'start' }, formatDate(points[0].start, false)));
  svg.append(svgEl('text', { x: x(points.length - 1), y: height - 6, 'text-anchor': 'end' }, formatDate(points[points.length - 1].start, false)));

  // 끝점 표시 + 값 라벨(선택적 라벨: 마지막 방송만)
  const last = points[points.length - 1];
  svg.append(svgEl('circle', { class: 'dot', cx: x(points.length - 1), cy: y(last.r.peakViewers), r: 4 }));

  // 십자선 + 툴팁
  const cross = svgEl('line', { class: 'axis-line', y1: m.top, y2: m.top + ph, visibility: 'hidden' });
  const focus = svgEl('circle', { class: 'dot', r: 5, visibility: 'hidden' });
  const hit = svgEl('rect', { class: 'hit', x: m.left, y: m.top, width: pw, height: ph });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - m.left) / pw) * (points.length - 1))));
    const p = points[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    focus.setAttribute('cx', x(i));
    focus.setAttribute('cy', y(p.r.peakViewers));
    cross.setAttribute('visibility', 'visible');
    focus.setAttribute('visibility', 'visible');
    const name = channels[p.r.channelId]?.name || p.r.name || p.r.channelId;
    showTip(e, `<b>${esc(name)}</b> · ${formatDate(p.start)}<br>최고 ${nf.format(p.r.peakViewers)}명<br><span class="t-sub">${esc(p.r.title || '')}</span>`);
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    focus.setAttribute('visibility', 'hidden');
    hideTip();
  });
  svg.append(cross, focus, hit);
  container.replaceChildren(svg);
}

// ---- 요약 타일 ----
function renderTiles(summary, singleChannel) {
  // 여러 채널의 시작 시각을 섞은 평균은 의미가 없으므로 채널을 골랐을 때만 표시.
  const typical = singleChannel ? summary.typical : null;
  const typicalText = typical ? formatMinute(typical.minute) : '—';
  const typicalHint = !singleChannel
    ? '채널을 선택하면 표시'
    : !typical
      ? ''
      : typical.concentration >= 0.8
        ? '거의 일정'
        : typical.concentration >= 0.6
          ? '대체로 일정'
          : '들쭉날쭉';
  const tiles = [
    ['방송 횟수', `${nf.format(summary.count)}회`, ''],
    ['총 방송 시간', formatHours(summary.totalMs / 3_600_000), ''],
    ['평균 방송 길이', summary.count ? formatDuration(summary.avgMs) : '—', ''],
    ['보통 시작 시각', typicalText, typicalHint],
    ['최고 시청자', summary.peakViewers ? `${compact.format(summary.peakViewers)}명` : '—', summary.avgViewers ? `방송 평균 ${compact.format(Math.round(summary.avgViewers))}명` : ''],
  ];
  $('tiles').replaceChildren(
    ...tiles.map(([label, value, hint]) =>
      el('div', { class: 'tile' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), el('div', { class: 'hint', text: hint })]),
    ),
  );
}

// ---- 방송 목록(표 보기) ----
let tableLimit = PAGE_SIZE;
function renderTable(records, channels) {
  const sorted = records.map((r) => ({ r, span: spanOf(r) })).sort((a, b) => b.span.start - a.span.start);
  $('rows').replaceChildren(
    ...sorted.slice(0, tableLimit).map(({ r, span }) => {
      const live = !r.closeDate && r.observed && Date.now() - (r.lastSeenAt ?? 0) < 5 * 60_000;
      return el('tr', {}, [
        el('td', { text: formatDate(span.start) }),
        el('td', { text: channels[r.channelId]?.name || r.name || r.channelId }),
        el('td', { text: live ? `${formatDuration(span.end - span.start)} (진행 중)` : formatDuration(span.end - span.start) }),
        el('td', { text: (r.categories || []).join(', ') || '—' }),
        el('td', { class: 'title', text: r.title || '' }),
        el('td', { class: 'num', text: r.viewerSamples ? nf.format(r.peakViewers) : '—' }),
      ]);
    }),
  );
  $('more').hidden = sorted.length <= tableLimit;
}

// ---- 조립 ----
let data = { history: [], channels: {} };

function currentFilter() {
  const days = Number($('f-period').value);
  return { channelId: $('f-channel').value || null, sinceMs: periodStart(Date.now(), days) };
}

function render() {
  const { history, channels } = data;
  const filter = currentFilter();
  const records = filterRecords(history, filter);
  const summary = summarizeRecords(records);
  renderTiles(summary, !!filter.channelId);
  const empty = records.length === 0;
  $('empty').hidden = !empty;
  $('charts').hidden = empty;
  if (empty) return;
  drawHeatmap($('c-heatmap'), startHeatmap(records));
  // 주별 차트는 기간 필터와 무관하게 최근 12주(채널 필터만 적용)
  drawWeekly($('c-weekly'), weeklyTotals(filterRecords(history, { channelId: filter.channelId }), Date.now(), 12));
  drawCategories($('c-category'), categoryHours(records));
  drawViewers($('c-viewers'), records, channels);
  renderTable(records, channels);
}

function fillChannelSelect() {
  const select = $('f-channel');
  const prev = select.value;
  const names = new Map();
  for (const r of data.history) names.set(r.channelId, r.name || r.channelId);
  for (const [id, c] of Object.entries(data.channels)) names.set(id, c.name || id);
  const options = [el('option', { value: '', text: '전체 채널' })];
  for (const [id, name] of [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko'))) {
    options.push(el('option', { value: id, text: data.channels[id] ? name : `${name} (삭제됨)` }));
  }
  select.replaceChildren(...options);
  select.value = names.has(prev) ? prev : '';
}

async function load() {
  const [history, channels] = await Promise.all([getHistory(), getChannels()]);
  data = { history, channels };
  fillChannelSelect();
  const fromQuery = new URLSearchParams(location.search).get('channel');
  if (fromQuery && [...$('f-channel').options].some((o) => o.value === fromQuery)) $('f-channel').value = fromQuery;
  render();
}

$('f-channel').addEventListener('change', () => {
  tableLimit = PAGE_SIZE;
  render();
});
$('f-period').addEventListener('change', () => {
  tableLimit = PAGE_SIZE;
  render();
});
$('more').addEventListener('click', () => {
  tableLimit += PAGE_SIZE;
  renderTable(filterRecords(data.history, currentFilter()), data.channels);
});

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
}).observe(document.querySelector('main'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.history || changes.channels)) load();
});

load();
