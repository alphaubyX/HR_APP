'use strict';

/** Leave years, day counting and allocations: pure helpers. */

const { addDays, diffDays, eachDay, pad } = require('../lib/dates');
const { shiftForDay } = require('./attendance');

/** The leave year a date falls in. With startMonth 1 it's the calendar year; with 7 (July) 2026-03-01 is in 2025. */
function leaveYearOf(date, startMonth = 1) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= startMonth ? y : y - 1;
}

function leaveYearRange(year, startMonth = 1) {
  const start = `${year}-${pad(startMonth)}-01`;
  const end = addDays(`${year + 1}-${pad(startMonth)}-01`, -1);
  return { start, end };
}

function leaveYearLabel(year, startMonth = 1) {
  return startMonth === 1 ? String(year) : `${year}–${String(year + 1).slice(2)}`;
}

/**
 * Working days a leave takes. Weekends and holidays are skipped unless the leave type counts them
 * (the "sandwich" setting). A half-day leave is always 0.5.
 */
function countLeaveDays({ from, to, half = 'none', shift, holidayDates = new Set(), countOffDays = false }) {
  if (half !== 'none') return 0.5;
  let days = 0;
  for (const d of eachDay(from, to)) {
    if (countOffDays) { days++; continue; }
    if (shift && shiftForDay(shift, d).off) continue;
    if (holidayDates.has(d)) continue;
    days++;
  }
  return days;
}

/** Yearly entitlement, reduced for someone who joins during the leave year. Rounded to half days. */
function allocationFor(type, joinDate, year, startMonth = 1) {
  const quota = Number(type.annual_quota) || 0;
  if (!quota) return 0;
  const { start, end } = leaveYearRange(year, startMonth);
  if (joinDate > end) return 0;
  if (!type.prorate_on_join || joinDate <= start) return quota;
  const total = diffDays(start, end) + 1;
  const remaining = diffDays(joinDate, end) + 1;
  return Math.round((quota * remaining / total) * 2) / 2;
}

module.exports = { leaveYearOf, leaveYearRange, leaveYearLabel, countLeaveDays, allocationFor };
