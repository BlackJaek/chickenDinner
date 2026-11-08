import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb, ValidationError } from './db.js';
import { seedSamples } from './seed.js';
import { runCollection } from './collector.js';
import { graphClientFromEnv } from './instagram.js';
import { toICS } from '../public/lib/ics.js';
import { todayKST, isValidDate } from '../public/lib/dates.js';
import { parseCaption, CATEGORIES, normalizeHandle, isValidHandle } from '../public/lib/parser.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, '요청이 너무 커요.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않아요.');
  }
}

export function createApp({
  dbFile = process.env.DB_FILE || join(ROOT, 'data', 'gonggu.db'), adminToken = process.env.ADMIN_TOKEN || '',
  seed = process.env.SEED_SAMPLES !== '0', now, igClient = graphClientFromEnv(),
  collectOptions = {
    budget: Number(process.env.COLLECT_BUDGET || 60),
    autoTrackScore: Number(process.env.AUTO_TRACK_SCORE || 5),
    autoPublish: process.env.AUTO_PUBLISH !== '0',
  },
} = {}) {
  const store = openDb(dbFile);
  const today = () => todayKST(now ? now() : new Date());
  // 실제 수집이 설정돼 있으면 샘플은 넣지 않는다
  if (seed && !igClient && store.count() === 0) seedSamples(store, today());

  // ---------- 자동 수집 ----------
  const collect = { running: false, last: null, log: [] };
  async function startCollection() {
    if (!igClient) throw new HttpError(400, '인스타그램 API가 설정되지 않았어요. (IG_USER_ID, IG_ACCESS_TOKEN)');
    if (collect.running) return false;
    if (!store.trackedHandles().length) throw new HttpError(400, '추적할 계정을 먼저 추가해주세요.');
    collect.running = true;
    collect.log = [];
    const started = new Date().toISOString();
    try {
      const stats = await runCollection({
        store, client: igClient, today: today(), ...collectOptions,
        log: (line) => { collect.log.push(line); if (collect.log.length > 200) collect.log.shift(); },
      });
      if (stats.deals_added > 0) store.deleteSamples(); // 실제 데이터가 들어오면 샘플 정리
      collect.last = { started, finished: new Date().toISOString(), ...stats };
    } catch (e) {
      collect.last = { started, finished: new Date().toISOString(), stopped: e.message, errors: [] };
    } finally {
      collect.running = false;
    }
    return true;
  }
  let timer = null;
  function scheduleCollection(minutes) {
    if (!igClient || !minutes) return;
    const tick = () => startCollection().catch((e) => { collect.last = { finished: new Date().toISOString(), stopped: e.message, errors: [] }; });
    setTimeout(tick, 5_000).unref();
    timer = setInterval(tick, minutes * 60_000);
    timer.unref();
  }

  const isAdmin = (req) => {
    if (!adminToken) return true; // 로컬/개인용: 토큰 미설정 시 모두 관리자
    const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const want = Buffer.from(adminToken);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const requireAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(403, '관리자 토큰이 필요해요.'); };

  const filtersFrom = (url) => {
    const p = url.searchParams;
    const date = p.get('date');
    // handles 파라미터가 있으면(관심 계정만 보기) 그 계정들로 제한. 비어 있으면 결과도 비어야 한다.
    const handles = p.has('handles') ? p.get('handles').split(',').map(normalizeHandle).filter(isValidHandle).slice(0, 200) : undefined;
    return {
      today: date && isValidDate(date) ? date : today(),
      status: p.get('status') || 'active',
      q: (p.get('q') || '').trim().slice(0, 50),
      category: CATEGORIES.includes(p.get('category')) ? p.get('category') : '',
      handle: p.get('handle') || '',
      handles,
      product_key: p.get('product') || '',
    };
  };

  async function api(req, res, url) {
    const path = url.pathname;
    const m = req.method;
    const idMatch = path.match(/^\/api\/deals\/(\d+)$/);

    if (m === 'GET' && path === '/api/meta') {
      const t = today();
      const active = store.listDeals({ today: t, status: 'active' });
      return send(res, 200, {
        today: t,
        categories: CATEGORIES,
        counts: {
          ongoing: active.filter((d) => d.status === 'ongoing').length,
          upcoming: active.filter((d) => d.status === 'upcoming').length,
          pending: store.listDeals({ today: t, status: 'all', review: 'pending' }).length,
        },
        has_samples: store.db.prepare('SELECT 1 FROM deals WHERE is_sample=1 LIMIT 1').get() != null,
        review_required: Boolean(adminToken),
        collector: { configured: Boolean(igClient), running: collect.running, last_finished: collect.last?.finished ?? null },
        is_admin: isAdmin(req),
      });
    }
    if (m === 'GET' && path === '/api/deals') {
      const f = filtersFrom(url);
      if (url.searchParams.get('review') === 'pending') { requireAdmin(req); f.review = 'pending'; f.status = 'all'; }
      return send(res, 200, { today: f.today, deals: store.listDeals(f) });
    }
    if (m === 'GET' && path === '/api/products') {
      const f = filtersFrom(url);
      return send(res, 200, { today: f.today, groups: store.grouped('product', f) });
    }
    if (m === 'GET' && path === '/api/influencers') {
      const f = filtersFrom(url);
      return send(res, 200, { today: f.today, groups: store.grouped('influencer', f) });
    }
    if (m === 'GET' && path === '/api/suggestions') return send(res, 200, store.suggestions());
    if (m === 'GET' && path === '/api/calendar.ics') {
      const f = filtersFrom(url);
      f.status = 'active';
      const label = f.handles?.length ? `관심계정 공구 (${f.handles.length})` : '아기 공구 캘린더';
      return send(res, 200, toICS(store.listDeals(f), { name: label }), {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'inline; filename="gonggu.ics"',
      });
    }
    if (m === 'POST' && path === '/api/parse') {
      const body = await readJson(req);
      return send(res, 200, parseCaption(String(body.caption || '').slice(0, 5000), { url: String(body.url || ''), ref: today() }));
    }
    if (m === 'POST' && path === '/api/deals') {
      const body = await readJson(req);
      const review = adminToken && !isAdmin(req) ? 'pending' : 'published';
      const deal = store.insertDeal(body, { review });
      return send(res, 201, { deal, review });
    }
    if (idMatch && m === 'PATCH') {
      requireAdmin(req);
      const deal = store.updateDeal(Number(idMatch[1]), await readJson(req));
      if (!deal) throw new HttpError(404, '공구를 찾을 수 없어요.');
      return send(res, 200, { deal });
    }
    if (idMatch && m === 'DELETE') {
      requireAdmin(req);
      if (!store.deleteDeal(Number(idMatch[1]))) throw new HttpError(404, '공구를 찾을 수 없어요.');
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE' && path === '/api/samples') {
      requireAdmin(req);
      return send(res, 200, { deleted: store.deleteSamples() });
    }
    if (m === 'GET' && path === '/api/accounts') {
      requireAdmin(req);
      const status = url.searchParams.get('status') || '';
      return send(res, 200, { counts: store.accountCounts(), accounts: store.listAccounts(status || undefined) });
    }
    if (m === 'POST' && path === '/api/accounts') {
      requireAdmin(req);
      const body = await readJson(req);
      if (Array.isArray(body.seeds) || typeof body.seeds === 'string') {
        const list = Array.isArray(body.seeds) ? body.seeds : body.seeds.split(/[\s,]+/);
        return send(res, 200, { added: store.addSeeds(list.slice(0, 500).map(String)) });
      }
      return send(res, 200, { account: store.setAccountStatus(String(body.handle || ''), String(body.status || '')) });
    }
    if (m === 'GET' && path === '/api/collect') {
      requireAdmin(req);
      return send(res, 200, { configured: Boolean(igClient), running: collect.running, last: collect.last, log: collect.log });
    }
    if (m === 'POST' && path === '/api/collect') {
      requireAdmin(req);
      const run = startCollection();
      run.catch(() => {});
      // 바로 시작 여부만 알려주고, 진행 상황은 GET /api/collect 로 확인
      await Promise.race([run, new Promise((r) => setTimeout(r, 50))]);
      return send(res, 202, { running: collect.running });
    }
    if (m === 'GET' && path === '/api/tracked') return send(res, 200, { handles: store.trackedHandles() });
    if (m === 'POST' && path === '/api/tracked') {
      requireAdmin(req);
      const body = await readJson(req);
      store.setTracked(body.handle, body.tracked !== false);
      return send(res, 200, { handles: store.trackedHandles() });
    }
    throw new HttpError(404, '없는 API예요.');
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || !extname(p)) p = '/index.html';
    const file = normalize(join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + '/')) throw new HttpError(403, 'Forbidden');
    let data;
    try { data = await readFile(file); } catch { throw new HttpError(404, 'Not Found'); }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message, existing_id: e.existingId });
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: '서버 오류가 발생했어요.' });
    }
  });
  server.on('close', () => clearInterval(timer));
  return { server, store, startCollection, scheduleCollection, collectState: collect };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const { server, scheduleCollection } = createApp();
  scheduleCollection(Number(process.env.COLLECT_INTERVAL_MIN || 120));
  server.listen(port, () => console.log(`🍼 아기 공구 모아보기: http://localhost:${port}`));
}
