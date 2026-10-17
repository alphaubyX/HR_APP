// Boot, sign-in, the app shell and the router.
import { api } from './api.js';
import { S, can, isManager, hasEmployee, loadMe, loadLookups, navigate } from './state.js';
import {
  h, clear, icon, avatar, toast, errorToast, modal, popMenu, spinner, buildForm, alertBox, ago, initials,
} from './ui.js';

const root = document.getElementById('app');

/* ------------------------------------------------------------------ theme */
const THEME_KEY = 'bwhr-theme';
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function savedTheme() { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } }
applyTheme(savedTheme());

/* ------------------------------------------------------------------ routes */
const ROUTES = [
  ['dashboard', () => import('./pages/dashboard.js')],
  ['me', () => import('./pages/me.js')],
  ['me/:tab', () => import('./pages/me.js')],
  ['approvals', () => import('./pages/approvals.js')],
  ['employees', () => import('./pages/employees.js')],
  ['employees/new', () => import('./pages/employeeForm.js')],
  ['employees/:id/edit', () => import('./pages/employeeForm.js')],
  ['employees/:id', () => import('./pages/employee.js')],
  ['employees/:id/:tab', () => import('./pages/employee.js')],
  ['organogram', () => import('./pages/organogram.js')],
  ['attendance', () => import('./pages/attendance.js')],
  ['attendance/:tab', () => import('./pages/attendance.js')],
  ['leave', () => import('./pages/leave.js')],
  ['leave/:tab', () => import('./pages/leave.js')],
  ['payroll', () => import('./pages/payroll.js')],
  ['payroll/:id', () => import('./pages/payrollRun.js')],
  ['payslips/:id', () => import('./pages/payslip.js')],
  ['money', () => import('./pages/money.js')],
  ['money/:tab', () => import('./pages/money.js')],
  ['reports', () => import('./pages/reports.js')],
  ['settings', () => import('./pages/settings.js')],
  ['settings/:tab', () => import('./pages/settings.js')],
  ['platform', () => import('./pages/platform.js')],
  ['recruitment', () => import('./pages/recruitment.js')],
  ['recruitment/:id', () => import('./pages/recruitment.js')],
];

function match(path) {
  const parts = path.split('/').filter(Boolean);
  for (const [pattern, load] of ROUTES) {
    const pp = pattern.split('/');
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { load, params, pattern };
  }
  return null;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, q = ''] = raw.split('?');
  return { path: path || defaultPath(), query: Object.fromEntries(new URLSearchParams(q)) };
}

function defaultPath() {
  if (!S.me || !S.me.org) return S.me && S.me.user.is_owner ? 'platform' : 'dashboard';
  const staff = can('employees.view', 'payroll.view', 'attendance.view', 'leave.view') || isManager();
  return staff ? 'dashboard' : 'me';
}

/* ------------------------------------------------------------------ navigation */
function navItems() {
  const items = [];
  const g = (label, list) => { const l = list.filter(Boolean); if (l.length) items.push({ label, items: l }); };
  const staff = can('employees.view', 'payroll.view', 'attendance.view', 'leave.view');
  g(null, [
    { path: 'dashboard', label: 'Dashboard', icon: 'home', show: staff || isManager() },
    (S.approvals > 0 || isManager() || can('leave.manage', 'attendance.manage', 'employees.edit', 'salary.edit', 'org.manage', 'workflows.manage')) && { path: 'approvals', label: 'Approvals', icon: 'inbox', count: S.approvals },
  ].filter((x) => x && x.show !== false));
  if (hasEmployee()) {
    g('My space', [
      { path: 'me', label: 'Check in / out', icon: 'finger' },
      { path: 'me/attendance', label: 'My attendance', icon: 'clock' },
      { path: 'me/leave', label: 'My leave', icon: 'calendar' },
      { path: 'me/payslips', label: 'My payslips', icon: 'banknote' },
      { path: 'me/profile', label: 'My profile', icon: 'user' },
    ]);
  }
  g('People', [
    (can('employees.view') || isManager()) && { path: 'employees', label: 'People', icon: 'users' },
    (can('employees.view') || hasEmployee()) && { path: 'organogram', label: 'Organogram', icon: 'org' },
    can('recruitment.manage') && { path: 'recruitment', label: 'Recruitment', icon: 'briefcase' },
  ]);
  g('Time', [
    (can('attendance.view') || isManager()) && { path: 'attendance', label: 'Attendance', icon: 'clock' },
    (can('leave.view') || isManager()) && { path: 'leave', label: 'Leave', icon: 'calendar' },
    !can('leave.view') && !isManager() && hasEmployee() && { path: 'leave/calendar', label: 'Holidays & team', icon: 'calendar' },
  ]);
  g('Pay', [
    can('payroll.view') && { path: 'payroll', label: 'Payroll', icon: 'wallet' },
    can('salary.view') && { path: 'money', label: 'Loans & adjustments', icon: 'coins' },
  ]);
  g('Insights', [can('reports.view') && { path: 'reports', label: 'Reports', icon: 'chart' }]);
  g('Admin', [
    can('org.manage', 'users.manage', 'salary.view') && { path: 'settings', label: 'Settings', icon: 'settings' },
    S.me.user.is_owner && { path: 'platform', label: 'All organizations', icon: 'building' },
  ]);
  return items;
}

function isActive(itemPath, current) {
  if (itemPath === current) return true;
  if (itemPath === 'me') return false;
  return current.startsWith(`${itemPath}/`) && !navItems().some((g) => g.items.some((i) => i.path !== itemPath && current.startsWith(i.path) && i.path.length > itemPath.length));
}

let shell = null;

function buildShell() {
  const side = h('aside', { class: 'side' });
  const top = h('header', { class: 'topbar' });
  const content = h('main', { class: 'content', id: 'content' });
  const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Quick navigation' });
  const el = h('div', { class: 'shell' }, side, h('div', { class: 'main' }, top, content), bottom);
  clear(root, el);
  shell = { el, side, top, content, bottom };
  el.addEventListener('click', (e) => { if (e.target === el && el.classList.contains('nav-open')) el.classList.remove('nav-open'); });
  drawShell();
}

function orgLogo(org) {
  return h('span', { class: 'org-logo' }, org && org.logo ? h('img', { src: org.logo, alt: '' }) : initials(org ? org.name : '?'));
}

function drawShell() {
  if (S.me && S.me.brand) setBrand(S.me.brand);
  const { path } = parseHash();
  const me = S.me;
  clear(shell.side,
    h('div', { class: 'side-head' },
      brandMark(),
      me.org ? h('button', { class: 'org-switch', type: 'button', onclick: (e) => orgMenu(e.currentTarget) },
        orgLogo(me.org), h('div', { class: 'grow' }, h('div', { class: 'ellipsis strong' }, me.org.name), h('div', { class: 'tiny', style: { color: '#94a3b8' } }, me.support ? 'Support access' : me.roleLabel)),
        me.orgs.length > 1 || me.user.is_owner ? icon('down', 14) : null) : null),
    h('nav', { class: 'side-nav' }, navItems().map((grp) => h('div', { class: 'nav-group' },
      grp.label ? h('div', { class: 'nav-label' }, grp.label) : null,
      grp.items.map((it) => h('a', { class: ['nav-item', isActive(it.path, path) && 'active'], href: `#/${it.path}`, onclick: () => shell.el.classList.remove('nav-open') },
        icon(it.icon, 18), h('span', null, it.label), it.count ? h('span', { class: 'nav-count' }, it.count) : null))))),
    h('div', { class: 'side-foot' },
      h('a', { class: 'nav-item', href: '#', onclick: (e) => { e.preventDefault(); signOut(); } }, icon('logout', 18), h('span', null, 'Sign out'))));

  openSearch = null;
  const searchBox = can('employees.view') || isManager() ? employeeSearch() : null;
  clear(shell.top,
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onclick: () => shell.el.classList.toggle('nav-open') }, icon('menu')),
    h('a', { class: 'topbar-brand', href: '#/', 'aria-label': 'Broadwing HR' }, wingImg(), h('span', { class: 'brand-name' }, 'HR')),
    h('div', { class: 'spacer' }), searchBox,
    h('button', { class: 'icon-btn', title: 'Theme', 'aria-label': 'Change theme', onclick: (e) => themeMenu(e.currentTarget) }, icon(document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun')),
    h('button', { class: 'icon-btn', title: 'Notifications', 'aria-label': 'Notifications', onclick: (e) => notifications(e.currentTarget) },
      icon('bell'), me.unread ? h('span', { class: 'dot' }, me.unread > 9 ? '9+' : me.unread) : null),
    h('button', { class: 'user-chip', onclick: (e) => userMenu(e.currentTarget) }, avatar(me.employee ? me.employee.name : me.user.name, { size: 'sm', photo: me.employee && me.employee.photo }),
      h('span', { class: 'hide-sm strong small' }, me.user.name), icon('down', 14)));

  const quick = hasEmployee()
    ? [['me', 'Check in', 'finger'], ['me/attendance', 'Attendance', 'clock'], ['me/leave', 'Leave', 'calendar'], ['me/payslips', 'Payslips', 'banknote'],
      can('employees.view') || isManager() ? ['dashboard', 'More', 'home'] : ['me/profile', 'Me', 'user']]
    : [['dashboard', 'Home', 'home'], ['employees', 'People', 'users'], ['attendance', 'Time', 'clock'], ['leave', 'Leave', 'calendar'], ['settings', 'Settings', 'settings']];
  clear(shell.bottom, quick.map(([p, l, ic]) => h('a', { href: `#/${p}`, class: p === path ? 'on' : '' }, icon(ic, 20), l)));
}

/*
 * The Broadwing logos. The server owner uploads the original artwork (All organizations →
 * Branding); until then the built-in wing is used. On the blue bars the logos are shown in white.
 */
let brand = { mark: false, horizontal: false, logo: false, v: 0 };
function setBrand(b) {
  if (!b) return;
  brand = b;
  const link = document.querySelector('link[rel="icon"]');
  if (link && b.mark) { link.href = `/brand/mark?v=${b.v}`; link.removeAttribute('type'); }
}
const brandSrc = (slot) => `/brand/${slot}?v=${brand.v}`;
// the white wing for the blue phone bar: Broadwing's own, or the uploaded wing shown in white
const wingImg = () => (brand.mark ? h('img', { class: 'on-dark', src: brandSrc('mark'), alt: '' }) : h('img', { src: '/img/brand/wing-white.png', alt: '' }));

/** The white Broadwing logo on the blue bar, as on broadwing.one. big = the sign-in page. */
function brandMark(big = false) {
  return h('div', { class: ['brand', big && 'brand-big'] }, h('img', { class: 'brand-wide', src: brandSrc('horizontal'), alt: 'Broad Wing' }), h('span', { class: 'brand-name' }, h('b', null, 'HR')));
}

// "/" anywhere opens the person finder of the current top bar
let openSearch = null;
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && openSearch && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
});

/** A search button in the top bar; the box opens only when you want to find someone. */
function employeeSearch() {
  const input = h('input', { placeholder: 'Find a person…', 'aria-label': 'Find a person' });
  const results = h('div', { class: 'search-results hidden' });
  const box = h('label', { class: 'search search-pop hidden' }, icon('search', 16), input, h('span', { class: 'kbd hide-sm' }, 'Esc'), results);
  const close = () => { box.classList.add('hidden'); results.classList.add('hidden'); input.value = ''; };
  openSearch = () => { box.classList.remove('hidden'); input.focus(); };
  let sel = 0;
  let list = [];
  const go = (e) => { close(); navigate(`/employees/${e.id}`); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !S.lookups) { results.classList.add('hidden'); return; }
    list = S.lookups.employees.filter((e) => `${e.name} ${e.emp_code}`.toLowerCase().includes(q)).slice(0, 8);
    sel = Math.min(sel, Math.max(0, list.length - 1));
    clear(results, list.length ? list.map((e, i) => h('a', { href: `#/employees/${e.id}`, class: i === sel ? 'sel' : '', onmousedown: (ev) => { ev.preventDefault(); go(e); } },
      avatar(e.name, { size: 'sm', photo: e.has_photo, id: e.id }), h('div', null, h('div', { class: 'strong' }, e.name), h('div', { class: 'tiny muted' }, e.emp_code))))
      : h('div', { class: 'muted small', style: { padding: '8px' } }, 'No one found.'));
    results.classList.remove('hidden');
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('focus', () => loadLookups().then(draw));
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(list.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && list[sel]) go(list[sel]);
    if (e.key === 'Escape') input.blur();
  });
  return h('div', { class: 'search-wrap' },
    h('button', { class: 'icon-btn', type: 'button', title: 'Find a person (/)', 'aria-label': 'Find a person', onclick: () => openSearch() }, icon('search')),
    box);
}

function orgMenu(anchor) {
  const me = S.me;
  popMenu(anchor, [
    { head: 'Switch organization' },
    ...me.orgs.map((o) => ({
      label: `${o.name}${o.id === me.org.id ? '  ✓' : ''}${o.status === 'suspended' ? ' (suspended)' : ''}`, icon: 'building',
      onClick: async () => { if (o.id === me.org.id) return; await api.post('/api/me/org', { orgId: o.id }); location.hash = ''; location.reload(); },
    })),
    me.user.is_owner ? '-' : null,
    me.user.is_owner ? { label: 'All organizations', icon: 'settings', onClick: () => navigate('/platform') } : null,
  ]);
}

function themeMenu(anchor) {
  const set = (t) => { try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ } applyTheme(t); drawShell(); };
  popMenu(anchor, [{ label: 'Light', icon: 'sun', onClick: () => set('light') }, { label: 'Dark', icon: 'moon', onClick: () => set('dark') }, { label: 'Same as device', icon: 'device', onClick: () => set('auto') }]);
}

function userMenu(anchor) {
  popMenu(anchor, [
    { head: `${S.me.user.name} · @${S.me.user.username}` },
    hasEmployee() ? { label: 'My profile', icon: 'user', onClick: () => navigate('/me/profile') } : null,
    { label: 'Account & password', icon: 'lock', onClick: accountDialog },
    '-',
    { label: 'Sign out', icon: 'logout', danger: true, onClick: signOut },
  ]);
}

async function notifications(anchor) {
  const list = await api.get('/api/notifications');
  const items = list.length ? list.slice(0, 12).map((n) => ({ label: `${n.read_at ? '' : '● '}${n.title} · ${ago(n.created_at)}`, icon: 'bell', onClick: () => { if (n.link) location.hash = n.link.replace(/^#/, ''); } }))
    : [{ head: 'No notifications yet.' }];
  popMenu(anchor, [{ head: 'Notifications' }, ...items]);
  if (S.me.unread) { await api.post('/api/notifications/read'); S.me.unread = 0; drawShell(); }
}

function accountDialog() {
  const profile = buildForm([
    { name: 'name', label: 'Your name', required: true },
    { name: 'email', label: 'Email (you can sign in with it too)', type: 'email' },
  ], { name: S.me.user.name, email: S.me.user.email }, { one: true });
  const pw = buildForm([
    { name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' },
    { name: 'password', label: 'New password (8 or more characters)', type: 'password', autocomplete: 'new-password' },
  ], {}, { one: true });
  const m = modal({
    title: 'Account', body: h('div', null, profile.el, h('h3', { class: 'mt-24 mb-8' }, 'Change password'), pw.el),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api.put('/api/me', profile.values());
          const p = pw.values();
          if (p.password) await api.put('/api/me/password', p);
          await loadMe(); drawShell(); m.close(); toast('Saved');
        } catch (err) { errorToast(err); }
      },
    }, 'Save')],
  });
}

async function signOut() {
  try { await api.post('/api/logout'); } catch { /* already out */ }
  S.me = null; S.lookups = null;
  location.hash = '';
  showLogin();
}

/* ------------------------------------------------------------------ router */
let renderSeq = 0;
async function route() {
  if (!S.me) return;
  if (!shell) buildShell();
  const { path, query } = parseHash();
  const m = match(path);
  drawShell();
  const seq = ++renderSeq;
  const view = h('div');
  clear(shell.content, spinner());
  shell.content.classList.toggle('wide', path === 'organogram' || path.startsWith('attendance'));
  window.scrollTo(0, 0);
  if (!m) { clear(shell.content, h('div', { class: 'empty' }, h('h3', null, 'Page not found'), h('a', { href: '#/' }, 'Go to the start page'))); return; }
  try {
    const mod = await m.load();
    if (S.me.org) await loadLookups(); // reads them again only after a change
    if (seq !== renderSeq) return;
    await mod.default(view, m.params, query, { refreshShell: refreshCounts });
    if (seq !== renderSeq) return;
    clear(shell.content, view);
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    clear(shell.content, h('div', { class: 'card' }, h('div', { class: 'card-body' }, alertBox(err.message || 'Something went wrong.', 'bad', 'alert'))));
  }
}

async function refreshCounts() {
  try {
    const d = await api.get('/api/me');
    S.me = d;
    const counts = await api.get('/api/dashboard').catch(() => null);
    if (counts) S.approvals = counts.approvals.leave + counts.approvals.corrections + (counts.approvals.requests || 0);
    drawShell();
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ sign-in */
async function showLogin() {
  shell = null;
  const status = await api.get('/api/setup').catch(() => ({ needsSetup: false, signup: false }));
  setBrand(status.brand);
  const mode = status.needsSetup ? 'setup' : location.hash === '#signup' && status.signup ? 'signup' : 'login';
  const box = h('div', { class: 'auth-box' });
  const feats = [['users', 'Employees & onboarding'], ['org', 'Drag-and-drop organogram'], ['calendar', 'Leave with approvals'], ['finger', 'Machine & mobile attendance'], ['pin', 'Geofenced check-in'], ['wallet', 'Payroll & payslips']];
  clear(root, h('div', { class: 'auth' },
    h('div', { class: 'auth-art' },
      brandMark(true),
      h('div', null, h('h1', null, 'Your people, time and payroll in one place.'), h('p', null, 'From onboarding and probation to attendance, leave approvals and payslips — built for growing teams.')),
      h('div', { class: 'auth-feats' }, feats.map(([i, t]) => h('div', { class: 'auth-feat' }, icon(i, 18), t)))),
    h('div', { class: 'auth-form' }, h('div', { class: 'auth-col' }, h('img', { class: 'auth-logo', src: brandSrc('logo'), alt: 'Broad Wing' }), box))));

  const err = h('div');
  const showErr = (e) => clear(err, h('div', { class: 'mt-16' }, alertBox(e.message, 'bad', 'alert')));
  if (mode === 'login') {
    const f = buildForm([
      { name: 'username', label: 'Username or email', required: true, autocomplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' },
    ], {}, { one: true });
    const btn = h('button', { class: 'btn primary block lg mt-16', type: 'submit' }, 'Sign in');
    const submit = async (e) => {
      e.preventDefault();
      if (!f.validate()) return;
      btn.disabled = true;
      try { await api.post('/api/login', f.values()); await start(); } catch (x) { showErr(x); btn.disabled = false; }
    };
    f.el.addEventListener('submit', submit);
    f.el.append(h('div', { class: 'full' }, btn));
    clear(box, h('h2', null, 'Welcome back'), h('p', { class: 'muted mb-16' }, 'Sign in to your organization.'), f.el, err,
      status.signup ? h('p', { class: 'muted mt-24 center' }, 'New company? ', h('a', { href: '#signup', onclick: () => setTimeout(showLogin) }, 'Create your HR workspace')) : null);
  } else {
    const fields = [
      { name: 'org_name', label: 'Company name', required: true },
      { name: 'name', label: 'Your name', required: true },
      mode === 'signup' ? { name: 'email', label: 'Work email', type: 'email', required: true } : null,
      { name: 'username', label: 'Username', required: true, help: '3–40 letters, numbers, dots or dashes.', autocomplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', required: true, help: 'At least 8 characters.', autocomplete: 'new-password' },
    ].filter(Boolean);
    const f = buildForm(fields, {}, { one: true });
    const btn = h('button', { class: 'btn primary block lg mt-16', type: 'submit' }, mode === 'setup' ? 'Set up Broadwing HR' : 'Create workspace');
    f.el.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!f.validate()) return;
      btn.disabled = true;
      try { await api.post(mode === 'setup' ? '/api/setup' : '/api/signup', f.values()); location.hash = ''; await start(); } catch (x) { showErr(x); btn.disabled = false; }
    });
    f.el.append(h('div', { class: 'full' }, btn));
    clear(box, h('h2', null, mode === 'setup' ? 'Welcome! Let’s set up' : 'Create your HR workspace'),
      h('p', { class: 'muted mb-16' }, mode === 'setup' ? 'Create the owner account and your first organization. You can add more organizations later.' : 'Free to start. You will be the administrator.'),
      f.el, err, mode === 'signup' ? h('p', { class: 'muted mt-24 center' }, 'Already have an account? ', h('a', { href: '#', onclick: () => setTimeout(showLogin) }, 'Sign in')) : null);
  }
}

async function start() {
  try {
    await loadMe();
  } catch (err) {
    if (err.status === 401) return showLogin();
    clear(root, h('div', { class: 'boot' }, alertBox(err.message, 'bad', 'alert')));
    return;
  }
  if (S.me.org) {
    loadLookups().catch(() => {});
    api.get('/api/dashboard').then((d) => { S.approvals = d.approvals.leave + d.approvals.corrections + (d.approvals.requests || 0); if (shell) drawShell(); }).catch(() => {});
  }
  shell = null;
  if (location.hash === '#signup') location.hash = '';
  await route();
}

window.addEventListener('hashchange', route);
window.addEventListener('hr:signed-out', () => { if (S.me) { S.me = null; showLogin(); } });
window.addEventListener('hr:refresh-shell', refreshCounts);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

start();
