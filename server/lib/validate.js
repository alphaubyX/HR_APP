'use strict';

const { isDate, isTime, isMonth } = require('./dates');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);
const forbidden = (msg = 'You are not allowed to do that.') => new HttpError(403, msg);
const notFound = (what = 'Item') => new HttpError(404, `${what} not found.`);

function label(field) {
  return field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Field converters. Each takes (value, field, opts) and returns the clean value, null for an empty
 * optional value, or throws a 400 error with a readable message.
 */
const types = {
  str(v, f, { max = 200, required, oneOf } = {}) {
    if (empty(v)) { if (required) throw bad(`${label(f)} is required.`); return null; }
    if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${label(f)} must be text.`);
    const s = String(v).trim();
    if (s.length > max) throw bad(`${label(f)} is too long (at most ${max} characters).`);
    if (oneOf && !oneOf.includes(s)) throw bad(`${label(f)} must be one of: ${oneOf.join(', ')}.`);
    return s;
  },
  int(v, f, { min = -2147483648, max = 2147483647, required } = {}) {
    if (empty(v)) { if (required) throw bad(`${label(f)} is required.`); return null; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label(f)} must be a whole number between ${min} and ${max}.`);
    return n;
  },
  num(v, f, { min = -1e12, max = 1e12, required } = {}) {
    if (empty(v)) { if (required) throw bad(`${label(f)} is required.`); return null; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label(f)} must be a number between ${min} and ${max}.`);
    return n;
  },
  money(v, f, opts = {}) {
    const n = types.num(v, f, { min: 0, max: 1e11, ...opts });
    return n === null ? null : Math.round(n * 100) / 100;
  },
  bool(v) { return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0; },
  date(v, f, { required } = {}) {
    if (empty(v)) { if (required) throw bad(`${label(f)} is required.`); return null; }
    if (!isDate(v)) throw bad(`${label(f)} must be a date (YYYY-MM-DD).`);
    return v;
  },
  time(v, f, { required } = {}) {
    if (empty(v)) { if (required) throw bad(`${label(f)} is required.`); return null; }
    if (!isTime(v)) throw bad(`${label(f)} must be a time (HH:MM).`);
    return v;
  },
  month(v, f, { required } = {}) {
    if (empty(v)) { if (required) throw bad(`${label(f)} is required.`); return null; }
    if (!isMonth(v)) throw bad(`${label(f)} must be a month (YYYY-MM).`);
    return v;
  },
  email(v, f, { required } = {}) {
    const s = types.str(v, f, { max: 150, required });
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${label(f)} is not a valid email address.`);
    return s ? s.toLowerCase() : s;
  },
  id(v, f, { required } = {}) { return types.int(v, f, { min: 1, required }); },
};

/**
 * Read the fields listed in spec from body. spec = { field: ['type', opts] }.
 * A field missing from body is left out of the result (so the database default applies), unless it
 * is required (error) or has opts.default. With partial = true (updates), missing fields are always
 * left out. A field sent empty becomes null (to clear it).
 */
function pick(body, spec, { partial = false } = {}) {
  const out = {};
  body = body || {};
  for (const [field, [type, opts = {}]] of Object.entries(spec)) {
    const fn = types[type];
    if (!fn) throw new Error(`Unknown field type ${type}`);
    if (!(field in body)) {
      if (partial) continue;
      if (opts.default !== undefined) { out[field] = opts.default; continue; }
      if (opts.required) fn(undefined, field, opts); // throws "… is required"
      continue;
    }
    const value = fn(body[field], field, opts);
    out[field] = value === null && opts.default !== undefined ? opts.default : value;
  }
  return out;
}

module.exports = { HttpError, bad, forbidden, notFound, types, pick, empty };
