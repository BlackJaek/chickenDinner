// 공구 자동 수집 + 연관 계정 발굴(눈덩이 방식).
//
// 1) 추적 중인 계정의 최근 게시물을 읽어 공구 글을 공구 목록에 넣는다.
//    - 인플루언서 글: 그 계정의 공구
//    - 브랜드 글: "11/10 @A, 11/17 @B" 같은 릴레이 일정이면 줄마다 해당 인플루언서의 공구로
// 2) 게시물 속 @언급(주로 브랜드 ↔ 함께 공구하는 인플루언서)을 후보 계정으로 쌓는다.
// 3) 후보 프로필(소개글·최근 글)을 확인해 점수를 매기고, 확실하면 자동으로 추적 대상에 넣는다.
//    → 다음 수집 때 그 계정의 글과 언급을 또 따라가며 계속 넓어진다.

import { parseCaption, parsePeriod, looksLikeGonggu } from '../public/lib/parser.js';
import { daysBetween } from '../public/lib/dates.js';
import { GraphError } from './instagram.js';

const LOOKBACK_DAYS = 45;      // 이보다 오래된 게시물은 보지 않음
const KEEP_ENDED_DAYS = 30;    // 이보다 오래전에 끝난 공구는 저장하지 않음

const PARENT_RE = /맘|엄마|아빠|mom\b|mommy|mama|dad\b|daddy|papa|개월|돌아기|아들|딸|쌍둥이|twins|남매|형제맘|육아일기|육아기록|임산부|임신|출산|\d{2}년생|\d{2}\.\d{1,2}\s*생/i;
const GONGGU_BIO_RE = /공구|공동구매|오픈채팅|오픈톡|카톡방|공구문의|공구\s*일정|협찬|제휴/;
const BRAND_RE = /공식|official|브랜드|brand|스토어|store|shop|샵|몰|mall|주식회사|㈜|\(주\)|고객센터|cs\s*센터|문의\s*:|정품|제조|수입|판매처|스마트스토어|자사몰/i;
const BRAND_HANDLE_RE = /official|_kr$|korea|store|shop|mall|brand|_inc|company|\.co$|_co$|global/i;
const BABY_RE = /아기|아이|유아|영유아|베이비|baby|kids|키즈|이유식|유아식|기저귀|분유|육아|출산|맘|mom|토들러|toddler|신생아/i;

/** 프로필 + 최근 게시물로 계정 종류와 점수 계산 */
export function classifyAccount(profile, { fromGonggu = false } = {}) {
  const bio = `${profile.name || ''} ${profile.bio || ''}`;
  const gongguPosts = profile.media.filter((m) => looksLikeGonggu(m.caption)).length;
  const brandSignals = (BRAND_RE.test(bio) ? 2 : 0) + (BRAND_HANDLE_RE.test(profile.username) ? 1 : 0);
  const parentSignals = PARENT_RE.test(bio) ? 2 : 0;
  const baby = BABY_RE.test(bio) || profile.media.some((m) => BABY_RE.test(m.caption));

  const kind = brandSignals >= 2 && parentSignals === 0 ? 'brand' : parentSignals || gongguPosts ? 'influencer' : brandSignals ? 'brand' : 'unknown';
  let score = 0;
  if (kind === 'influencer') {
    score += parentSignals;
    if (GONGGU_BIO_RE.test(bio)) score += 3;
    score += Math.min(gongguPosts, 3) * 2;
    if (fromGonggu) score += 1;
    if (profile.followers != null && profile.followers < 1000) score -= 2;
  } else if (kind === 'brand') {
    score += baby ? 3 : -2;
    score += Math.min(gongguPosts, 2) * 2;
    if (fromGonggu) score += 1;
  } else {
    score += baby ? 1 : -2;
    score += Math.min(gongguPosts, 2) * 2;
  }
  return { kind, score, gonggu_posts: gongguPosts, baby };
}

/** 점수로 다음 상태 결정 */
export function decideStatus({ kind, score, baby }, { autoTrackScore }) {
  if (score >= autoTrackScore && (kind === 'influencer' || (kind === 'brand' && baby))) return 'tracked';
  if (!baby && score < 0) return 'ignored';
  return 'candidate';
}

function mentionsIn(caption) {
  return [...new Set([...String(caption || '').matchAll(/@([A-Za-z0-9._]{2,30})/g)].map((m) => m[1].toLowerCase().replace(/\.+$/, '')))];
}

function isRecent(m, today) {
  const d = (m.timestamp || '').slice(0, 10);
  return !d || daysBetween(d, today) <= LOOKBACK_DAYS;
}

function worthKeeping(deal, today) {
  const end = deal.end_date || deal.start_date;
  return end >= today || daysBetween(end, today) <= KEEP_ENDED_DAYS;
}

/** 브랜드 글의 릴레이 일정: 줄마다 @계정 + 날짜 */
export function parseSchedule(caption, ref, self) {
  const out = [];
  for (const line of String(caption || '').split('\n')) {
    const handles = mentionsIn(line).filter((h) => h !== self && !BRAND_HANDLE_RE.test(h));
    if (handles.length !== 1) continue;
    const { start, end } = parsePeriod(line, ref);
    if (start) out.push({ handle: handles[0], start_date: start, end_date: end });
  }
  return out;
}

/** 한 계정의 게시물들 → 공구 후보 목록 */
export function dealsFromMedia(account, media, today) {
  const deals = [];
  for (const m of media) {
    if (!m.caption || !m.permalink || !isRecent(m, today)) continue;
    const ref = (m.timestamp || '').slice(0, 10) || today;
    const p = parseCaption(m.caption, { url: m.permalink, ref });
    if (!p.is_gonggu || !p.product_name) continue;
    const base = {
      post_url: p.post_url || m.permalink, product_name: p.product_name, brand: p.brand,
      category: p.category, price: p.price, original_price: p.original_price,
    };
    if (account.kind === 'brand') {
      const schedule = parseSchedule(m.caption, ref, account.handle);
      if (schedule.length) {
        // 일정의 각 줄은 서로 다른 인플루언서 공구. 게시물 링크는 하나라 첫 줄에만 단다(중복 방지 키)
        schedule.forEach((s, i) => deals.push({
          ...base, ...s,
          post_url: i === 0 ? base.post_url : null, note: `@${account.handle} 공구 일정 안내`, confident: true,
        }));
        continue;
      }
      const who = p.mentions.find((h) => h !== account.handle && !BRAND_HANDLE_RE.test(h));
      if (who && p.start_date) {
        deals.push({ ...base, handle: who,
          start_date: p.start_date, end_date: p.end_date, note: `@${account.handle} 게시물에서 발견`, confident: false });
      }
      continue;
    }
    if (!p.start_date) continue;
    deals.push({ ...base, handle: account.handle, start_date: p.start_date, end_date: p.end_date,
      confident: Boolean(p.end_date || p.price) });
  }
  return deals.filter((d) => worthKeeping(d, today));
}

/**
 * 수집 1회 실행.
 * @param {{store, client, today: string, budget?: number, autoTrackScore?: number, autoPublish?: boolean, log?: (s: string) => void}} o
 *  budget: 이번 실행에서 쓸 API 호출 수 (Business Discovery는 시간당 약 200회 한도)
 */
export async function runCollection({ store, client, today, budget = 60, autoTrackScore = 5, autoPublish = true, log = () => {} }) {
  const stats = { calls: 0, accounts_checked: 0, deals_added: 0, deals_pending: 0, candidates_found: 0, auto_tracked: [], errors: [], stopped: null };
  const call = async (handle) => { stats.calls++; return client.profile(handle); };

  const handleError = (acc, e) => {
    if (!(e instanceof GraphError)) {
      stats.stopped = `인스타그램 API에 연결하지 못했어요: ${e.message}`;
      return true;
    }
    if (e.rateLimited || e.authFailed) {
      stats.stopped = e.authFailed ? `토큰 오류: ${e.message}` : `호출 한도 초과: ${e.message}`;
      return true;
    }
    if (e.notFound) store.markAccountError(acc.handle, '프로페셔널 계정이 아니거나 없는 계정이라 API로 볼 수 없어요.', acc.status === 'tracked' ? null : 'unreachable');
    else store.markAccountError(acc.handle, e.message);
    stats.errors.push(`@${acc.handle}: ${e.message}`);
    return false;
  };

  const tracked = store.dueTracked(Math.max(1, Math.ceil(budget * 0.6)));
  for (const acc of tracked) {
    if (stats.calls >= budget || stats.stopped) break;
    let profile;
    try { profile = await call(acc.handle); } catch (e) { if (handleError(acc, e)) break; continue; }
    stats.accounts_checked++;
    const c = classifyAccount(profile);
    // 사용자가 넣은 계정의 종류는 존중하되, 브랜드 신호가 확실하면 브랜드로
    const kind = acc.kind !== 'unknown' ? acc.kind : c.kind;
    store.updateAccountProfile(acc.handle, { ...profile, kind, score: c.score, gonggu_posts: c.gonggu_posts });
    const account = { ...acc, kind, name: profile.name };

    for (const d of dealsFromMedia(account, profile.media, today)) {
      if (d.post_url && store.hasPost(d.post_url)) continue;
      if (store.hasDeal(d.handle, d.product_name, d.start_date)) continue;
      const { confident, ...input } = d;
      const review = autoPublish && confident ? 'published' : 'pending';
      try {
        store.insertDeal(input, { review, source: 'instagram' });
        if (review === 'published') stats.deals_added++; else stats.deals_pending++;
        if (d.handle !== acc.handle && store.addCandidate(d.handle, acc.handle)) stats.candidates_found++;
      } catch { /* 중복·검증 실패는 건너뜀 */ }
    }
    for (const m of profile.media) {
      if (!isRecent(m, today)) continue;
      const g = looksLikeGonggu(m.caption);
      for (const h of mentionsIn(m.caption)) {
        if (h === acc.handle) continue;
        store.recordMention(acc.handle, h, m.permalink || '', g);
        if (store.addCandidate(h, acc.handle)) stats.candidates_found++;
      }
    }
    log(`@${acc.handle} 확인 (${kind}, 게시물 ${profile.media.length}개)`);
  }

  // 남은 호출로 후보 계정 프로필 확인 → 자동 추적/무시 결정
  const left = budget - stats.calls;
  for (const acc of stats.stopped || left <= 0 ? [] : store.uncheckedCandidates(left)) {
    if (stats.calls >= budget || stats.stopped) break;
    let profile;
    try { profile = await call(acc.handle); } catch (e) { if (handleError(acc, e)) break; continue; }
    stats.accounts_checked++;
    const fromGonggu = store.db.prepare('SELECT 1 FROM mentions WHERE to_handle = ? AND is_gonggu = 1 LIMIT 1').get(acc.handle) != null;
    const c = classifyAccount(profile, { fromGonggu });
    store.updateAccountProfile(acc.handle, { ...profile, ...c });
    const next = decideStatus(c, { autoTrackScore });
    if (next !== 'candidate') store.setAccountStatus(acc.handle, next);
    if (next === 'tracked') stats.auto_tracked.push(acc.handle);
    log(`후보 @${acc.handle}: ${c.kind}, 점수 ${c.score} → ${next}`);
  }
  return stats;
}
