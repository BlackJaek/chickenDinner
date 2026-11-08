import { fmtDate, todayKST, daysBetween } from './lib/dates.js';
import { parseCaption, CATEGORIES, normalizeHandle } from './lib/parser.js';
import { toICS } from './lib/ics.js';

// ---------- 상태 ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사파리 사생활 보호 모드 등 */ } },
};
const state = {
  view: 'ongoing',
  date: '',           // 비어 있으면 오늘(서버 기준)
  q: '',
  category: '',
  onlyWatch: false,
  showEnded: false,
  watch: new Set(store.get('watch', [])),
  meta: null,
};
const $ = (s, el = document) => el.querySelector(s);

// ---------- 유틸 ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
/** 태그드 템플릿: ${}는 자동 이스케이프, raw()로 감싼 값만 그대로 */
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: s });
function html(strings, ...vals) {
  return raw(strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    const str = Array.isArray(v) ? v.map((x) => (x?.[RAW] ?? esc(x))).join('') : v?.[RAW] ?? (v === false || v == null ? '' : esc(v));
    return out + str + s;
  }, ''));
}
const won = (n) => (n == null ? '' : n.toLocaleString('ko-KR') + '원');
const igProfile = (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'content-type': 'application/json' } : {}) };
  const token = store.get('adminToken', '');
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '요청에 실패했어요.'), { data, status: res.status });
  return data;
}

function query(extra = {}) {
  const p = new URLSearchParams();
  if (state.date) p.set('date', state.date);
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.onlyWatch) p.set('handles', [...state.watch].join(',') || '-');
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
}

const today = () => state.date || state.meta?.today || todayKST();

// ---------- 공통 조각 ----------
function statusBadge(d) {
  if (d.status === 'ongoing') {
    if (d.dday === 0) return html`<span class="badge b-hot">오늘 마감</span>`;
    if (d.dday == null) return html`<span class="badge b-ongoing">공구중 · 마감 미정</span>`;
    return html`<span class="badge b-ongoing">공구중 · D-${d.dday}</span>`;
  }
  if (d.status === 'upcoming') {
    return d.dday === 1 ? html`<span class="badge b-upcoming">내일 오픈</span>` : html`<span class="badge b-upcoming">${d.dday}일 후 오픈</span>`;
  }
  return html`<span class="badge b-ended">종료</span>`;
}

function period(d) {
  return `${fmtDate(d.start_date)} ~ ${d.end_date ? fmtDate(d.end_date) : '마감 미정'}`;
}

function priceHtml(d) {
  if (d.price == null) return '';
  const off = d.original_price ? Math.round((1 - d.price / d.original_price) * 100) : 0;
  return html`<span class="price">${off > 0 ? html`<span class="off">${off}%</span>` : ''}${won(d.price)}${d.original_price ? html`<s>${won(d.original_price)}</s>` : ''}</span>`;
}

function starBtn(handle) {
  const on = state.watch.has(handle);
  return html`<button type="button" class="star ${on ? 'on' : ''}" data-star="${handle}" aria-pressed="${on}" title="${on ? '관심 계정 해제' : '관심 계정 추가'}">★</button>`;
}

function handleLink(h) {
  return html`<a class="handle" href="${igProfile(h)}" target="_blank" rel="noopener">@${h}</a>`;
}

function dealActions(d, { admin = false } = {}) {
  return html`<div class="actions">
    ${d.post_url ? html`<a class="btn primary" href="${d.post_url}" target="_blank" rel="noopener">공구 게시물 보기</a>` : html`<a class="btn primary" href="${igProfile(d.handle)}" target="_blank" rel="noopener">계정 보러가기</a>`}
    ${d.status !== 'ended' ? html`<button type="button" class="btn" data-ics="${d.id}">📅 캘린더</button>` : ''}
    <a class="btn ghost" href="#/products/${encodeURIComponent(d.product_key)}">같은 제품 공구</a>
    ${admin ? html`<button type="button" class="btn ghost danger" data-del="${d.id}">삭제</button>` : ''}
  </div>`;
}

function dealCard(d, opts = {}) {
  return html`<article class="card st-${d.status}">
    <div class="row between">
      <div class="row">${starBtn(d.handle)}${handleLink(d.handle)}</div>
      ${statusBadge(d)}
    </div>
    <h3 class="prod">${d.brand ? html`<span class="brand">${d.brand}</span>` : ''}${d.product_name}</h3>
    <div class="row between">
      <span class="meta">${period(d)}</span>
      ${priceHtml(d)}
    </div>
    <div class="row"><span class="badge b-cat">${d.category}</span>${d.source === 'instagram' ? html`<span class="badge b-cat">자동 수집</span>` : ''}</div>
    ${d.note ? html`<div class="note">${d.note}</div>` : ''}
    ${dealActions(d, opts)}
  </article>`;
}

function emptyState(msg) {
  return html`<div class="empty"><p>${msg}</p><p class="hint">팔로우하는 인플루언서가 공구를 올렸다면 링크만 붙여넣어 제보해주세요.</p><a class="btn primary" href="#/submit">＋ 공구 제보하기</a></div>`;
}

// ---------- 뷰 ----------
let dealCache = new Map();
function remember(deals) { for (const d of deals) dealCache.set(String(d.id), d); }

async function viewList(status) {
  const { deals } = await api(`/api/deals?${query({ status })}`);
  remember(deals);
  if (!deals.length) return emptyState(status === 'ongoing' ? '조건에 맞는 진행중 공구가 없어요.' : '조건에 맞는 오픈 예정 공구가 없어요.');
  if (status === 'ongoing') {
    // 마감 임박 순
    deals.sort((a, b) => (a.dday ?? 99) - (b.dday ?? 99) || a.start_date.localeCompare(b.start_date));
    const soon = deals.filter((d) => d.dday != null && d.dday <= 1);
    const rest = deals.filter((d) => !(d.dday != null && d.dday <= 1));
    return html`
      ${soon.length ? html`<h2 class="section-title">⏰ 오늘·내일 마감 (${soon.length})</h2><div class="list cards">${soon.map((d) => dealCard(d))}</div>` : ''}
      ${rest.length ? html`<h2 class="section-title">진행중 (${rest.length})</h2><div class="list cards">${rest.map((d) => dealCard(d))}</div>` : ''}`;
  }
  // 오픈 예정: 날짜별로 묶기
  const byDate = Map.groupBy ? Map.groupBy(deals, (d) => d.start_date) : deals.reduce((m, d) => m.set(d.start_date, [...(m.get(d.start_date) || []), d]), new Map());
  return html`${[...byDate].map(([date, ds]) => html`
    <h2 class="section-title">${fmtDate(date)} 오픈 · ${daysBetween(today(), date)}일 후</h2>
    <div class="list cards">${ds.map((d) => dealCard(d))}</div>`)}`;
}

function timelineItem(d, by) {
  const who = by === 'product' ? html`${starBtn(d.handle)}${handleLink(d.handle)}` : html`<a href="#/products/${encodeURIComponent(d.product_key)}">${d.brand ? d.brand + ' ' : ''}${d.product_name}</a>`;
  return html`<li class="st-${d.status}">
    <div>
      <div class="row">${who}</div>
      <div class="when">${period(d)}${d.note ? ' · ' + d.note : ''}</div>
    </div>
    <div class="right">
      ${statusBadge(d)}
      <div>${d.price ? won(d.price) : ''}</div>
      ${d.post_url ? html`<a href="${d.post_url}" target="_blank" rel="noopener">게시물</a>` : ''}
    </div>
  </li>`;
}

function groupCard(g, by) {
  const ongoing = g.deals.filter((d) => d.status === 'ongoing');
  const upcoming = g.deals.filter((d) => d.status === 'upcoming');
  const ended = g.deals.filter((d) => d.status === 'ended');
  const shown = state.showEnded ? g.deals : g.deals.filter((d) => d.status !== 'ended').concat(ended.slice(-1));
  shown.sort((a, b) => a.start_date.localeCompare(b.start_date));
  const hiddenEnded = g.deals.length - shown.length;
  let summary;
  if (by === 'product') {
    const parts = [];
    if (ongoing.length) parts.push(html`지금 <b>${ongoing.map((d) => '@' + d.handle).join(', ')}</b> 공구중`);
    if (upcoming.length) parts.push(html`다음은 <b>@${upcoming[0].handle}</b> ${fmtDate(upcoming[0].start_date)} 오픈`);
    if (!parts.length) parts.push(html`최근 공구 ${fmtDate(ended.at(-1)?.end_date || ended.at(-1)?.start_date)} 종료`);
    summary = html`${parts.map((p, i) => html`${i ? ' → ' : ''}${p}`)}`;
  } else {
    summary = html`진행중 <b>${ongoing.length}</b> · 예정 <b>${upcoming.length}</b> · 지난 공구 ${ended.length}`;
  }
  const title = by === 'product'
    ? html`<h3><a href="#/products/${encodeURIComponent(g.key)}" style="text-decoration:none">${g.brand ? html`<span class="brand">${g.brand}</span>` : ''}${g.title}</a></h3>`
    : html`<h3 class="row">${starBtn(g.key)}${handleLink(g.key)}</h3>`;
  return html`<article class="card">
    <div class="group-head">
      <div>${title}<div class="summary">${summary}</div></div>
      <div class="row" style="justify-content:flex-end">
        ${g.min_active_price ? html`<span class="price">${won(g.min_active_price)}~</span>` : ''}
        ${by === 'product' ? html`<span class="badge b-cat">${g.category}</span>` : ''}
      </div>
    </div>
    <ol class="timeline">${shown.map((d) => timelineItem(d, by))}</ol>
    ${hiddenEnded > 0 ? html`<button type="button" class="more" data-show-ended>지난 공구 ${hiddenEnded}건 더 보기</button>` : ''}
  </article>`;
}

async function viewGroups(by, key) {
  const endpoint = by === 'product' ? '/api/products' : '/api/influencers';
  const extra = { status: state.showEnded || key ? 'all' : 'active' };
  if (key) extra[by === 'product' ? 'product' : 'handle'] = key;
  const { groups } = await api(`${endpoint}?${query(extra)}`);
  groups.forEach((g) => remember(g.deals));
  if (!groups.length) return emptyState(by === 'product' ? '조건에 맞는 제품이 없어요.' : '조건에 맞는 계정이 없어요.');
  const intro = by === 'product'
    ? '같은 제품을 여러 인플루언서가 이어서 공구하는 흐름을 한눈에 볼 수 있어요. 지금 놓쳤다면 다음 공구를 확인하세요.'
    : '인플루언서별로 진행중·예정 공구를 모았어요. ★를 눌러 관심 계정으로 저장하세요.';
  return html`${key ? html`<p><a href="#/${by === 'product' ? 'products' : 'accounts'}">← 전체 보기</a></p>` : html`<p class="hint">${intro}</p>`}
    <div class="list">${groups.map((g) => groupCard(g, by))}</div>`;
}

async function viewReview() {
  const { deals } = await api(`/api/deals?review=pending&status=all`);
  remember(deals);
  if (!deals.length) return html`<div class="empty">검토 대기 중인 제보가 없어요.</div>`;
  return html`<p class="hint">제보·자동 수집된 공구예요. 내용을 확인하고 게시해주세요.</p>
    <div class="list cards">${deals.map((d) => html`<div>${dealCard(d)}<div class="actions" style="margin-top:6px">
      <button type="button" class="btn primary" data-approve="${d.id}">게시</button>
      <button type="button" class="btn danger" data-del="${d.id}">삭제</button></div></div>`)}</div>`;
}

// ---------- 제보 폼 ----------
let suggestions = { products: [], handles: [] };
function viewSubmit() {
  const reviewNote = state.meta?.review_required && !state.meta?.is_admin ? ' 제보는 관리자 확인 후 게시돼요.' : '';
  return html`<form class="form" id="submit-form" novalidate>
    <h2>공구 제보하기</h2>
    <p class="help">인스타그램 공구 게시물의 링크와 본문을 붙여넣으면 날짜·가격·제품명을 자동으로 채워드려요.${reviewNote}</p>
    <div class="step">
      <h3>① 게시물 붙여넣기 <span class="hint">(선택)</span></h3>
      <label class="field"><span>게시물 링크</span>
        <input name="post_url" inputmode="url" placeholder="https://www.instagram.com/p/…" autocomplete="off"></label>
      <label class="field"><span>게시물 본문(캡션)</span>
        <textarea name="caption" placeholder="인스타 앱에서 게시물 본문을 길게 눌러 복사한 뒤 붙여넣어 주세요.&#10;예) [○○ 한우 큐브 이유식] 공구 오픈!&#10;11/10(월) 10시 ~ 11/14(금) 자정&#10;정가 39,000원 → 공구가 29,900원"></textarea></label>
      <div><button type="button" class="btn" id="autofill">✨ 본문으로 자동 채우기</button></div>
    </div>
    <div class="step">
      <h3>② 공구 정보 확인</h3>
      <label class="field"><span>인플루언서 계정 <i>*</i></span>
        <input name="handle" required placeholder="@계정아이디" list="dl-handles" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="mentions" id="mentions" hidden></div>
      <div class="grid2">
        <label class="field"><span>브랜드</span><input name="brand" placeholder="예) ○○베이비"></label>
        <label class="field"><span>카테고리</span><select name="category">${CATEGORIES.map((c) => html`<option>${c}</option>`)}</select></label>
      </div>
      <label class="field"><span>제품명 <i>*</i></span>
        <input name="product_name" required placeholder="예) 한우 큐브 이유식 (중기)" list="dl-products" autocomplete="off">
        <span class="hint">이미 등록된 제품과 같은 이름으로 고르면 '제품별' 보기에서 함께 묶여요.</span></label>
      <div class="grid2">
        <label class="field"><span>공구 시작일 <i>*</i></span><input type="date" name="start_date" required></label>
        <label class="field"><span>마감일</span><input type="date" name="end_date"><span class="hint">비워두면 '마감 미정'</span></label>
      </div>
      <div class="grid2">
        <label class="field"><span>공구가 (원)</span><input name="price" inputmode="numeric" placeholder="29900"></label>
        <label class="field"><span>정가 (원)</span><input name="original_price" inputmode="numeric" placeholder="39000"></label>
      </div>
      <label class="field"><span>메모</span><input name="note" maxlength="300" placeholder="예) 2개 이상 무료배송, 사은품 증정"></label>
    </div>
    <div class="form-error" id="form-error" role="alert"></div>
    <div><button class="btn primary" type="submit" style="padding:10px 18px;font-size:15px">제보하기</button></div>
    <datalist id="dl-handles">${suggestions.handles.map((h) => html`<option value="${h}">`)}</datalist>
    <datalist id="dl-products">${suggestions.products.map((p) => html`<option value="${p.product_name}">${p.brand}</option>`)}</datalist>
  </form>`;
}

function bindSubmit() {
  const form = $('#submit-form');
  const set = (name, v) => {
    if (v == null || v === '') return;
    const el = form.elements[name];
    el.value = v;
    el.classList.remove('filled'); void el.offsetWidth; el.classList.add('filled');
  };
  const autofill = () => {
    const caption = form.elements.caption.value;
    const url = form.elements.post_url.value;
    if (!caption.trim() && !url.trim()) return toast('링크나 본문을 먼저 붙여넣어 주세요.');
    const p = parseCaption(caption, { url, ref: today() });
    if (p.post_url) form.elements.post_url.value = p.post_url;
    set('handle', p.handle);
    set('product_name', p.product_name);
    set('brand', p.brand);
    if (caption.trim()) set('category', p.category);
    set('start_date', p.start_date);
    set('end_date', p.end_date);
    set('price', p.price);
    set('original_price', p.original_price);
    const m = $('#mentions');
    const cands = p.mentions.filter((x) => x !== p.handle);
    m.hidden = !cands.length;
    m.innerHTML = cands.length ? html`<span class="hint">본문에 언급된 계정:</span>${cands.map((x) => html`<button type="button" class="chip" data-mention="${x}">@${x}</button>`)}`[RAW] : '';
    const got = [p.start_date && '날짜', p.price && '가격', p.product_name && '제품명', p.handle && '계정'].filter(Boolean);
    toast(got.length ? `${got.join('·')}을(를) 채웠어요. 내용을 확인해주세요.` : '자동으로 찾은 정보가 없어요. 직접 입력해주세요.');
  };
  $('#autofill').addEventListener('click', autofill);
  form.elements.caption.addEventListener('paste', () => setTimeout(autofill, 0));
  form.elements.post_url.addEventListener('change', () => {
    const p = parseCaption('', { url: form.elements.post_url.value });
    if (p.handle && !form.elements.handle.value) set('handle', p.handle);
  });
  $('#mentions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mention]');
    if (b) set('handle', b.dataset.mention);
  });
  form.elements.product_name.addEventListener('change', () => {
    const hit = suggestions.products.find((p) => p.product_name === form.elements.product_name.value);
    if (hit) { set('brand', hit.brand); set('category', hit.category); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.textContent = '';
    const body = Object.fromEntries(new FormData(form));
    delete body.caption;
    body.handle = normalizeHandle(body.handle);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/api/deals', { method: 'POST', body });
      toast(r.review === 'pending' ? '제보 고마워요! 확인 후 게시될 거예요.' : '등록됐어요! 고마워요 🙌');
      await refreshMeta();
      location.hash = r.review === 'pending' ? '#/ongoing' : `#/products/${encodeURIComponent(r.deal.product_key)}`;
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- 라우팅/렌더 ----------
async function render() {
  const [, view = 'ongoing', key] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  state.view = view;
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.view === view);
  $('#filters').hidden = view === 'submit' || view === 'review';
  $('#show-ended-wrap').hidden = !(view === 'products' || view === 'accounts');
  const el = $('#view');
  const admin = Boolean(state.meta?.is_admin);
  try {
    let out;
    if (view === 'upcoming') out = await viewList('upcoming');
    else if (view === 'products') out = await viewGroups('product', key && decodeURIComponent(key));
    else if (view === 'accounts') out = await viewGroups('influencer', key && decodeURIComponent(key));
    else if (view === 'review') out = await viewReview();
    else if (view === 'submit') {
      suggestions = await api('/api/suggestions').catch(() => suggestions);
      out = viewSubmit();
    } else out = await viewList('ongoing');
    el.innerHTML = out[RAW];
    if (view === 'submit') bindSubmit();
    if (admin && view !== 'review' && state.meta?.review_required) {
      // 공개 운영 시에만 일반 화면에 삭제 버튼 노출 (로컬 모드에선 화면을 깔끔하게)
      for (const card of el.querySelectorAll('.card [data-ics]')) {
        const d = dealCache.get(card.dataset.ics);
        if (d) card.insertAdjacentHTML('afterend', html`<button type="button" class="btn ghost danger" data-del="${d.id}">삭제</button>`[RAW]);
      }
    }
  } catch (e) {
    el.innerHTML = html`<div class="empty">불러오지 못했어요. (${e.message})</div>`[RAW];
  }
}

async function refreshMeta() {
  state.meta = await api('/api/meta');
  $('#c-ongoing').textContent = state.date ? '' : state.meta.counts.ongoing || '';
  $('#c-upcoming').textContent = state.date ? '' : state.meta.counts.upcoming || '';
  $('#c-pending').textContent = state.meta.counts.pending || '';
  $('#tab-review').hidden = !(state.meta.is_admin && state.meta.review_required);
  $('#sample-banner').hidden = !state.meta.has_samples;
  $('#asof').value = today();
  $('#asof-label').textContent = `${fmtDate(today())} 기준`;
  $('.asof').classList.toggle('changed', Boolean(state.date) && state.date !== state.meta.today);
}

function renderCats() {
  $('#cats').innerHTML = html`${['', ...CATEGORIES].map((c) => html`<button type="button" class="chip" data-cat="${c}" aria-pressed="${state.category === c}">${c || '전체'}</button>`)}`[RAW];
}

function downloadICS(d) {
  const blob = new Blob([toICS([d], { name: '아기 공구' })], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gonggu-${d.handle}-${d.start_date}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openDialog(content) {
  $('#dlg-body').innerHTML = content[RAW];
  $('#dlg').showModal();
}

// ---------- 이벤트 ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.dataset.star !== undefined) {
    const h = t.dataset.star;
    state.watch.has(h) ? state.watch.delete(h) : state.watch.add(h);
    store.set('watch', [...state.watch]);
    for (const b of document.querySelectorAll(`[data-star="${CSS.escape(h)}"]`)) {
      const on = state.watch.has(h);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }
    toast(state.watch.has(h) ? `@${h} 관심 계정에 추가했어요.` : `@${h} 관심 계정에서 뺐어요.`);
    if (state.onlyWatch) render();
  } else if (t.dataset.cat !== undefined) {
    state.category = t.dataset.cat;
    renderCats();
    render();
  } else if (t.dataset.ics) {
    const d = dealCache.get(t.dataset.ics);
    if (d) downloadICS(d);
  } else if (t.dataset.del) {
    if (!confirm('이 공구를 삭제할까요?')) return;
    try { await api(`/api/deals/${t.dataset.del}`, { method: 'DELETE' }); toast('삭제했어요.'); await refreshMeta(); render(); } catch (ex) { toast(ex.message); }
  } else if (t.dataset.approve) {
    try { await api(`/api/deals/${t.dataset.approve}`, { method: 'PATCH', body: { review: 'published' } }); toast('게시했어요.'); await refreshMeta(); render(); } catch (ex) { toast(ex.message); }
  } else if (t.dataset.showEnded !== undefined) {
    state.showEnded = true;
    $('#show-ended').checked = true;
    render();
  }
});

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 250);
});
$('#only-watch').addEventListener('change', (e) => {
  state.onlyWatch = e.target.checked;
  if (state.onlyWatch && !state.watch.size) toast('★를 눌러 관심 계정을 먼저 추가해주세요.');
  render();
});
$('#show-ended').addEventListener('change', (e) => { state.showEnded = e.target.checked; render(); });
$('#asof').addEventListener('change', async (e) => {
  state.date = e.target.value && e.target.value !== state.meta?.today ? e.target.value : '';
  await refreshMeta();
  render();
});
$('#del-samples').addEventListener('click', async () => {
  if (!confirm('샘플 데이터를 모두 삭제할까요?')) return;
  try { const r = await api('/api/samples', { method: 'DELETE' }); toast(`샘플 ${r.deleted}건을 삭제했어요.`); await refreshMeta(); render(); } catch (ex) { toast(ex.message); }
});
$('#subscribe').addEventListener('click', () => {
  if (!state.watch.size) return toast('★를 눌러 관심 계정을 먼저 추가해주세요.');
  const url = `${location.origin}/api/calendar.ics?handles=${encodeURIComponent([...state.watch].join(','))}`;
  const webcal = url.replace(/^https?:/, 'webcal:');
  openDialog(html`<h3>📅 관심 계정 공구 캘린더</h3>
    <p class="hint">아래 주소를 구글 캘린더(다른 캘린더 → URL로 추가)나 아이폰 캘린더(구독 캘린더 추가)에 넣으면, 관심 계정의 진행중·예정 공구가 자동으로 캘린더에 표시돼요.</p>
    <code>${url}</code>
    <div class="actions"><a class="btn primary" href="${webcal}">캘린더 앱에서 열기</a><button type="button" class="btn" id="copy-ics">주소 복사</button></div>`);
  $('#copy-ics').addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast('복사했어요.')));
});
$('#admin-btn').addEventListener('click', () => {
  openDialog(html`<h3>관리자 토큰</h3>
    <p class="hint">서버에 ADMIN_TOKEN을 설정한 경우, 같은 값을 입력하면 제보 검토·삭제를 할 수 있어요. 이 브라우저에만 저장돼요.</p>
    <label class="field"><input type="password" id="admin-token" value="${store.get('adminToken', '')}" autocomplete="off"></label>
    <div class="actions" style="margin-top:8px"><button type="button" class="btn primary" id="save-token">저장</button></div>`);
  $('#save-token').addEventListener('click', async () => {
    store.set('adminToken', $('#admin-token').value.trim());
    $('#dlg').close();
    await refreshMeta();
    toast(state.meta.is_admin ? '관리자 모드예요.' : '토큰이 맞지 않아요.');
    render();
  });
});
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// ---------- 시작 ----------
renderCats();
refreshMeta().then(render).catch((e) => { $('#view').innerHTML = html`<div class="empty">서버에 연결하지 못했어요. (${e.message})</div>`[RAW]; });
