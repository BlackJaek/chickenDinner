import { addDays } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
const d8 = (s) => s.replace(/-/g, '');

/** 공구 목록을 iCalendar(.ics) 문자열로. 구글/애플 캘린더에서 URL 구독 가능 */
export function toICS(deals, { name = '아기 공구 캘린더' } = {}) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//babygonggu//KO', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:Asia/Seoul',
  ];
  for (const d of deals) {
    const title = `[공구] ${d.brand ? d.brand + ' ' : ''}${d.product_name} @${d.handle}`;
    const desc = [
      d.price ? `공구가 ${d.price.toLocaleString('ko-KR')}원` : '',
      d.end_date ? '' : '마감일 미정',
      d.note, d.post_url || `https://www.instagram.com/${d.handle}/`,
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:deal-${d.id}@babygonggu`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${d8(d.start_date)}`,
      `DTEND;VALUE=DATE:${d8(addDays(d.end_date || d.start_date, 1))}`,
      `SUMMARY:${esc(title)}`,
      `DESCRIPTION:${esc(desc)}`,
      `URL:${d.post_url || `https://www.instagram.com/${d.handle}/`}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// RFC5545: 75 octets 단위로 줄 접기 (UTF-8 문자 경계를 지킴)
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
