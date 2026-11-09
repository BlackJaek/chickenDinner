// 서버(SQLite)와 브라우저 체험판이 함께 쓰는 공구 데이터 규칙: 검증, 상태 계산, 제품/계정 묶기.
import { CATEGORIES, normalizeHandle, isValidHandle, parseInstagramUrl } from './parser.js';
import { isValidDate, dealStatus, dday, effectiveEnd } from './dates.js';

export class ValidationError extends Error {}

export function productKey(brand, name) {
  return `${brand || ''}${name || ''}`.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function cleanPrice(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,원\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw new ValidationError('가격은 숫자로 입력해주세요.');
  return n;
}

/** 사용자 입력을 검증·정규화. 잘못되면 ValidationError */
export function validateDeal(input) {
  const handle = normalizeHandle(input.handle);
  if (!isValidHandle(handle)) throw new ValidationError('인스타그램 계정(@아이디)을 확인해주세요.');
  const product_name = cleanText(input.product_name, 80);
  if (!product_name) throw new ValidationError('제품명을 입력해주세요.');
  const brand = cleanText(input.brand, 40);
  const category = CATEGORIES.includes(input.category) ? input.category : '기타';
  const start_date = String(input.start_date || '');
  if (!isValidDate(start_date)) throw new ValidationError('공구 시작일을 입력해주세요.');
  const end_date = input.end_date ? String(input.end_date) : null;
  if (end_date && !isValidDate(end_date)) throw new ValidationError('마감일 형식이 올바르지 않아요.');
  if (end_date && end_date < start_date) throw new ValidationError('마감일이 시작일보다 빨라요.');
  let post_url = null;
  if (input.post_url) {
    post_url = parseInstagramUrl(input.post_url).post_url || null;
    if (!post_url) throw new ValidationError('인스타그램 게시물 링크(instagram.com/p/… 또는 /reel/…)를 넣어주세요.');
  }
  return {
    handle, product_name, brand, category, start_date, end_date, post_url,
    product_key: productKey(brand, product_name),
    price: cleanPrice(input.price),
    original_price: cleanPrice(input.original_price),
    note: cleanText(input.note, 300),
  };
}

/** 행에 기준일 상태(status, dday)를 붙이고 status 필터(ongoing|upcoming|ended|active|all) 적용 */
export function withStatus(rows, today, status = 'active') {
  return rows
    .map((r) => ({ ...r, status: dealStatus(r, today), dday: dday(r, today), effective_end: effectiveEnd(r) }))
    .filter((r) => status === 'all' || r.status === status || (status === 'active' && r.status !== 'ended'));
}

/**
 * 제품별/계정별 그룹. matched(필터에 걸린 공구)가 있는 그룹만, 그룹 안에는 all(전체 이력)을 담는다.
 * @param {'product'|'influencer'} by
 */
export function groupDeals(by, matched, all) {
  const keyOf = (d) => (by === 'product' ? d.product_key : d.handle);
  const keys = new Set(matched.map(keyOf));
  const groups = new Map();
  for (const d of all) {
    const k = keyOf(d);
    if (!keys.has(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const rank = { ongoing: 0, upcoming: 1, ended: 2 };
  const out = [];
  for (const [key, deals] of groups) {
    deals.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
    const ongoing = deals.filter((d) => d.status === 'ongoing');
    const upcoming = deals.filter((d) => d.status === 'upcoming');
    const latest = deals[deals.length - 1];
    const prices = deals.filter((d) => d.status !== 'ended' && d.price).map((d) => d.price);
    out.push({
      key,
      title: by === 'product' ? latest.product_name : latest.handle,
      brand: by === 'product' ? latest.brand : undefined,
      category: latest.category,
      deals,
      ongoing_count: ongoing.length,
      upcoming_count: upcoming.length,
      min_active_price: prices.length ? Math.min(...prices) : null,
      next_date: ongoing[0]?.effective_end ?? upcoming[0]?.start_date ?? latest.start_date,
      top_status: ongoing.length ? 'ongoing' : upcoming.length ? 'upcoming' : 'ended',
    });
  }
  out.sort((a, b) => rank[a.top_status] - rank[b.top_status] || a.next_date.localeCompare(b.next_date) || a.title.localeCompare(b.title));
  return out;
}
