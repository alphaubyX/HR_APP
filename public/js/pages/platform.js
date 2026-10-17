// For the server owner: every organization (customer) on this server.
import { api } from '../api.js';
import { S, navigate } from '../state.js';
import { h, icon, pageHead, card, table, badge, formModal, toast, errorToast, date, pickFile, readFile, confirmDialog } from '../ui.js';

export default async function platform(view) {
  if (!S.me.user.is_owner) throw new Error('Only the server owner can see this page.');
  const orgs = await api.get('/api/platform/orgs');
  const reload = () => navigate('/platform');
  const add = async () => {
    const ok = await formModal({
      title: 'New organization',
      fields: [
        { name: 'name', label: 'Organization name', required: true, full: true },
        { name: 'currency', label: 'Currency', placeholder: 'PKR' }, { name: 'timezone', label: 'Time zone', placeholder: 'Asia/Karachi' },
        { name: 'plan', label: 'Plan', type: 'select', options: [['trial', 'Trial'], ['basic', 'Basic'], ['business', 'Business'], ['enterprise', 'Enterprise']] },
        { section: 'Their administrator (optional)' },
        { name: 'admin_name', label: 'Name' }, { name: 'admin_email', label: 'Email', type: 'email' },
        { name: 'admin_username', label: 'Username' }, { name: 'admin_password', label: 'Temporary password' },
      ],
      values: { currency: 'PKR', timezone: 'Asia/Karachi', plan: 'trial' },
      onSubmit: (v) => api.post('/api/platform/orgs', v),
    });
    if (ok) { toast('Organization created'); reload(); }
  };
  const edit = async (o) => {
    const ok = await formModal({
      title: o.name, one: true,
      fields: [
        { name: 'plan', label: 'Plan', type: 'select', options: [['trial', 'Trial'], ['basic', 'Basic'], ['business', 'Business'], ['enterprise', 'Enterprise']] },
        { name: 'max_employees', label: 'Employee limit (empty = no limit)', type: 'number', min: 0 },
        { name: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['suspended', 'Suspended (no sign-ins)']] },
      ],
      values: o,
      onSubmit: (v) => api.put(`/api/platform/orgs/${o.id}`, v),
    });
    if (ok) { toast('Saved'); reload(); }
  };
  const open = async (o) => {
    try { await api.post('/api/me/org', { orgId: o.id }); location.hash = '#/dashboard'; location.reload(); } catch (err) { errorToast(err); }
  };
  view.append(pageHead('All organizations', { sub: 'Customers on this server. Each organization’s data is kept separate.', actions: [h('button', { class: 'btn primary', onclick: add }, icon('plus', 16), 'New organization')] }));
  view.append(card(null, table({
    rows: orgs, search: 'Search…',
    columns: [
      { key: 'name', label: 'Organization', sort: true, render: (o) => h('div', null, h('div', { class: 'strong' }, o.name), h('div', { class: 'tiny muted mono' }, o.code)) },
      { key: 'plan', label: 'Plan', sort: true, render: (o) => badge(o.plan, 'brand') },
      { key: 'employees', label: 'Employees', num: true, sort: true, render: (o) => `${o.employees}${o.max_employees ? ` / ${o.max_employees}` : ''}` },
      { key: 'users', label: 'Users', num: true, sort: true },
      { key: 'status', label: 'Status', sort: true, render: (o) => badge(o.status, o.status === 'active' ? 'ok' : 'bad', { dot: true }) },
      { key: 'created_at', label: 'Since', sort: true, render: (o) => date(o.created_at) },
      { key: 'x', label: '', render: (o) => h('div', { class: 'row gap-4' }, h('button', { class: 'btn xs', onclick: () => edit(o) }, 'Plan & status'), h('button', { class: 'btn xs primary', onclick: () => open(o) }, 'Open')) },
    ],
  }), { flush: true }));
  view.append(h('div', { class: 'mt-16' }), brandingCard(reload));
}

/** Broadwing's own logos, used by every organization: upload the original artwork once. */
function brandingCard(reload) {
  const b = S.me.brand || {};
  const slots = [
    ['mark', 'Wing (icon)', 'The wing on its own, in colour. The browser tab icon; shown in white on the phone bar.'],
    ['horizontal', 'White logo for the menu bar', 'White wing and “BROAD WING” side by side, as on broadwing.one’s blue top bar.'],
    ['logo', 'Full logo', 'The stacked colour logo (wing above the name). Shown on the sign-in page.'],
  ];
  const upload = async (slot) => {
    const file = await pickFile('image/png,image/svg+xml,image/webp');
    if (!file) return;
    if (file.size > 1024 * 1024) { errorToast(new Error('The image must be under 1 MB.')); return; }
    try { await api.put(`/api/platform/brand/${slot}`, { data: await readFile(file, true) }); toast('Logo saved'); location.reload(); } catch (e) { errorToast(e); }
  };
  const remove = async (slot) => {
    if (!(await confirmDialog('Go back to the built-in wing for this spot?', { ok: 'Remove' }))) return;
    try { await api.put(`/api/platform/brand/${slot}`, { data: null }); toast('Removed'); location.reload(); } catch (e) { errorToast(e); }
  };
  return card('Branding', h('div', { class: 'card-body' },
    h('p', { class: 'muted small mb-16' }, 'Broadwing’s original logos are built in. Upload a replacement only to change one (PNG with a transparent background, or SVG). Uploads are kept in the database, so app updates never replace them.'),
    h('div', { class: 'brand-slots' }, slots.map(([slot, title, help]) => h('div', { class: 'brand-slot' },
      h('div', { class: 'brand-previews' },
        slot === 'horizontal' ? null : h('div', { class: 'on-white' }, h('img', { src: `/brand/${slot}?v=${b.v || 0}`, alt: '' })),
        slot === 'logo' ? null : h('div', { class: 'on-blue' }, h('img', { class: slot === 'mark' ? 'on-dark' : '', src: `/brand/${slot}?v=${b.v || 0}`, alt: '' }))),
      h('div', { class: 'strong mt-8' }, title, b[slot] ? h('span', { class: 'tiny muted' }, ' · uploaded') : h('span', { class: 'tiny muted' }, ' · Broadwing original')),
      h('div', { class: 'tiny muted' }, help),
      h('div', { class: 'row mt-8', style: { gap: '6px' } },
        h('button', { class: 'btn sm', onclick: () => upload(slot) }, icon('upload', 14), b[slot] ? 'Replace' : 'Upload'),
        b[slot] ? h('button', { class: 'btn sm', onclick: () => remove(slot) }, 'Remove') : null))))));
}
