// Reports to download (CSV, opens in Excel).
import { h, icon, pageHead, download, todayLocal, addMonths } from '../ui.js';
import { can } from '../state.js';

export default async function reports(view) {
  view.append(pageHead('Reports', { sub: 'Download as CSV — opens in Excel or Google Sheets.' }));
  const month = h('input', { class: 'input sm', type: 'month', value: addMonths(todayLocal().slice(0, 7), 0), style: { width: '170px' } });
  const year = new Date().getFullYear();
  const from = h('input', { class: 'input sm', type: 'date', value: `${year}-01-01` });
  const to = h('input', { class: 'input sm', type: 'date', value: `${year}-12-31` });
  const item = (ic, title, text, controls, onClick) => h('div', { class: 'card', style: { padding: '18px' } },
    h('div', { class: 'row top gap-12' }, h('span', { class: 'avatar', style: { background: 'var(--brand-soft)', color: 'var(--brand)', borderRadius: '10px' } }, icon(ic, 18)),
      h('div', { class: 'grow' }, h('h3', null, title), h('p', { class: 'muted small mt-8' }, text), h('div', { class: 'row wrap mt-16' }, controls, h('button', { class: 'btn sm primary', onclick: onClick }, icon('download', 14), 'Download')))));
  view.append(h('div', { class: 'grid grid-2' },
    item('users', 'Employee list', 'Everyone with their job, manager, status, dates and attendance setup.', h('label', { class: 'check small' }, h('input', { type: 'checkbox', id: 'rep-all' }), 'Include people who left'),
      () => download(`/api/reports/headcount.csv${document.getElementById('rep-all').checked ? '?all=1' : ''}`)),
    can('attendance.view', 'reports.view') ? item('clock', 'Monthly attendance summary', 'Present, absent, leave, lates, hours and deductions per person for a month.', month, () => download(`/api/reports/attendance.csv?month=${month.value}`)) : null,
    can('leave.view', 'reports.view') ? item('calendar', 'Leave taken', 'Every leave request in a date range with its status.', h('div', { class: 'row' }, from, to), () => download(`/api/reports/leave.csv?from=${from.value}&to=${to.value}`)) : null,
    can('payroll.view') ? item('wallet', 'Payroll register & bank list', 'Open a payroll month and use the Register and Bank list buttons.', null, () => { location.hash = '#/payroll'; }) : null));
}
