// A printable payslip (Print → Save as PDF).
import { api } from '../api.js';
import { can } from '../state.js';
import { h, icon, pageHead, money, monthLabel, date, num, alertBox } from '../ui.js';

export default async function payslip(view, params) {
  const p = await api.get(`/api/payslips/${params.id}`);
  const i = p.info;
  const earn = p.lines.filter((l) => l.kind === 'earning');
  const ded = p.lines.filter((l) => l.kind === 'deduction');
  const emp = p.lines.filter((l) => l.kind === 'employer');
  view.append(pageHead(`Payslip · ${monthLabel(p.run.month)}`, {
    crumbs: can('payroll.view') ? [{ label: 'Payroll', href: '#/payroll' }, { label: monthLabel(p.run.month), href: `#/payroll/${p.run.id}` }, { label: i.name }] : [{ label: 'My payslips', href: '#/me/payslips' }, { label: monthLabel(p.run.month) }],
    actions: [h('button', { class: 'btn primary', onclick: () => window.print() }, icon('printer', 16), 'Print / save PDF')],
  }));
  if (p.warnings.length && can('payroll.view')) view.append(h('div', { class: 'mb-16 no-print' }, alertBox(h('div', null, p.warnings.map((w) => h('div', null, w))), 'warn', 'alert')));

  const rows = (lines) => lines.map((l) => h('tr', null, h('td', null, l.name), h('td', { class: 'amt' }, money(l.amount, { decimals: 2 }))));
  const pad = (a, b) => Array.from({ length: Math.max(0, b.length - a.length) }, () => h('tr', null, h('td', null, ' '), h('td')));
  view.append(h('div', { class: 'payslip' },
    h('div', { class: 'ps-head' },
      h('div', null, p.org.logo ? h('img', { class: 'ps-logo', src: p.org.logo, alt: '' }) : null, h('h1', null, p.org.legal_name || p.org.name), h('div', { style: { color: '#6b7280', fontSize: '12.5px', whiteSpace: 'pre-line' } }, p.org.address || '')),
      h('div', { style: { textAlign: 'right' } }, h('div', { style: { fontSize: '12px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Payslip'),
        h('div', { style: { fontSize: '18px', fontWeight: 700 } }, monthLabel(p.run.month)), h('div', { style: { fontSize: '12px', color: '#6b7280' } }, `${date(p.run.period_start)} – ${date(p.run.period_end)}`))),
    h('div', { class: 'ps-grid' },
      ...[['Employee', i.name], ['Employee no.', i.emp_code], ['Designation', i.designation || '—'], ['Department', i.department || '—'], ['Joined', date(i.join_date)],
        ['National ID', i.national_id || '—'], ['Paid by', i.payment_method === 'bank' ? `${i.bank_name || 'Bank'} ${i.bank_account_no ? `· ${i.bank_account_no}` : ''}` : i.payment_method],
        ['Tax number', i.tax_number || '—']].map(([k, v]) => h('div', null, h('span', null, k), h('span', null, v)))),
    h('div', { class: 'ps-grid' },
      ...[['Days in period', num(p.period_days)], ['Days employed', num(p.employed_days)], ['Present', num(p.present_days)], ['Paid leave', num(p.paid_leave_days)],
        ['Absent', num(p.absent_days)], ['Late arrivals', `${p.late_count}${p.late_deduction_days ? ` (${num(p.late_deduction_days)} day deducted)` : ''}`],
        ['Unpaid days', num(p.unpaid_days)], ['Overtime hours', num(p.overtime_hours)]].map(([k, v]) => h('div', null, h('span', null, k), h('span', null, v)))),
    h('div', { class: 'ps-cols' },
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'Earnings'), h('th', { class: 'amt' }, 'Amount'))), h('tbody', null, rows(earn), pad(earn, ded)),
        h('tfoot', null, h('tr', null, h('td', { style: { fontWeight: 700 } }, 'Total earnings'), h('td', { class: 'amt', style: { fontWeight: 700 } }, money(p.earnings, { decimals: 2 }))))),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'Deductions'), h('th', { class: 'amt' }, 'Amount'))), h('tbody', null, rows(ded), pad(ded, earn)),
        h('tfoot', null, h('tr', null, h('td', { style: { fontWeight: 700 } }, 'Total deductions'), h('td', { class: 'amt', style: { fontWeight: 700 } }, money(p.deductions, { decimals: 2 })))))),
    h('div', { class: 'ps-net' }, h('span', null, 'Net pay'), h('span', null, `${p.org.currency} ${money(p.net, { decimals: 2 })}`)),
    emp.length ? h('div', { style: { marginTop: '12px', fontSize: '12px', color: '#6b7280' } }, `Paid by the employer on your behalf: ${emp.map((l) => `${l.name} ${money(l.amount)}`).join(', ')}`) : null,
    p.leave_adjusted_days ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: '#6b7280' } }, `${num(p.leave_adjusted_days)} day(s) of absence/lates were taken from your leave balance instead of salary.`) : null,
    h('div', { class: 'ps-foot' }, h('span', null, 'This is a computer-generated payslip and needs no signature.'), h('span', null, p.run.status === 'paid' ? 'Paid' : p.run.status === 'approved' ? 'Approved' : 'Draft'))));
}
