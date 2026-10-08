// Everything waiting for the signed-in person's decision.
import { api } from '../api.js';
import { can, navigate } from '../state.js';
import {
  h, icon, pageHead, card, empty, date, num, toast, errorToast, promptDialog, person, badge, } from '../ui.js';
import { leaveDetail, chainView } from './widgets.js';

export default async function approvals(view, params, query, ctx) {
  const everything = query.all === '1';
  const [leave, corr] = await Promise.all([
    api.get('/api/leave/requests', { scope: 'approvals', everything: everything ? 1 : undefined }),
    api.get('/api/regularizations', { scope: 'approvals' }),
  ]);
  const reload = () => { if (ctx && ctx.refreshShell) ctx.refreshShell(); navigate(`/approvals${everything ? '?all=1' : ''}`); };
  view.append(pageHead('Approvals', {
    sub: 'Leave and attendance corrections waiting for your decision.',
    actions: [can('leave.manage') ? h('a', { class: 'btn', href: everything ? '#/approvals' : '#/approvals?all=1' }, everything ? 'Only mine and HR’s' : 'Show every pending request') : null].filter(Boolean),
  }));

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
