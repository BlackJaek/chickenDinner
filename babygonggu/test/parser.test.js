import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCaption, parsePeriod, parsePrices, parseInstagramUrl, guessCategory } from '../public/lib/parser.js';

const REF = '2026-11-08';

test('기간: 슬래시 + 요일 + 시간', () => {
  assert.deepEqual(parsePeriod('📅 11/10(월) 오전 10시 ~ 11/14(금) 자정', REF), { start: '2026-11-10', end: '2026-11-14' });
});

test('기간: "11월 12일 ~ 16일" 같은 달 생략형', () => {
  assert.deepEqual(parsePeriod('11월 12일 ~ 16일까지만 진행해요', REF), { start: '2026-11-12', end: '2026-11-16' });
});

test('기간: 점 표기 + 연말연초 연도 넘김', () => {
  assert.deepEqual(parsePeriod('12.28 오픈 예정\n마감은 1.3(토)', REF), { start: '2026-12-28', end: '2027-01-03' });
});

test('기간: 연도 포함 하이픈 범위', () => {
  assert.deepEqual(parsePeriod('2026.11.01 - 2026.11.05 진행', REF), { start: '2026-11-01', end: '2026-11-05' });
});

test('기간: 시작일만 있으면 마감 미정', () => {
  assert.deepEqual(parsePeriod('11/20 오픈합니다! 재고 소진 시 마감', REF), { start: '2026-11-20', end: null });
});

test('기간: 용량·가격·전화번호는 날짜로 오인하지 않음', () => {
  assert.deepEqual(parsePeriod('로션 1.5kg 29.900원 문의 010-1234-5678', REF), { start: null, end: null });
});

test('가격: 정가 → 공구가', () => {
  assert.deepEqual(parsePrices('정가 39,000원 → 공구가 29,900원'), { price: 29900, original_price: 39000 });
});

test('가격: 만/천 표기', () => {
  assert.deepEqual(parsePrices('단돈 2만9천원!'), { price: 29000, original_price: null });
});

test('가격: 키워드 없으면 최저가가 공구가, 최고가가 정가', () => {
  assert.deepEqual(parsePrices('45,000원 → 36,000원'), { price: 36000, original_price: 45000 });
});

test('인스타 URL 정규화 및 계정 추출', () => {
  assert.deepEqual(parseInstagramUrl('https://www.instagram.com/p/ABC123/?igsh=xyz'), { post_url: 'https://www.instagram.com/p/ABC123/', handle: '' });
  assert.deepEqual(parseInstagramUrl('instagram.com/Mom_Jiyu/reel/XYZ_9'), { post_url: 'https://www.instagram.com/reel/XYZ_9/', handle: 'mom_jiyu' });
  assert.deepEqual(parseInstagramUrl('https://example.com/p/abc'), { post_url: '', handle: '' });
});

test('카테고리 추정', () => {
  assert.equal(guessCategory('팬티형 기저귀 4단계'), '기저귀·물티슈');
  assert.equal(guessCategory('한우 큐브 이유식'), '이유식·간식');
  assert.equal(guessCategory('실리콘 빨대컵'), '수유·식기');
});

test('캡션 전체 파싱', () => {
  const p = parseCaption(`🍼 [예시 한우 큐브 이유식] 공구 오픈 안내 🍼
📅 11/10(월) 오전 10시 ~ 11/14(금) 자정
정가 39,000원 → 공구가 29,900원 (23% 할인)
@example_brand 감사합니다`, { url: 'https://www.instagram.com/p/ABC/', ref: REF });
  assert.equal(p.product_name, '예시 한우 큐브 이유식');
  assert.equal(p.start_date, '2026-11-10');
  assert.equal(p.end_date, '2026-11-14');
  assert.equal(p.price, 29900);
  assert.equal(p.original_price, 39000);
  assert.equal(p.category, '이유식·간식');
  assert.deepEqual(p.mentions, ['example_brand']);
  assert.equal(p.is_gonggu, true);
});

test('제품명: 용량 표기는 유지, 가격·전화번호는 제거', () => {
  assert.equal(parseCaption('앵콜 공구!! 무향 수딩 로션 1.5kg 대용량\n11/12~16', { ref: REF }).product_name, '무향 수딩 로션 1.5kg 대용량');
  assert.equal(parseCaption('기저귀 공구 판매가 45,000원 문의 010-1234-5678', { ref: REF }).product_name, '기저귀');
});
