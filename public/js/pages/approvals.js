// Everything waiting for the signed-in person's decision.
import { api } from '../api.js';
import { S, can, navigate, loadLookups, lookupName } from '../state.js';
import {
  h, icon, pageHead, card, empty, date, num, toast, errorToast, promptDialog, person, badge, seg, modal, kv, money, sentence, utcToLocal, reqStatus,
} from '../ui.js';
import { leaveDetail, chainView } from './widgets.js';

export default async function approvals(view, params, query, ctx) {
  const everything = query.all === '1';
  const tab = ['sent', 'all'].includes(query.tab) ? query.tab : 'waiting';
  const reload = () => { if (ctx && ctx.refreshShell) ctx.refreshShell(); navigate(`/approvals${tab !== 'waiting' ? `?tab=${tab}` : everything ? '?all=1' : ''}`); };
  view.append(pageHead('Approvals', {
    sub: 'Requests, leave and attendance corrections waiting for a decision.',
    actions: [
      seg([['waiting', 'Waiting for me'], ['sent', 'Sent by me'], can('workflows.manage') && ['all', 'All requests']].filter(Boolean), tab, (t) => navigate(`/approvals${t === 'waiting' ? '' : `?tab=${t}`}`)),
      tab === 'waiting' && can('leave.manage') ? h('a', { class: 'btn', href: everything ? '#/approvals' : '#/approvals?all=1' }, everything ? 'Only mine and HR’s' : 'Show every pending leave') : null,
    ].filter(Boolean),
  }));
  await loadLookups();
  const requests = await api.get('/api/approvals', { scope: tab });
  if (tab !== 'waiting') {
    view.append(requestsCard(tab === 'sent' ? 'Requests you sent' : 'All approval requests', requests, reload, { showStatus: true }));
    return;
  }
  const [leave, corr] = await Promise.all([
    api.get('/api/leave/requests', { scope: 'approvals', everything: everything ? 1 : undefined }),
    api.get('/api/regularizations', { scope: 'approvals' }),
  ]);
  if (requests.length || can('workflows.manage', 'employees.edit', 'salary.edit')) view.append(requestsCard(`Requests (${requests.length})`, requests, reload));

  const decide = async (url, approve, after) => {
    const comment = approve ? '' : await promptDialog('Reason for rejecting', { multiline: true, ok: 'Reject' });
    if (comment === null) return;
    try { await api.post(url, { approve, comment: comment || null }); toast(approve ? 'Approved' : 'Rejected'); after(); } catch (err) { errorToast(err); }
  };

  const leaveCard = card(`Leave requests (${leave.length})`, leave.length ? h('ul', { class: 'list' }, leave.map((r) => h('li', { class: 'click', onclick: () => leaveDetail(r.id, { onChange: reload }) },
    person(r.name, `${r.type_name} · ${r.from_date === r.to_date ? date(r.from_date) : `${date(r.from_date, { year: false })} – ${date(r.to_date)}`} · ${num(r.days)} day${r.days === 1 ? '' : 's'}`),
    h('div', { class: 'grow hide-sm' }, r.reason ? h('div', { class: 'small muted ellipsis', style: { maxWidth: '360px' } }, `“${r.reason}”`) : null, h('div', { class: 'mt-8' }, chainView(r.chain, r.step, r.status))),
    r.can_act ? h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); decide(`/api/leave/requests/${r.id}/decide`, false, reload); } }, icon('x', 14), 'Reject'),
      h('button', { class: 'btn sm ok solid', onclick: (e) => { e.stopPropagation(); decide(`/api/leave/requests/${r.id}/decide`, true, reload); } }, icon('check', 14), 'Approve')) : badge('Waiting for someone else')))) : empty('Nothing to approve', 'You are all caught up.', null, 'checkCircle'), { flush: true });

  const corrCard = card(`Attendance corrections (${corr.length})`, corr.length ? h('ul', { class: 'list' }, corr.map((r) => h('li', null,
    person(r.name, `${date(r.work_date)} · ${[r.in_time && `in ${r.in_time}`, r.out_time && `out ${r.out_time}`].filter(Boolean).join(', ')}`),
    h('div', { class: 'grow small muted hide-sm' }, `“${r.reason}”`),
    r.can_act ? h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: () => decide(`/api/regularizations/${r.id}/decide`, false, reload) }, icon('x', 14), 'Reject'),
      h('button', { class: 'btn sm ok solid', onclick: () => decide(`/api/regularizations/${r.id}/decide`, true, reload) }, icon('check', 14), 'Approve')) : badge('Waiting for someone else')))) : empty('No corrections waiting', '', null, 'checkCircle'), { flush: true });

  view.append(leaveCard, corrCard);
}

/* ------------------------------------------------------------------ workflow requests */
const STATUS_KIND = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '', failed: 'bad' };

/** Initiator → each approver, with who decided. */
export function stepsView(r) {
  return h('div', { class: 'chain' },
    h('span', { class: 'step done', title: 'Initiator' }, icon('user', 12), r.initiator.name),
    r.steps.map((s, i) => h('span', {
      class: ['step', s.status === 'approved' && 'done', s.status === 'rejected' && 'rejected', s.status === 'skipped' && 'skipped', r.status === 'pending' && i === r.step && 'now'],
      title: [s.note, s.by_name && `${s.status} by ${s.by_name}${s.override ? ' (as administrator)' : ''}`, s.comment && `“${s.comment}”`].filter(Boolean).join(' · ') || null,
    }, s.status === 'approved' ? icon('check', 12) : s.status === 'rejected' ? icon('x', 12) : icon('shield', 12), s.label)));
}

async function decideRequest(r, approve, after) {
  const comment = approve ? '' : await promptDialog('Reason for rejecting', { multiline: true, ok: 'Reject' });
  if (comment === null) return;
  try {
    const out = await api.post(`/api/approvals/${r.id}/decide`, { approve, comment: comment || null });
    if (out.result === 'forwarded') toast(`Approved. Now waiting for ${out.to}.`);
    else if (out.result === 'approved') toast(out.notes && out.notes.length ? `Approved and done, but: ${out.notes.join(' · ')}` : 'Approved and done', out.notes && out.notes.length ? 'bad' : 'ok');
    else if (out.result === 'failed') toast(`Approved, but it could not be done: ${out.error}`, 'bad');
    else toast('Rejected');
    after();
  } catch (err) { errorToast(err); }
}

function requestsCard(title, list, reload, { showStatus = false } = {}) {
  return card(title, list.length ? h('ul', { class: 'list' }, list.map((r) => h('li', { class: 'click', onclick: () => requestDetail(r, reload) },
    h('div', { class: 'grow', style: { minWidth: 0 } },
      h('div', { class: 'strong ellipsis' }, r.title),
      h('div', { class: 'tiny muted' }, `From ${r.initiator.name} · ${utcToLocal(r.created_at)}`),
      h('div', { class: 'mt-8' }, stepsView(r)),
      r.status === 'failed' || (r.status === 'approved' && r.error) ? h('div', { class: 'tiny', style: { color: 'var(--bad)' } }, r.error) : null),
    r.can_act ? h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); decideRequest(r, false, reload); } }, icon('x', 14), 'Reject'),
      h('button', { class: 'btn sm ok solid', onclick: (e) => { e.stopPropagation(); decideRequest(r, true, reload); } }, icon('check', 14), 'Approve'))
      : showStatus ? badge(sentence(r.status), STATUS_KIND[r.status] || '', { dot: true }) : badge('Waiting for someone else')))) : empty(showStatus ? 'No requests yet' : 'No requests waiting for you', showStatus ? '' : 'You are all caught up.', null, 'checkCircle'), { flush: true });
}

const LOOKUP = {
  department_id: 'departments', section_id: 'sections', designation_id: 'designations', grade_id: 'grades', branch_id: 'branches', shift_id: 'shifts',
  manager_id: 'employees', employee_id: 'employees', policy_id: 'policies', leave_type_id: 'leaveTypes', structure_id: 'structures',
};
const MONEYISH = /gross|amount|salary|basic|installment|principal|value$/;

/** The data of a request in plain words: names instead of numbers, amounts as money. */
function fieldsView(body) {
  const show = (k, v) => {
    if (LOOKUP[k]) return lookupName(LOOKUP[k], v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number' && MONEYISH.test(k)) return money(v);
    if (Array.isArray(v)) {
      return v.map((x) => {
        if (x === null || typeof x !== 'object') return LOOKUP[k] ? lookupName(LOOKUP[k], x) : String(x);
        const name = x.name || x.component_name || x.code || (x.component_id && lookupName('components', x.component_id)) || '';
        const amt = x.amount ?? x.value;
        return `${name}${amt !== undefined && amt !== null ? `: ${typeof amt === 'number' ? money(amt) : amt}` : ''}`;
      }).filter(Boolean).join(', ');
    }
    if (v && typeof v === 'object') return Object.entries(v).filter(([, b]) => b !== null && b !== '').map(([a, b]) => `${sentence(a)}: ${typeof b === 'object' ? JSON.stringify(b) : b}`).join(', ');
    return String(v);
  };
  const rows = Object.entries(body || {})
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !k.startsWith('_') && !['photo', 'password'].includes(k))
    .map(([k, v]) => [sentence(k.replace(/_id$/, '')), show(k, v)]);
  return rows.length ? kv(rows) : h('p', { class: 'muted small' }, 'No details.');
}

function requestDetail(r, reload) {
  const m = modal({
    title: r.title, size: 'lg',
    body: h('div', null,
      h('div', { class: 'row mb-16', style: { flexWrap: 'wrap', gap: '8px' } }, badge(sentence(r.status), STATUS_KIND[r.status] || '', { dot: true }), h('span', { class: 'small muted' }, `${r.action_label} · from ${r.initiator.name} · ${utcToLocal(r.created_at)}`)),
      stepsView(r),
      r.steps.some((s) => s.comment) ? h('div', { class: 'mt-16 col gap-4' }, r.steps.filter((s) => s.comment).map((s) => h('div', { class: 'small' }, h('strong', null, `${s.by_name}: `), `“${s.comment}”`))) : null,
      r.error ? h('div', { class: 'mt-16 small', style: { color: 'var(--bad)' } }, r.error) : null,
      r.employee ? h('div', { class: 'mt-16 small' }, 'About: ', h('a', { href: `#/employees/${r.employee.id}`, onclick: () => m.close() }, `${r.employee.name} (${r.employee.emp_code})`)) : null,
      h('h3', { class: 'mt-16 mb-8' }, 'What will happen'), fieldsView(r.body),
      r.followups.length ? h('div', null, r.followups.map((f) => h('div', null, h('h3', { class: 'mt-16 mb-8' }, `Then: ${f.label}`), fieldsView(f.body)))) : null),
    actions: [
      r.can_cancel ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => { try { await api.post(`/api/approvals/${r.id}/cancel`, {}); toast('Request withdrawn'); m.close(); reload(); } catch (err) { errorToast(err); } } }, 'Withdraw request') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Close'),
      r.can_act ? h('button', { class: 'btn', onclick: () => { m.close(); decideRequest(r, false, reload); } }, icon('x', 14), 'Reject') : null,
      r.can_act ? h('button', { class: 'btn ok solid', onclick: () => { m.close(); decideRequest(r, true, reload); } }, icon('check', 14), 'Approve') : null,
    ].filter(Boolean),
  });
}
