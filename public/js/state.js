// Shared session state.
import { api } from './api.js';
import { setCurrency } from './ui.js';

export const S = {
  me: null, // /api/me
  lookups: null, // /api/lookups
};

export function can(...perms) {
  return !!S.me && perms.some((p) => S.me.perms.includes(p));
}

export const isManager = () => !!(S.me && S.me.employee && S.me.employee.direct_reports > 0);
export const hasEmployee = () => !!(S.me && S.me.employee);

export async function loadMe() {
  S.me = await api.get('/api/me');
  if (S.me.org) setCurrency(S.me.org.currency);
  return S.me;
}

// After any save the lists are out of date; the next page that needs them reads them again.
let stale = false;
window.addEventListener('hr:data-changed', () => { stale = true; });

export async function loadLookups(force = false) {
  if (!S.lookups || force || stale) {
    stale = false;
    S.lookups = await api.get('/api/lookups');
  }
  return S.lookups;
}

export function lookupName(list, id, fallback = '—') {
  if (!id || !S.lookups) return fallback;
  const x = (S.lookups[list] || []).find((i) => i.id === Number(id));
  return x ? x.name : fallback;
}

export function options(list, { active = true } = {}) {
  return (S.lookups[list] || []).filter((x) => !active || x.active === undefined || x.active).map((x) => [x.id, x.name]);
}

export function employeeOptions({ includeExited = false } = {}) {
  return (S.lookups.employees || []).filter((e) => includeExited || e.status !== 'exited').map((e) => [e.id, `${e.name} · ${e.emp_code}`]);
}

export function navigate(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else window.dispatchEvent(new HashChangeEvent('hashchange'));
}
