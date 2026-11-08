#!/usr/bin/env node
// 공구 자동 수집 + 연관 계정 발굴을 1회 실행한다. (서버도 COLLECT_INTERVAL_MIN 주기로 같은 일을 한다)
// 인스타그램 공식 Graph API(Business Discovery)만 사용한다. 설정 방법은 docs/instagram-setup.md
//
//  IG_USER_ID=... IG_ACCESS_TOKEN=... npm run collect                  # 추적 계정 수집 + 후보 발굴
//  IG_USER_ID=... IG_ACCESS_TOKEN=... npm run collect -- 계정1 계정2    # 시드 계정 추가 후 수집
//  옵션: --budget 100 (API 호출 수), --pending (자동 게시하지 않고 모두 검토 대기)

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { runCollection } from '../src/collector.js';
import { graphClientFromEnv } from '../src/instagram.js';
import { todayKST } from '../public/lib/dates.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const seeds = args.filter((a, i) => !a.startsWith('--') && !['--budget'].includes(args[i - 1]));

  const client = graphClientFromEnv();
  if (!client) {
    console.error('IG_USER_ID(내 인스타 프로페셔널 계정 ID)와 IG_ACCESS_TOKEN 환경변수가 필요해요. docs/instagram-setup.md 참고');
    process.exit(1);
  }
  const store = openDb(process.env.DB_FILE || join(ROOT, 'data', 'gonggu.db'));
  if (seeds.length) console.log('시드 추가:', store.addSeeds(seeds).map((h) => '@' + h).join(' '));
  if (!store.trackedHandles().length) {
    console.error('추적할 계정이 없어요. npm run collect -- <계정아이디> 로 추가하세요.');
    process.exit(1);
  }
  const stats = await runCollection({
    store, client, today: todayKST(),
    budget: Number(opt('--budget') || process.env.COLLECT_BUDGET || 60),
    autoTrackScore: Number(process.env.AUTO_TRACK_SCORE || 5),
    autoPublish: !args.includes('--pending') && process.env.AUTO_PUBLISH !== '0',
    log: (s) => console.log(' ·', s),
  });
  if (stats.deals_added > 0) store.deleteSamples();
  console.log(`\n완료: API ${stats.calls}회, 계정 ${stats.accounts_checked}개 확인`);
  console.log(`  공구 게시 ${stats.deals_added}건, 검토 대기 ${stats.deals_pending}건`);
  console.log(`  새 후보 계정 ${stats.candidates_found}개, 자동 추적 추가 ${stats.auto_tracked.length}개 ${stats.auto_tracked.map((h) => '@' + h).join(' ')}`);
  if (stats.errors.length) console.log(`  오류 ${stats.errors.length}건:\n   ${stats.errors.join('\n   ')}`);
  if (stats.stopped) { console.error(`  중단: ${stats.stopped}`); process.exitCode = 2; }
}

main();
