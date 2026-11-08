// 서버 없이 브라우저만으로 도는 체험판용 API.
// app.js가 부르는 /api/* 요청을 가로채 같은 규칙(lib/core.js)으로 처리하고, 데이터는 이 브라우저에만 저장한다.
import { todayKST, isValidDate } from './lib/dates.js';
import { parseCaption, CATEGORIES, normalizeHandle, isValidHandle } from './lib/parser.js';
import { ValidationError, validateDeal, withStatus, groupDeals } from './lib/core.js';
import { sampleDeals } from './lib/samples.js';

window.GONGGU_DEMO = true;
const KEY = 'gonggu-demo-v1';
const today = () => todayKST();

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && Array.isArray(v.deals)) return v;
  } catch { /* 저장소를 못 쓰는 환경이면 새로 시작 */ }
  const db = { nextId: 1, deals: [] };
  for (const d of sampleDeals(today())) insert(db, d, { is_sample: 1 });
  return db;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* 저장 실패해도 이번 방문 동안은 동작 */ }
}
function insert(target, input, { is_sample = 0 } = {}) {
  const d = validateDeal(input);
  if (d.post_url && target.deals.some((x) => x.post_url === d.post_url)) throw new ValidationError('이미 등록된 게시물이에요.');
  const row = { id: target.nextId++, ...d, review: 'published', source: 'user', is_sample, created_at: new Date().toISOString() };
  target.deals.push(row);
  return row;
}
const db = load();

function list(p, { status } = {}) {
  const date = p.get('date');
  const t = date && isValidDate(date) ? date : today();
  const q = (p.get('q') || '').trim().replace(/^@/, '').toLowerCase();
  const cat = CATEGORIES.includes(p.get('category')) ? p.get('category') : '';
  const handles = p.has('handles') ? p.get('handles').split(',').map(normalizeHandle).filter(isValidHandle) : null;
  const handle = p.get('handle') ? normalizeHandle(p.get('handle')) : '';
  const product = p.get('product') || '';
  let rows = db.deals.filter((d) => d.review === 'published');
  if (cat) rows = rows.filter((d) => d.category === cat);
  if (handles) rows = rows.filter((d) => handles.includes(d.handle));
  if (handle) rows = rows.filter((d) => d.handle === handle);
  if (product) rows = rows.filter((d) => d.product_key === product);
  if (q) rows = rows.filter((d) => [d.product_name, d.brand, d.handle, d.note].some((v) => (v || '').toLowerCase().includes(q)));
  rows.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
  return { today: t, deals: withStatus(rows, t, status || p.get('status') || 'active') };
}

function route(method, url, body) {
  const p = url.searchParams;
  const path = url.pathname;
  if (method === 'GET' && path === '/api/meta') {
    const active = list(new URLSearchParams(), { status: 'active' }).deals;
    return {
      today: today(),
      categories: CATEGORIES,
      counts: {
        ongoing: active.filter((d) => d.status === 'ongoing').length,
        upcoming: active.filter((d) => d.status === 'upcoming').length,
        pending: 0,
      },
      has_samples: db.deals.some((d) => d.is_sample),
      review_required: false,
      is_admin: true,
    };
  }
  if (method === 'GET' && path === '/api/deals') return list(p);
  if (method === 'GET' && (path === '/api/products' || path === '/api/influencers')) {
    const by = path === '/api/products' ? 'product' : 'influencer';
    const { today: t, deals } = list(p);
    const all = list(new URLSearchParams(p.get('date') ? { date: p.get('date') } : {}), { status: 'all' }).deals;
    return { today: t, groups: deals.length ? groupDeals(by, deals, all) : [] };
  }
  if (method === 'GET' && path === '/api/suggestions') {
    const seen = new Map();
    for (const d of [...db.deals].sort((a, b) => b.start_date.localeCompare(a.start_date))) if (!seen.has(d.product_key)) seen.set(d.product_key, d);
    return { products: [...seen.values()], handles: [...new Set(db.deals.map((d) => d.handle))] };
  }
  if (method === 'POST' && path === '/api/parse') return parseCaption(String(body.caption || ''), { url: String(body.url || ''), ref: today() });
  if (method === 'POST' && path === '/api/deals') {
    const deal = insert(db, body);
    save();
    return [201, { deal, review: 'published' }];
  }
  const m = path.match(/^\/api\/deals\/(\d+)$/);
  if (m && method === 'DELETE') {
    const i = db.deals.findIndex((d) => d.id === Number(m[1]));
    if (i < 0) return [404, { error: '공구를 찾을 수 없어요.' }];
    db.deals.splice(i, 1);
    save();
    return { ok: true };
  }
  if (method === 'DELETE' && path === '/api/samples') {
    const before = db.deals.length;
    db.deals = db.deals.filter((d) => !d.is_sample);
    save();
    return { deleted: before - db.deals.length };
  }
  return [404, { error: '체험판에서는 지원하지 않는 기능이에요.' }];
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  let status = 200, data;
  try {
    const out = route((init.method || 'GET').toUpperCase(), url, init.body ? JSON.parse(init.body) : {});
    [status, data] = Array.isArray(out) ? out : [200, out];
  } catch (e) {
    status = e instanceof ValidationError ? 400 : 500;
    data = { error: e.message };
  }
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
};
