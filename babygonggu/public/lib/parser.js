// 인스타그램 공구 게시물 캡션 → 구조화된 정보 추출기 (휴리스틱).
// 공구 글은 해시태그 없이 "11/10(월) 오전 10시 ~ 11/14(금) 자정", "공구가 29,900원" 처럼
// 자유 형식으로 쓰이는 경우가 많아, 날짜·가격·제품명·카테고리를 최대한 추정한다.
// 서버(수집기)와 브라우저(등록 폼) 양쪽에서 사용한다.

import { toDateStr, isValidDate, daysBetween } from './dates.js';

export const CATEGORIES = [
  '이유식·간식', '분유·음료', '기저귀·물티슈', '스킨케어·위생', '수유·식기',
  '의류·침구', '장난감·도서', '외출·이동', '가구·생활', '기타',
];

const CATEGORY_KEYWORDS = [
  ['이유식·간식', /이유식|유아식|퓨레|떡뻥|쌀과자|간식|큐브|죽|소스|김자반|치즈|요거트|과자|젤리|반찬|밀키트|한우|고기/],
  ['분유·음료', /분유|우유|두유|주스|음료|보리차|생수|산양/],
  ['기저귀·물티슈', /기저귀|팬티형|밴드형|물티슈|건티슈|방수매트/],
  ['스킨케어·위생', /로션|크림|워시|샴푸|바디|선크림|선케어|오일|파우더|세제|세정|칫솔|치약|손소독|수딩|보습/],
  ['수유·식기', /젖병|젖꼭지|빨대컵|식기|이유식기|턱받이|수유|유축|노리개|쪽쪽이|스푼|식판|컵/],
  ['의류·침구', /내의|바디슈트|우주복|수면조끼|양말|옷|레깅스|원피스|이불|베개|속싸개|겉싸개|침구|스와들/],
  ['장난감·도서', /장난감|교구|놀이|블록|퍼즐|인형|그림책|전집|도서|책|모빌|치발기|애착/],
  ['외출·이동', /유모차|카시트|아기띠|힙시트|웨건|기저귀가방|외출/],
  ['가구·생활', /범퍼|매트|침대|가드|안전문|하이체어|의자|수납|가습기|청소기|소독기|체온계/],
];

const RANGE_SEP = /[~∼〜\-–—]|부터/;
const DATE_RE = /(?:(20\d{2})\s*(?:[./-]|년)\s*)?(\d{1,2})\s*(?:[./]|월\s*|-(?=\d))\s*(\d{1,2})(?!\d)\s*(?:일)?(?:\s*\(\s*[월화수목금토일]\s*\))?/g;
const UNIT_AFTER = /^\s*(?:kg|g|ml|l|mm|cm|m|개|팩|원|%|매|입|세트|박스|봉|단계|병|캔|ea|p\b|kcal)/i;
const START_KW = /오픈|시작|open|오전|부터/i;
const END_KW = /마감|종료|까지|close|소진/i;

function inferYear(m, d, ref) {
  const ry = Number(ref.slice(0, 4));
  let best = null;
  for (const y of [ry - 1, ry, ry + 1]) {
    const s = toDateStr(y, m, d);
    if (!isValidDate(s)) continue;
    const dist = Math.abs(daysBetween(ref, s));
    if (!best || dist < best.dist) best = { s, dist };
  }
  return best?.s ?? null;
}

/** 캡션에서 날짜 토큰들을 위치와 함께 추출 */
export function extractDates(text, ref) {
  const out = [];
  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(text))) {
    const before = text[m.index - 1];
    if (before && /[\d.,:]/.test(before)) continue; // 39,000.5 / 10:30 같은 경우 제외
    const after = text.slice(m.index + m[0].length);
    if (UNIT_AFTER.test(after)) continue;          // 1.5kg, 6.5% 등 제외
    const year = m[1];
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
    const date = year ? toDateStr(Number(year), mo, da) : inferYear(mo, da, ref);
    if (!date || !isValidDate(date)) continue;
    out.push({ date, month: mo, index: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out;
}

function sameMonthDay(base, day) {
  const s = base.slice(0, 8) + String(day).padStart(2, '0');
  return isValidDate(s) ? s : null;
}

export function parsePeriod(text, ref) {
  const tokens = extractDates(text, ref);
  // 1) "A ~ B" 형태의 범위를 우선
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (next) {
      const between = text.slice(t.end, next.index);
      if (between.length <= 25 && !between.includes('\n') && RANGE_SEP.test(between)) {
        let end = next.date;
        if (end < t.date) end = inferYear(next.month, Number(end.slice(8)), t.date);
        return { start: t.date, end };
      }
    }
    // "11월 10일 ~ 14일", "11/10(월)~14(금)"
    const tail = text.slice(t.end, t.end + 25);
    const dm = tail.match(/^[^~∼〜\-–—\n]{0,12}[~∼〜\-–—]\s*(\d{1,2})\s*(?:일|\(|\s|$)/);
    if (dm && !/^[^~∼〜\-–—\n]{0,12}[~∼〜\-–—]\s*\d{1,2}\s*[./월]/.test(tail)) {
      const end = sameMonthDay(t.date, Number(dm[1]));
      if (end && end >= t.date) return { start: t.date, end };
    }
  }
  // 2) "11/10 오픈", "11/14 마감" 키워드
  let start = null, end = null;
  for (const t of tokens) {
    const ctx = text.slice(t.end, t.end + 12) + ' ' + text.slice(Math.max(0, t.index - 8), t.index);
    if (!end && END_KW.test(ctx) && !START_KW.test(text.slice(t.end, t.end + 6))) end = t.date;
    else if (!start && START_KW.test(ctx)) start = t.date;
  }
  if (!start && tokens.length) start = tokens.find((t) => t.date !== end)?.date ?? null;
  if (start && end && end < start) [start, end] = [end, start];
  return { start, end };
}

function toWon(s) {
  return Number(String(s).replace(/,/g, ''));
}

export function parsePrices(text) {
  const found = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d{4,7})\s*원|(\d{1,3})\s*만\s*(?:(\d)\s*천)?\s*(?:(\d{1,3})\s*백)?\s*원/g;
  let m;
  while ((m = re.exec(text))) {
    const value = m[1] ? toWon(m[1]) : Number(m[2]) * 10000 + Number(m[3] || 0) * 1000 + Number(m[4] || 0) * 100;
    if (value < 500 || value > 10_000_000) continue;
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    found.push({ value, before, index: m.index });
  }
  if (!found.length) return { price: null, original_price: null };
  const pick = (kw) => found.find((f) => kw.test(f.before))?.value ?? null;
  let price = pick(/공구가|특가|할인가|혜택가|판매가|최종가|공구\s*가격|→|➡|▶/);
  let original = pick(/정가|소비자가|정상가|시중가|원가|권장가/);
  if (price == null) price = Math.min(...found.map((f) => f.value).filter((v) => v !== original));
  if (!Number.isFinite(price)) price = null;
  if (original == null) {
    const max = Math.max(...found.map((f) => f.value));
    if (price != null && max > price) original = max;
  }
  return { price, original_price: original && price && original > price ? original : null };
}

export function guessCategory(text) {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(text)) return cat;
  return '기타';
}

const NOISE = /공동구매|공구|오픈|안내|시작|마감|예정|드디어|재진행|앵콜|앵코르|진행|합니다|해요|입니다|open|OPEN|D-\d+/g;
function cleanTitle(s) {
  return s
    .split(/정가|정상가|소비자가|공구가|판매가|할인가|혜택가|가격|문의|배송/)[0]
    .replace(/\d{2,3}-\d{3,4}-\d{4}/g, ' ')
    .replace(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/g, ' ')
    .replace(DATE_RE, (m, _y, _mo, _d, off, str) => (UNIT_AFTER.test(str.slice(off + m.length)) ? m : ' '))
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/@[A-Za-z0-9._]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[|•·★☆♡♥✔︎✨]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-:~,.!]+|[\s\-:~,.!]+$/g, '')
    .trim();
}

export function parseProduct(text) {
  const brandM = text.match(/브랜드\s*[:：]\s*([^\n,/]{1,30})/);
  const brand = brandM ? brandM[1].trim() : '';
  const prodM = text.match(/(?:제품명?|상품명?|품목)\s*[:：]\s*([^\n]{2,50})/);
  if (prodM) return { brand, product_name: cleanTitle(prodM[1]).slice(0, 50) };
  const bracketRe = /[[【<〈《「『]\s*([^\]】>〉》」』\n]{2,50}?)\s*[\]】>〉》」』]/g;
  let m;
  while ((m = bracketRe.exec(text))) {
    const t = cleanTitle(m[1]);
    if (t.length >= 2) return { brand, product_name: t.slice(0, 50) };
  }
  for (const line of text.split('\n')) {
    const t = cleanTitle(line);
    if (t.length >= 2 && /[가-힣A-Za-z]/.test(t)) return { brand, product_name: t.slice(0, 50) };
  }
  return { brand, product_name: '' };
}

export function parseInstagramUrl(url) {
  if (!url) return { post_url: '', handle: '' };
  const m = String(url).trim().match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:([A-Za-z0-9._]{1,30})\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return { post_url: '', handle: '' };
  const kind = m[2].toLowerCase() === 'reels' ? 'reel' : m[2].toLowerCase();
  return { post_url: `https://www.instagram.com/${kind}/${m[3]}/`, handle: (m[1] || '').toLowerCase() };
}

export function normalizeHandle(h) {
  return String(h || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '').toLowerCase();
}

export function isValidHandle(h) {
  return /^[a-z0-9._]{1,30}$/.test(h);
}

export function looksLikeGonggu(text) {
  return /공구|공동구매|group\s*buy/i.test(text || '') && /오픈|마감|진행|open|~/i.test(text || '');
}

/**
 * @param {string} caption 인스타 게시물 본문
 * @param {{url?: string, ref?: string}} opts ref: 연도 추정 기준일(YYYY-MM-DD)
 */
export function parseCaption(caption, { url = '', ref } = {}) {
  const text = String(caption || '').replace(/\r/g, '');
  const reference = ref || new Date().toISOString().slice(0, 10);
  const { start, end } = parsePeriod(text, reference);
  const { price, original_price } = parsePrices(text);
  const { brand, product_name } = parseProduct(text);
  const fromUrl = parseInstagramUrl(url);
  const mentions = [...new Set([...text.matchAll(/@([A-Za-z0-9._]{2,30})/g)].map((x) => x[1].toLowerCase().replace(/\.$/, '')))];
  return {
    handle: fromUrl.handle,
    post_url: fromUrl.post_url,
    mentions,
    product_name,
    brand,
    category: guessCategory(product_name + ' ' + text),
    start_date: start,
    end_date: end,
    price,
    original_price,
    is_gonggu: looksLikeGonggu(text),
  };
}
