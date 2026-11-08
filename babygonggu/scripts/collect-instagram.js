#!/usr/bin/env node
// 인스타그램 공식 Graph API(Business Discovery)로 "추적 중인" 인플루언서의 최근 게시물을 읽어
// 공구 글로 보이는 것을 찾아 '검토 대기' 상태로 저장한다. (스크래핑이 아닌 공식 API만 사용)
//
// 필요 조건
//  - 내 인스타그램 프로페셔널(비즈니스/크리에이터) 계정 + 연결된 페이스북 앱
//  - IG_USER_ID: 내 인스타그램 비즈니스 계정 ID
//  - IG_ACCESS_TOKEN: instagram_basic 권한이 있는 장기 액세스 토큰
//  - Business Discovery는 상대 계정도 프로페셔널 계정일 때만 조회 가능 (공구 인플루언서는 대부분 해당)
//
// 사용법
//  IG_USER_ID=... IG_ACCESS_TOKEN=... npm run collect                # DB의 추적 계정 전체
//  IG_USER_ID=... IG_ACCESS_TOKEN=... npm run collect -- mom_a mom_b # 지정 계정 (추적 목록에도 추가)
//  npm run collect -- --dry-run --file sample.json                   # API 없이 JSON 파일로 테스트
//
// cron 예시 (매일 3회):  0 8,13,20 * * *  cd /path/babygonggu && npm run collect

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { parseCaption } from '../public/lib/parser.js';
import { todayKST, daysBetween } from '../public/lib/dates.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GRAPH = 'https://graph.facebook.com/v21.0';
const LOOKBACK_DAYS = 30;

export async function fetchRecentMedia(handle, { userId, token, limit = 25 }) {
  const fields = `business_discovery.username(${handle}){username,media.limit(${limit}){caption,permalink,timestamp}}`;
  const url = `${GRAPH}/${encodeURIComponent(userId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body?.business_discovery?.media?.data ?? [];
}

/** 게시물 목록 → 저장할 공구 후보 */
export function extractDeals(handle, media, today) {
  const out = [];
  for (const m of media) {
    if (!m.caption || !m.permalink) continue;
    const postedOn = (m.timestamp || '').slice(0, 10);
    if (postedOn && daysBetween(postedOn, today) > LOOKBACK_DAYS) continue;
    const p = parseCaption(m.caption, { url: m.permalink, ref: postedOn || today });
    if (!p.is_gonggu || !p.start_date || !p.product_name) continue;
    if ((p.end_date || p.start_date) < today && daysBetween(p.end_date || p.start_date, today) > 3) continue; // 이미 끝난 공구
    out.push({
      handle, post_url: p.post_url || m.permalink, product_name: p.product_name, brand: p.brand,
      category: p.category, start_date: p.start_date, end_date: p.end_date,
      price: p.price, original_price: p.original_price,
    });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : null;
  const handles = args.filter((a, i) => !a.startsWith('--') && !(fileIdx >= 0 && i === fileIdx + 1));
  const store = openDb(process.env.DB_FILE || join(ROOT, 'data', 'gonggu.db'));
  const today = todayKST();

  for (const h of handles) store.setTracked(h, true);
  const targets = handles.length ? handles : store.trackedHandles();

  let media;
  if (file) {
    // { "handle": [ {caption, permalink, timestamp}, ... ] }
    media = JSON.parse(await readFile(file, 'utf8'));
  } else {
    const { IG_USER_ID: userId, IG_ACCESS_TOKEN: token } = process.env;
    if (!userId || !token) {
      console.error('IG_USER_ID, IG_ACCESS_TOKEN 환경변수가 필요해요. (테스트는 --file 사용)');
      process.exit(1);
    }
    if (!targets.length) {
      console.error('추적할 계정이 없어요. npm run collect -- <계정아이디> 로 추가하세요.');
      process.exit(1);
    }
    media = {};
    for (const h of targets) {
      try {
        media[h] = await fetchRecentMedia(h, { userId, token });
      } catch (e) {
        console.warn(`@${h}: 조회 실패 - ${e.message}`);
        media[h] = [];
      }
    }
  }

  let added = 0, skipped = 0;
  for (const [h, list] of Object.entries(media)) {
    for (const d of extractDeals(h, list, today)) {
      if (dry) { console.log('[dry-run]', d); continue; }
      try {
        store.insertDeal(d, { review: 'pending', source: 'instagram' });
        added++;
      } catch {
        skipped++; // 이미 등록된 게시물 등
      }
    }
  }
  console.log(`완료: 새 공구 ${added}건(검토 대기), 건너뜀 ${skipped}건`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
