import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { dealStatus, dday } from '../public/lib/dates.js';
import { extractDeals } from '../scripts/collect-instagram.js';

const NOW = () => new Date('2026-11-08T03:00:00Z'); // KST 11/8 낮
let base, server, store;

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  ({ server, store } = createApp({ dbFile: ':memory:', now: NOW, adminToken: 'secret' }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('상태 계산: 진행중/예정/종료, 마감 미정', () => {
  const t = '2026-11-08';
  assert.equal(dealStatus({ start_date: '2026-11-08', end_date: '2026-11-08' }, t), 'ongoing');
  assert.equal(dealStatus({ start_date: '2026-11-09', end_date: '2026-11-10' }, t), 'upcoming');
  assert.equal(dealStatus({ start_date: '2026-11-01', end_date: '2026-11-07' }, t), 'ended');
  assert.equal(dealStatus({ start_date: '2026-11-01', end_date: null }, t), 'ongoing');
  assert.equal(dealStatus({ start_date: '2026-10-01', end_date: null }, t), 'ended');
  assert.equal(dday({ start_date: '2026-11-01', end_date: '2026-11-10' }, t), 2);
});

test('샘플 데이터가 시드되고 진행중/예정 목록이 나뉜다', async () => {
  const meta = await call('/api/meta');
  assert.equal(meta.data.today, '2026-11-08');
  assert.equal(meta.data.has_samples, true);
  const on = await call('/api/deals?status=ongoing');
  assert.ok(on.data.deals.length > 0);
  assert.ok(on.data.deals.every((d) => d.status === 'ongoing'));
  const up = await call('/api/deals?status=upcoming');
  assert.ok(up.data.deals.every((d) => d.status === 'upcoming' && d.dday > 0));
});

test('제품별 묶음: 같은 제품의 릴레이 공구가 한 그룹에 시간순으로', async () => {
  const { data } = await call('/api/products?q=' + encodeURIComponent('큐브'));
  assert.equal(data.groups.length, 1);
  const g = data.groups[0];
  assert.deepEqual(g.deals.map((d) => d.status), ['ended', 'ongoing', 'upcoming']);
  assert.equal(g.top_status, 'ongoing');
});

test('계정별 묶음 + 관심계정 필터 (빈 목록이면 결과 없음)', async () => {
  const { data } = await call('/api/influencers?handles=sample_mom_haru');
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].key, 'sample_mom_haru');
  const empty = await call('/api/influencers?handles=');
  assert.equal(empty.data.groups.length, 0);
});

test('기준 날짜를 바꿔서 조회', async () => {
  const { data } = await call('/api/deals?status=ongoing&date=2026-12-31');
  assert.equal(data.today, '2026-12-31');
});

test('제보: 토큰이 없으면 검토 대기, 관리자가 게시', async () => {
  const body = { handle: '@New_Mom', product_name: '테스트 물티슈', start_date: '2026-11-09', end_date: '2026-11-12', price: '9,900', post_url: 'https://www.instagram.com/p/TEST1/?igsh=1' };
  const r = await call('/api/deals', { method: 'POST', body });
  assert.equal(r.status, 201);
  assert.equal(r.data.review, 'pending');
  assert.equal(r.data.deal.handle, 'new_mom');
  assert.equal(r.data.deal.price, 9900);
  assert.equal(r.data.deal.post_url, 'https://www.instagram.com/p/TEST1/');

  const pub = await call('/api/deals?status=all&q=테스트');
  assert.equal(pub.data.deals.length, 0, '검토 전에는 공개 목록에 없음');
  assert.equal((await call('/api/deals?review=pending')).status, 403);

  const ok = await call(`/api/deals/${r.data.deal.id}`, { method: 'PATCH', body: { review: 'published' }, token: 'secret' });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/deals?status=all&q=테스트')).data.deals.length, 1);

  const dup = await call('/api/deals', { method: 'POST', body });
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /이미 등록/);
});

test('제보 검증 오류', async () => {
  const bad = [
    { handle: '한글계정', product_name: 'x', start_date: '2026-11-09' },
    { handle: 'ok', product_name: '', start_date: '2026-11-09' },
    { handle: 'ok', product_name: 'x', start_date: '2026-13-01' },
    { handle: 'ok', product_name: 'x', start_date: '2026-11-09', end_date: '2026-11-01' },
    { handle: 'ok', product_name: 'x', start_date: '2026-11-09', post_url: 'https://evil.example/p/1' },
  ];
  for (const body of bad) assert.equal((await call('/api/deals', { method: 'POST', body })).status, 400, JSON.stringify(body));
  assert.equal((await call('/api/deals', { method: 'POST', body: [] })).status, 400);
});

test('관리 기능은 토큰 필요', async () => {
  assert.equal((await call('/api/samples', { method: 'DELETE' })).status, 403);
  assert.equal((await call('/api/deals/1', { method: 'DELETE', token: 'wrong' })).status, 403);
  const del = await call('/api/samples', { method: 'DELETE', token: 'secret' });
  assert.ok(del.data.deleted > 0);
});

test('캘린더(.ics) 구독 피드', async () => {
  const r = await call('/api/calendar.ics?handles=new_mom');
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.data, /BEGIN:VCALENDAR/);
  assert.match(r.data, /DTSTART;VALUE=DATE:20261109/);
  assert.match(r.data, /DTEND;VALUE=DATE:20261113/);
});

test('정적 파일 + 경로 탈출 차단', async () => {
  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/lib/parser.js')).status, 200);
  assert.notEqual((await call('/..%2f..%2fpackage.json')).status, 200);
  assert.notEqual((await call('/%2e%2e/src/db.js')).status, 200);
});

test('수집기: 공구 게시물만 추려서 후보로', () => {
  const media = [
    { caption: '[예시 떡뻥] 공구 오픈!\n11/10 ~ 11/13\n공구가 8,900원', permalink: 'https://www.instagram.com/p/AAA/', timestamp: '2026-11-07T10:00:00+0000' },
    { caption: '오늘 아기랑 산책했어요', permalink: 'https://www.instagram.com/p/BBB/', timestamp: '2026-11-07T10:00:00+0000' },
    { caption: '[옛날 공구] 공구 오픈 9/1 ~ 9/3', permalink: 'https://www.instagram.com/p/CCC/', timestamp: '2026-08-30T10:00:00+0000' },
  ];
  const out = extractDeals('mom_x', media, '2026-11-08');
  assert.equal(out.length, 1);
  assert.equal(out[0].product_name, '예시 떡뻥');
  assert.equal(out[0].start_date, '2026-11-10');
  assert.equal(out[0].price, 8900);
});
