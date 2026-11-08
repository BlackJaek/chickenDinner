import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCollection, classifyAccount, parseSchedule } from '../src/collector.js';
import { GraphError, createGraphClient } from '../src/instagram.js';

const TODAY = '2026-11-08';
const TS = '2026-11-07T10:00:00+0000';

// 가상의 인스타 세계: 시드 인플루언서 → 브랜드 → 다른 인플루언서
const WORLD = {
  mom_seed: {
    name: '하루맘', bio: '21개월 아들 육아일기 🍼 공구 문의 DM', followers: 52000,
    media: [
      { caption: '[예시 한우 큐브 이유식] 공구 오픈!\n11/6(금) ~ 11/10(화)\n정가 39,000원 → 공구가 29,900원\n@baby_brand_official 감사해요', permalink: 'https://www.instagram.com/p/S1/', timestamp: TS },
      { caption: '오늘은 아기랑 산책 @cafe_somewhere', permalink: 'https://www.instagram.com/p/S2/', timestamp: TS },
    ],
  },
  baby_brand_official: {
    name: '예시베이비', bio: '유아식 브랜드 공식 계정 | 고객센터 1588-0000', followers: 30000,
    media: [
      { caption: '[예시 한우 큐브 이유식] 릴레이 공구 일정 안내\n11/6~11/10 @mom_seed\n11/13~11/17 @twins_daddy_x\n11/20~11/24 @new_mom_y', permalink: 'https://www.instagram.com/p/B1/', timestamp: TS },
    ],
  },
  twins_daddy_x: {
    name: '쌍둥이아빠', bio: '쌍둥이 육아 | 공구 일정은 하이라이트', followers: 18000,
    media: [
      { caption: '[예시 떡뻥] 공구 오픈 11/2 ~ 11/5 공구가 8,900원', permalink: 'https://www.instagram.com/p/T1/', timestamp: TS },
      { caption: '[예시 빨대컵] 공구 11/15 ~ 11/18 공구가 12,000원', permalink: 'https://www.instagram.com/p/T2/', timestamp: TS },
    ],
  },
  new_mom_y: { name: '', bio: '24년생 딸 엄마', followers: 9000, media: [] },
  cafe_somewhere: { name: '어느카페', bio: '서울 성수 카페 ☕', followers: 4000, media: [] },
};

function fakeClient(world, { failOn = {} } = {}) {
  const calls = [];
  return {
    calls,
    async profile(u) {
      calls.push(u);
      if (failOn[u]) throw failOn[u];
      const p = world[u];
      if (!p) throw new GraphError('user cannot be found', { code: 110, subcode: 2207013 });
      return { username: u, followers: p.followers, name: p.name, bio: p.bio, media: p.media };
    },
  };
}

test('릴레이 일정 파싱: 줄마다 다른 인플루언서', () => {
  const s = parseSchedule(WORLD.baby_brand_official.media[0].caption, TODAY, 'baby_brand_official');
  assert.deepEqual(s.map((x) => [x.handle, x.start_date, x.end_date]), [
    ['mom_seed', '2026-11-06', '2026-11-10'],
    ['twins_daddy_x', '2026-11-13', '2026-11-17'],
    ['new_mom_y', '2026-11-20', '2026-11-24'],
  ]);
});

test('계정 분류: 인플루언서/브랜드/무관', () => {
  const p = (u) => ({ username: u, ...WORLD[u] });
  assert.equal(classifyAccount(p('mom_seed')).kind, 'influencer');
  assert.ok(classifyAccount(p('mom_seed')).score >= 5);
  assert.equal(classifyAccount(p('baby_brand_official')).kind, 'brand');
  assert.ok(classifyAccount(p('cafe_somewhere')).score < 0);
});

test('눈덩이 수집: 시드 → 브랜드 → 새 인플루언서 발굴, 공구 저장', async () => {
  const store = openDb(':memory:');
  store.addSeeds(['@mom_seed']);
  const client = fakeClient(WORLD);

  // 1회차: 시드 수집 + 언급된 계정(브랜드, 카페) 프로필 확인
  const r1 = await runCollection({ store, client, today: TODAY, budget: 10 });
  assert.equal(r1.deals_added, 1);
  assert.ok(r1.auto_tracked.includes('baby_brand_official'), '육아 브랜드는 허브로 자동 추적');
  assert.equal(store.getAccount('cafe_somewhere').status, 'ignored');

  // 2회차: 브랜드 글의 릴레이 일정 → 다음 인플루언서들의 공구 + 후보
  const r2 = await runCollection({ store, client, today: TODAY, budget: 10 });
  const deals = store.listDeals({ today: TODAY, status: 'all' });
  const byHandle = Object.groupBy(deals, (d) => d.handle);
  assert.ok(byHandle.twins_daddy_x?.some((d) => d.start_date === '2026-11-13'), '브랜드 일정에서 다음 공구 발견');
  assert.ok(byHandle.new_mom_y?.some((d) => d.start_date === '2026-11-20'));
  assert.equal(byHandle.mom_seed.length, 1, '시드 본인 글과 브랜드 일정이 겹쳐도 중복 저장 안 함');
  assert.ok(r2.auto_tracked.includes('twins_daddy_x'), '공구 글이 있는 육아 계정은 자동 추적');
  assert.equal(store.getAccount('new_mom_y').status, 'candidate', '근거가 약하면 후보로 남김');

  // 3회차: 새로 추적한 인플루언서 본인 글까지 수집
  await runCollection({ store, client, today: TODAY, budget: 10 });
  const twins = store.listDeals({ today: TODAY, status: 'all', handle: 'twins_daddy_x' });
  assert.ok(twins.some((d) => d.product_name.includes('빨대컵')));

  // 같은 수집을 다시 돌려도 중복이 생기지 않음
  const before = store.count();
  await runCollection({ store, client, today: TODAY, budget: 20 });
  assert.equal(store.count(), before);
});

test('호출 한도 초과 시 즉시 중단, 없는 계정은 표시', async () => {
  const store = openDb(':memory:');
  store.addSeeds(['ghost_account', 'mom_seed']);
  const client = fakeClient(WORLD, { failOn: { mom_seed: new GraphError('Application request limit reached', { code: 4 }) } });
  const r = await runCollection({ store, client, today: TODAY, budget: 10 });
  assert.match(r.stopped, /한도/);
  assert.match(store.getAccount('ghost_account').last_error, /프로페셔널/);
  assert.equal(store.getAccount('ghost_account').status, 'tracked', '사용자가 넣은 시드는 유지');
});

test('Graph 클라이언트: 요청 형식과 응답 변환', async () => {
  let seen;
  const client = createGraphClient({
    userId: '1789', token: 'tok',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ business_discovery: { username: 'Mom_A', biography: 'bio', followers_count: 10, media: { data: [{ caption: 'c', permalink: 'p', timestamp: 't' }] } } }));
    },
  });
  const p = await client.profile('mom_a');
  assert.match(decodeURIComponent(seen.url), /\/1789\?fields=business_discovery\.username\(mom_a\)\{.*media\.limit\(30\)/);
  assert.match(seen.url, /&access_token=tok$/);
  assert.deepEqual(p, { username: 'mom_a', name: '', bio: 'bio', followers: 10, media_count: null, media: [{ caption: 'c', permalink: 'p', timestamp: 't' }] });

  const bad = createGraphClient({ userId: '1', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'expired', code: 190 } }), { status: 400 }) });
  await assert.rejects(bad.profile('x'), (e) => e.authFailed);
});
