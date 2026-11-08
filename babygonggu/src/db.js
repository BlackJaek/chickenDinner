import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATEGORIES, normalizeHandle, isValidHandle, parseInstagramUrl } from '../public/lib/parser.js';
import { isValidDate, dealStatus, dday, effectiveEnd } from '../public/lib/dates.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  handle         TEXT NOT NULL,
  product_name   TEXT NOT NULL,
  brand          TEXT NOT NULL DEFAULT '',
  product_key    TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT '기타',
  post_url       TEXT,
  start_date     TEXT NOT NULL,
  end_date       TEXT,
  price          INTEGER,
  original_price INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  review         TEXT NOT NULL DEFAULT 'published',  -- published | pending
  source         TEXT NOT NULL DEFAULT 'user',       -- user | instagram
  is_sample      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS deals_post_url ON deals(post_url) WHERE post_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_dates ON deals(start_date, end_date);
CREATE INDEX IF NOT EXISTS deals_handle ON deals(handle);
CREATE INDEX IF NOT EXISTS deals_product ON deals(product_key);

CREATE TABLE IF NOT EXISTS influencers (
  handle       TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  tracked      INTEGER NOT NULL DEFAULT 0,  -- 1이면 인스타그램 수집기가 주기적으로 확인
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function productKey(brand, name) {
  return `${brand || ''}${name || ''}`.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export class ValidationError extends Error {}

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

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) { this.db = db; }

  insertDeal(input, { review = 'published', source = 'user', is_sample = 0 } = {}) {
    const d = validateDeal(input);
    if (d.post_url) {
      const dup = this.db.prepare('SELECT id FROM deals WHERE post_url = ?').get(d.post_url);
      if (dup) {
        const err = new ValidationError('이미 등록된 게시물이에요.');
        err.existingId = dup.id;
        throw err;
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO influencers(handle) VALUES (?)').run(d.handle);
    const r = this.db.prepare(`INSERT INTO deals
      (handle, product_name, brand, product_key, category, post_url, start_date, end_date, price, original_price, note, review, source, is_sample)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.handle, d.product_name, d.brand, d.product_key, d.category, d.post_url, d.start_date, d.end_date,
      d.price, d.original_price, d.note, review, source, is_sample ? 1 : 0);
    return this.getDeal(Number(r.lastInsertRowid));
  }

  updateDeal(id, patch) {
    const cur = this.getDeal(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    const d = validateDeal(merged);
    const review = ['published', 'pending'].includes(merged.review) ? merged.review : cur.review;
    this.db.prepare('INSERT OR IGNORE INTO influencers(handle) VALUES (?)').run(d.handle);
    this.db.prepare(`UPDATE deals SET handle=?, product_name=?, brand=?, product_key=?, category=?, post_url=?,
      start_date=?, end_date=?, price=?, original_price=?, note=?, review=? WHERE id=?`).run(
      d.handle, d.product_name, d.brand, d.product_key, d.category, d.post_url, d.start_date, d.end_date,
      d.price, d.original_price, d.note, review, id);
    return this.getDeal(id);
  }

  deleteDeal(id) {
    return this.db.prepare('DELETE FROM deals WHERE id = ?').run(id).changes > 0;
  }

  deleteSamples() {
    return this.db.prepare('DELETE FROM deals WHERE is_sample = 1').run().changes;
  }

  getDeal(id) {
    return this.db.prepare('SELECT * FROM deals WHERE id = ?').get(id) ?? null;
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM deals').get().n;
  }

  /**
   * @param {{today: string, status?: string, q?: string, category?: string, handle?: string,
   *          handles?: string[], product_key?: string, review?: string}} f
   * status: ongoing | upcoming | ended | active(진행중+예정) | all
   */
  listDeals(f) {
    const where = ['review = ?'];
    const args = [f.review === 'pending' ? 'pending' : 'published'];
    if (f.category) { where.push('category = ?'); args.push(f.category); }
    if (f.handle) { where.push('handle = ?'); args.push(normalizeHandle(f.handle)); }
    if (f.handles) {
      if (!f.handles.length) return [];
      where.push(`handle IN (${f.handles.map(() => '?').join(',')})`); args.push(...f.handles);
    }
    if (f.product_key) { where.push('product_key = ?'); args.push(f.product_key); }
    if (f.q) {
      const like = `%${f.q.replace(/^@/, '').replace(/[%_\\]/g, '\\$&')}%`;
      where.push(`(product_name LIKE ? ESCAPE '\\' OR brand LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`);
      args.push(like, like, like, like);
    }
    const rows = this.db.prepare(`SELECT * FROM deals WHERE ${where.join(' AND ')} ORDER BY start_date, id`).all(...args);
    const status = f.status || 'active';
    return rows
      .map((r) => ({ ...r, status: dealStatus(r, f.today), dday: dday(r, f.today), effective_end: effectiveEnd(r) }))
      .filter((r) => status === 'all' || r.status === status || (status === 'active' && r.status !== 'ended'));
  }

  /** 제품별/계정별 그룹. 필터에 걸린 공구가 하나라도 있는 그룹을 반환하되, 그룹 안에는 전체 이력을 담는다. */
  grouped(by, f) {
    const matched = this.listDeals(f);
    const keyOf = (d) => (by === 'product' ? d.product_key : d.handle);
    const keys = new Set(matched.map(keyOf));
    if (!keys.size) return [];
    const all = this.listDeals({ today: f.today, status: 'all' }).filter((d) => keys.has(keyOf(d)));
    const groups = new Map();
    for (const d of all) {
      const k = keyOf(d);
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

  suggestions() {
    return {
      products: this.db.prepare(`SELECT product_name, brand, category, MAX(start_date) AS last FROM deals
        WHERE review='published' GROUP BY product_key ORDER BY last DESC LIMIT 300`).all(),
      handles: this.db.prepare(`SELECT handle FROM deals WHERE review='published' GROUP BY handle ORDER BY MAX(start_date) DESC LIMIT 300`).all().map((r) => r.handle),
    };
  }

  trackedHandles() {
    return this.db.prepare('SELECT handle FROM influencers WHERE tracked = 1 ORDER BY handle').all().map((r) => r.handle);
  }

  setTracked(handle, tracked) {
    const h = normalizeHandle(handle);
    if (!isValidHandle(h)) throw new ValidationError('인스타그램 계정을 확인해주세요.');
    this.db.prepare('INSERT INTO influencers(handle, tracked) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET tracked = excluded.tracked').run(h, tracked ? 1 : 0);
  }
}
