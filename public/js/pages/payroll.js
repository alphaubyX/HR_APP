// Payroll runs, one per month.
import { api } from '../api.js';
import { S, can, navigate } from '../state.js';
import {
  h, icon, pageHead, card, table, reqStatus, money, monthLabel, formModal, empty, todayLocal, addMonths, date, } from '../ui.js';

export default async function payroll(view) {
  const runs = await api.get('/api/payroll/runs');
  const create = async () => {
    const last = runs[0];
    const next = last ? addMonths(last.month, 1) : todayLocal().slice(0, 7);
    const id = await formModal({
      title: 'New payroll', one: true, submit: 'Create',
      intro: h('p', { class: 'muted small' }, S.me.org.settings.payroll_period_start_day > 1
        ? `Your payroll period starts on day ${S.me.org.settings.payroll_period_start_day} of the previous month.`
        : 'The payroll covers the calendar month.'),
      fields: [{ name: 'month', label: 'Month', type: 'month', required: true }, { name: 'title', label: 'Title (optional)', placeholder: 'e.g. October salaries' }],
      values: { month: next },
      onSubmit: async (v) => (await api.post('/api/payroll/runs', v)).id,
    });
    if (id) navigate(`/payroll/${id}`);
  };
  view.append(pageHead('Payroll', {
    sub: 'Create a month, process it from salaries and attendance, review, approve and pay.',
    actions: can('payroll.run') ? [h('button', { class: 'btn primary', onclick: create }, icon('plus', 16), 'New payroll')] : [],
  }));
  if (!runs.length) {
    view.append(h('div', { class: 'grid grid-side' },
      card(null, empty('No payroll yet', 'Start with this month. You can process it as many times as you like before approving.', can('payroll.run') ? h('button', { class: 'btn primary', onclick: create }, icon('plus', 16), 'New payroll') : null, 'wallet')),
      card('Before your first payroll', h('ol', { class: 'small', style: { paddingLeft: '18px', margin: 0, lineHeight: 1.9 } },
        h('li', null, h('a', { href: '#/settings/components' }, 'Salary components'), ' — basic, house rent, allowances, deductions.'),
        h('li', null, 'Set each employee’s salary on their profile (Salary tab).'),
        h('li', null, h('a', { href: '#/settings/policies' }, 'Attendance policy'), ' — lates, absences, short time, overtime.'),
        h('li', null, h('a', { href: '#/settings/holidays' }, 'Holidays'), ' and ', h('a', { href: '#/settings/tax' }, 'tax slabs'), '.'),
        h('li', null, 'Connect attendance machines or switch on mobile check-in.')))));
    return;
  }
  view.append(card(null, table({
    rows: runs,
    onRow: (r) => navigate(`/payroll/${r.id}`),
    columns: [
      { key: 'month', label: 'Month', render: (r) => h('div', null, h('div', { class: 'strong' }, r.title || monthLabel(r.month)), h('div', { class: 'tiny muted' }, `${date(r.period_start)} – ${date(r.period_end)}`)) },
      { key: 'status', label: 'Status', render: (r) => reqStatus(r.status) },
      { key: 'employee_count', label: 'Employees', num: true },
      { key: 'gross', label: 'Earnings', num: true, render: (r) => (r.totals ? money(r.totals.earnings) : '—') },
      { key: 'ded', label: 'Deductions', num: true, render: (r) => (r.totals ? money(r.totals.deductions) : '—') },
      { key: 'net', label: 'Net pay', num: true, render: (r) => (r.totals ? h('strong', null, money(r.totals.net)) : '—') },
      { key: 'w', label: '', render: (r) => (r.totals && r.totals.warnings ? h('span', { class: 'badge warn', title: 'Payslips with warnings' }, icon('alert', 12), r.totals.warnings) : null) },
    ],
  }), { flush: true }));
}
