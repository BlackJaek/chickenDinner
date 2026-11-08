// 서버와 브라우저에서 함께 쓰는 날짜 유틸. 날짜는 모두 'YYYY-MM-DD' 문자열(한국 시간 기준).

export const OPEN_ENDED_DAYS = 14; // 마감일 미정 공구는 시작 후 이 기간까지 진행중으로 간주

export function todayKST(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toDateStr(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function effectiveEnd(deal) {
  return deal.end_date || addDays(deal.start_date, OPEN_ENDED_DAYS);
}

/** 'ongoing' | 'upcoming' | 'ended' */
export function dealStatus(deal, today) {
  if (deal.start_date > today) return 'upcoming';
  if (effectiveEnd(deal) < today) return 'ended';
  return 'ongoing';
}

/** 진행중이면 마감까지, 예정이면 오픈까지 남은 일수. 종료면 null */
export function dday(deal, today) {
  const st = dealStatus(deal, today);
  if (st === 'upcoming') return daysBetween(today, deal.start_date);
  if (st === 'ongoing') return deal.end_date ? daysBetween(today, deal.end_date) : null;
  return null;
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function fmtDate(s, withYear = false) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${withYear ? y + '.' : ''}${m}.${d}(${w})`;
}
