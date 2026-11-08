import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeHandle, isValidHandle } from '../public/lib/parser.js';
import { ValidationError, productKey, validateDeal, withStatus, groupDeals } from '../public/lib/core.js';

export { ValidationError, productKey, validateDeal };

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

-- 수집 대상/후보 계정. 시드 계정에서 출발해 게시물 속 @언급을 따라 계속 늘어난다.
CREATE TABLE IF NOT EXISTS accounts (
  handle          TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'candidate', -- tracked | candidate | ignored | unreachable
  kind            TEXT NOT NULL DEFAULT 'unknown',   -- influencer | brand | unknown
  name            TEXT NOT NULL DEFAULT '',
  bio             TEXT NOT NULL DEFAULT '',
  followers       INTEGER,
  score           INTEGER NOT NULL DEFAULT 0,
  gonggu_posts    INTEGER NOT NULL DEFAULT 0,        -- 최근 게시물 중 공구 글 수
  discovered_from TEXT,                              -- 처음 발견된 계정 (시드면 NULL)
  mention_count   INTEGER NOT NULL DEFAULT 0,        -- 추적 계정들에게 언급된 횟수
  last_checked_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS accounts_status ON accounts(status, last_checked_at);

-- 계정 간 언급 관계 (A의 게시물이 @B를 언급)
CREATE TABLE IF NOT EXISTS mentions (
  from_handle TEXT NOT NULL,
  to_handle   TEXT NOT NULL,
  post_url    TEXT NOT NULL,
  is_gonggu   INTEGER NOT NULL DEFAULT 0,
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_handle, to_handle, post_url)
);
`;

export const ACCOUNT_STATUSES = ['tracked', 'candidate', 'ignored', 'unreachable'];

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // 예전 버전의 influencers.tracked 를 accounts 로 옮긴다
  db.exec(`INSERT OR IGNORE INTO accounts(handle, status) SELECT handle, 'tracked' FROM influencers WHERE tracked = 1`);
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
    return withStatus(rows, f.today, f.status || 'active');
  }

  /** 제품별/계정별 그룹. 필터에 걸린 공구가 하나라도 있는 그룹을 반환하되, 그룹 안에는 전체 이력을 담는다. */
  grouped(by, f) {
    const matched = this.listDeals(f);
    if (!matched.length) return [];
    return groupDeals(by, matched, this.listDeals({ today: f.today, status: 'all' }));
  }

  suggestions() {
    return {
      products: this.db.prepare(`SELECT product_name, brand, category, MAX(start_date) AS last FROM deals
        WHERE review='published' GROUP BY product_key ORDER BY last DESC LIMIT 300`).all(),
      handles: this.db.prepare(`SELECT handle FROM deals WHERE review='published' GROUP BY handle ORDER BY MAX(start_date) DESC LIMIT 300`).all().map((r) => r.handle),
    };
  }

  // ---------- 수집 대상 계정 ----------
  trackedHandles() {
    return this.db.prepare(`SELECT handle FROM accounts WHERE status = 'tracked' ORDER BY handle`).all().map((r) => r.handle);
  }

  setTracked(handle, tracked) {
    this.setAccountStatus(handle, tracked ? 'tracked' : 'ignored');
  }

  getAccount(handle) {
    return this.db.prepare('SELECT * FROM accounts WHERE handle = ?').get(normalizeHandle(handle)) ?? null;
  }

  /** 사용자가 직접 넣은 시드 계정: 바로 추적 */
  addSeeds(handles) {
    const added = [];
    for (const raw of handles) {
      const h = normalizeHandle(raw);
      if (!isValidHandle(h)) continue;
      this.db.prepare(`INSERT INTO accounts(handle, status) VALUES (?, 'tracked')
        ON CONFLICT(handle) DO UPDATE SET status = 'tracked', last_error = NULL`).run(h);
      added.push(h);
    }
    return added;
  }

  setAccountStatus(handle, status) {
    const h = normalizeHandle(handle);
    if (!isValidHandle(h)) throw new ValidationError('인스타그램 계정을 확인해주세요.');
    if (!ACCOUNT_STATUSES.includes(status)) throw new ValidationError('알 수 없는 상태예요.');
    this.db.prepare(`INSERT INTO accounts(handle, status) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET status = excluded.status`).run(h, status);
    return this.getAccount(h);
  }

  /** 언급으로 새로 발견한 계정은 후보로 (이미 있으면 언급 수만 증가) */
  addCandidate(handle, from) {
    const h = normalizeHandle(handle);
    if (!isValidHandle(h) || h === from) return false;
    const r = this.db.prepare(`INSERT INTO accounts(handle, status, discovered_from, mention_count) VALUES (?, 'candidate', ?, 1)
      ON CONFLICT(handle) DO NOTHING`).run(h, from);
    if (!r.changes) this.db.prepare('UPDATE accounts SET mention_count = mention_count + 1 WHERE handle = ?').run(h);
    return r.changes > 0;
  }

  recordMention(from, to, postUrl, isGonggu) {
    this.db.prepare(`INSERT INTO mentions(from_handle, to_handle, post_url, is_gonggu) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(from, to, postUrl, isGonggu ? 1 : 0);
  }

  updateAccountProfile(handle, p) {
    this.db.prepare(`UPDATE accounts SET name = ?, bio = ?, followers = ?, kind = ?, score = ?, gonggu_posts = ?,
      last_checked_at = datetime('now'), last_error = NULL WHERE handle = ?`).run(
      p.name || '', p.bio || '', p.followers ?? null, p.kind, p.score, p.gonggu_posts ?? 0, handle);
  }

  markAccountError(handle, message, status) {
    this.db.prepare(`UPDATE accounts SET last_error = ?, last_checked_at = datetime('now')${status ? ', status = ?' : ''} WHERE handle = ?`)
      .run(...(status ? [message, status, handle] : [message, handle]));
  }

  /** 가장 오래전에 확인한 추적 계정부터 */
  dueTracked(limit) {
    return this.db.prepare(`SELECT * FROM accounts WHERE status = 'tracked' ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT ?`).all(limit);
  }

  /** 아직 프로필을 확인하지 않은 후보 (많이 언급된 순) */
  uncheckedCandidates(limit) {
    return this.db.prepare(`SELECT * FROM accounts WHERE status = 'candidate' AND last_checked_at IS NULL
      ORDER BY mention_count DESC, created_at LIMIT ?`).all(limit);
  }

  listAccounts(status) {
    const rows = this.db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM deals d WHERE d.handle = a.handle AND d.review = 'published') AS deal_count
      FROM accounts a ${status ? 'WHERE a.status = ?' : ''}
      ORDER BY a.status, a.score DESC, a.mention_count DESC, a.handle`).all(...(status ? [status] : []));
    return rows;
  }

  accountCounts() {
    const out = Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, 0]));
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM accounts GROUP BY status').all()) out[r.status] = r.n;
    return out;
  }

  /** 같은 계정·시작일에 이름이 겹치는 제품 공구가 이미 있는지 (본인 글과 브랜드 일정 글의 중복 방지) */
  hasDeal(handle, productName, start_date) {
    const key = productKey('', productName);
    return this.db.prepare('SELECT product_name, brand FROM deals WHERE handle = ? AND start_date = ?').all(handle, start_date)
      .some((d) => { const k = productKey('', d.product_name); return k.includes(key) || key.includes(k); });
  }

  hasPost(postUrl) {
    return this.db.prepare('SELECT 1 FROM deals WHERE post_url = ?').get(postUrl) != null;
  }
}
