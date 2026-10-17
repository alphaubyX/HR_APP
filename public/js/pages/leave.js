// Leave for HR and managers: requests, team calendar and the leave register (balances).
import { api } from '../api.js';
import { S, can, isManager } from '../state.js';
import {
  h, clear, icon, pageHead, card, tabs, table, seg, num, monthLabel, addMonths, todayLocal, addDays, weekday, DOW, download, toast, empty, } from '../ui.js';
import { applyLeave, leaveRequestsTable } from './widgets.js';

export default async function leavePage(view, params) {
  const staff = can('leave.view') || isManager();
  const tab = params.tab || (staff ? 'requests' : 'calendar');
  view.append(pageHead(staff ? 'Leave' : 'Holidays & team', {
    sub: staff ? `Leave years start every ${monthLabel(`2000-${String(S.me.org.settings.leave_year_start_month).padStart(2, '0')}`).split(' ')[0]} 1st: balances reset and leftover days carry forward up to each type’s limit.` : 'Public holidays and who is away.',
    actions: [
      can('reports.view') ? h('button', { class: 'btn', onclick: () => download('/api/reports/leave.csv') }, icon('download', 16), 'Export') : null,
      S.me.employee || can('leave.manage') ? h('button', { class: 'btn primary', onclick: () => applyLeave({ onDone: () => location.reload() }) }, icon('plus', 16), can('leave.manage') ? 'Record / apply leave' : 'Apply for leave') : null,
    ].filter(Boolean),
  }));
  view.append(tabs([
    staff ? { id: 'requests', label: 'Requests', href: '#/leave' } : null,
    { id: 'calendar', label: 'Calendar', href: '#/leave/calendar' },
    can('leave.view', 'leave.manage') ? { id: 'register', label: 'Balances', href: '#/leave/register' } : null,
  ], tab));
  const body = h('div');
  view.append(body);
  await ({ requests, calendar, register }[tab] || calendar)(body);
}

async function requests(body) {
  let status = 'pending';
  const holder = h('div');
  body.append(h('div', { class: 'toolbar' }, seg([['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['', 'All']], status, (s) => { status = s; load(); })), holder);
  async function load() {
    const rows = await api.get('/api/leave/requests', { scope: 'all', status });
    clear(holder, card(null, rows.length ? leaveRequestsTable(rows, { onChange: load }) : empty(status === 'pending' ? 'No pending requests' : 'Nothing here', '', null, 'calendar'), { flush: true }));
  }
  await load();
}

async function calendar(body) {
  let month = todayLocal().slice(0, 7);
  const holder = h('div');
  const label = h('strong', { style: { minWidth: '140px', textAlign: 'center' } });
  body.append(h('div', { class: 'toolbar' },
    h('button', { class: 'icon-btn', onclick: () => { month = addMonths(month, -1); load(); } }, icon('left')), label,
    h('button', { class: 'icon-btn', onclick: () => { month = addMonths(month, 1); load(); } }, icon('right')),
    h('button', { class: 'btn sm', onclick: () => { month = todayLocal().slice(0, 7); load(); } }, 'This month')), holder);
  async function load() {
    label.textContent = monthLabel(month);
    const first = `${month}-01`;
    const start = addDays(first, -(weekday(first) - 1));
    const end = addDays(start, 41);
    const d = await api.get('/api/leave/calendar', { from: start, to: end });
    const today = todayLocal();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const hol = d.holidays.filter((x) => x.holiday_date === day);
      const lv = d.leaves.filter((x) => x.from_date <= day && x.to_date >= day);
      cells.push(h('div', { class: [day.slice(0, 7) !== month && 'other', day === today && 'today'] },
        h('span', { class: 'd' }, String(Number(day.slice(8)))),
        hol.map((x) => h('div', { class: 'ev hol', title: x.note || x.name }, x.name)),
        lv.slice(0, 4).map((x) => h('div', { class: ['ev', x.status === 'pending' && 'pending'], style: { background: `color-mix(in srgb, ${x.color || '#1f72a6'} 16%, transparent)`, color: x.color || 'var(--brand)' }, title: `${x.name} · ${x.type_name}${x.status === 'pending' ? ' (pending)' : ''}` }, `${x.name.split(' ')[0]}${x.half_day !== 'none' ? ' ½' : ''}`)),
        lv.length > 4 ? h('div', { class: 'tiny muted' }, `+${lv.length - 4} more`) : null));
    }
    clear(holder, h('div', { class: 'card', style: { overflow: 'hidden' } }, h('div', { class: 'cal' }, DOW.map((x) => h('div', { class: 'dow' }, x)), cells)),
      h('p', { class: 'tiny muted mt-8' }, 'Dashed = waiting for approval. Purple = holidays and exceptional days.'));
  }
  await load();
}

async function register(body) {
  let year = null;
  const holder = h('div');
  body.append(holder);
  async function load() {
    const d = await api.get('/api/leave/register', { year });
    year = d.year;
    clear(holder,
      h('div', { class: 'toolbar' },
        h('button', { class: 'icon-btn', onclick: () => { year -= 1; load(); } }, icon('left')), h('strong', null, `Leave year ${d.year}`),
        h('button', { class: 'icon-btn', onclick: () => { year += 1; load(); } }, icon('right')),
        h('div', { class: 'spacer' }),
        can('leave.manage') ? h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/api/leave/allocate', { year: d.year }); toast(r.created ? `${r.created} new allocation(s) made` : 'Everyone already has this year’s allocation'); load(); } }, icon('refresh', 14), 'Allocate this year') : null),
      card(null, table({
        rows: d.rows, search: 'Search…', pageSize: 100,
        onRow: (r) => { location.hash = `#/employees/${r.id}/leave`; },
        columns: [
          { key: 'name', label: 'Employee', sort: true, render: (r) => h('div', null, h('div', { class: 'strong' }, r.name), h('div', { class: 'tiny muted' }, r.emp_code)) },
          ...d.types.map((t) => ({
            key: `t${t.id}`, label: t.code, num: true,
            sort: (r) => (r.balances[t.id] ? r.balances[t.id].balance : -999),
            render: (r) => {
              const b = r.balances[t.id];
              if (!b) return h('span', { class: 'faint' }, '—');
              return h('span', { title: `${t.name}: ${num(b.entitled)} entitled, ${num(b.used)} used` }, h('strong', null, num(b.balance)), h('span', { class: 'tiny muted' }, ` / ${num(b.entitled)}`));
            },
          })),
        ],
      }), { flush: true }),
      h('p', { class: 'tiny muted mt-8' }, 'Each cell: days left / days entitled this year (allocation + carried forward + adjustments).'));
  }
  await load();
}
