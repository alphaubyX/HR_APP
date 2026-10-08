'use strict';

/**
 * Date helpers that work on plain strings: dates are 'YYYY-MM-DD', local date-times are
 * 'YYYY-MM-DD HH:MM:SS' in the organization's own time zone. Arithmetic is done in UTC so that
 * daylight-saving changes never shift a day.
 */

const DAY = 86400000;

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function parseDate(s) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmtDate(parseDate(s)) === s;
}

function addDays(s, n) { return fmtDate(new Date(parseDate(s).getTime() + n * DAY)); }

/** Whole days from a to b (b - a). */
function diffDays(a, b) { return Math.round((parseDate(b) - parseDate(a)) / DAY); }

/** ISO weekday: 1 = Monday … 7 = Sunday. */
function weekday(s) { const d = parseDate(s).getUTCDay(); return d === 0 ? 7 : d; }

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function monthOf(s) { return s.slice(0, 7); }

function isMonth(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/**
 * The payroll period for a month. With startDay 1 it's the calendar month; with e.g. 26 the
 * "October" period runs 26 September – 25 October.
 */
function payPeriod(month, startDay = 1) {
  const [y, m] = month.split('-').map(Number);
  if (startDay <= 1) return { start: `${month}-01`, end: `${month}-${pad(daysInMonth(y, m))}` };
  const prev = addMonths(month, -1);
  const [py, pm] = prev.split('-').map(Number);
  const s = Math.min(startDay, daysInMonth(py, pm));
  const e = Math.min(startDay - 1, daysInMonth(y, m));
  return { start: `${prev}-${pad(s)}`, end: `${month}-${pad(e)}` };
}

/** 'HH:MM' → minutes after midnight. */
function hm(s) {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

/** Minutes since the epoch for a local date-time string (treated as UTC, consistently). */
function toMinutes(dt) {
  const [d, t = '00:00:00'] = dt.split(/[ T]/);
  const [h, mi, se = 0] = t.split(':').map(Number);
  return Math.floor(parseDate(d).getTime() / 60000) + h * 60 + mi + Math.floor(se / 60);
}

function fromMinutes(min) {
  const d = new Date(min * 60000);
  return `${fmtDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

/** Current date and time in a time zone, e.g. 'Asia/Karachi'. */
function nowIn(timeZone = 'UTC', at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return nowIn('UTC', at);
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}:${p.second}`;
  return { date, time, datetime: `${date} ${time}` };
}

function isTimeZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** UTC timestamp for the database's created_at style columns. */
function utcNow() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

function utcPlus(ms) { return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' '); }

module.exports = {
  DAY, pad, parseDate, fmtDate, isDate, addDays, diffDays, weekday, eachDay, daysInMonth, monthOf, isMonth,
  addMonths, payPeriod, hm, isTime, toMinutes, fromMinutes, nowIn, isTimeZone, utcNow, utcPlus,
};
