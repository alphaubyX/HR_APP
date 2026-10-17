import { api } from '../api.js';
import { S, can, hasEmployee } from '../state.js';
import {
  h, icon, pageHead, card, stat, person, badge, date, money, monthLabel, empty, reqStatus,
} from '../ui.js';

export default async function dashboard(view) {
  const d = await api.get('/api/dashboard');
  const me = S.me;
  const hello = (() => { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; })();
  const actions = [];
  if (hasEmployee()) actions.push(h('a', { class: 'btn', href: '#/me' }, icon('finger', 16), 'Check in'));
  if (can('employees.edit')) actions.push(h('a', { class: 'btn primary', href: '#/employees/new' }, icon('plus', 16), 'Add employee'));
  view.append(pageHead(`${hello}, ${me.user.name.split(' ')[0]}`, { sub: `${me.org.name} · ${date(d.today)}`, actions }));

  const approvalsTotal = d.approvals.leave + d.approvals.corrections + (d.approvals.requests || 0);
  if (approvalsTotal) {
    view.append(h('a', { href: '#/approvals', class: 'card mb-16', style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 18px', textDecoration: 'none', color: 'inherit', borderColor: 'var(--warn)' } },
      h('span', { class: 'stat-icon', style: { position: 'static', width: '36px', height: '36px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'var(--warn-soft)', color: 'var(--warn)' } }, icon('inbox', 18)),
      h('div', { class: 'grow' }, h('div', { class: 'strong' }, `${approvalsTotal} request${approvalsTotal > 1 ? 's' : ''} waiting for you`),
        h('div', { class: 'small muted' }, [d.approvals.requests && `${d.approvals.requests} request${d.approvals.requests > 1 ? 's' : ''}`, d.approvals.leave && `${d.approvals.leave} leave`, d.approvals.corrections && `${d.approvals.corrections} attendance correction${d.approvals.corrections > 1 ? 's' : ''}`].filter(Boolean).join(' · '))),
      h('span', { class: 'btn sm' }, 'Review', icon('right', 14))));
  }

  if (d.today_attendance) {
    const t = d.today_attendance;
    view.append(h('div', { class: 'grid grid-4 mb-16' },
      stat('Checked in today', `${t.in} / ${t.people}`, { hint: t.off ? `${t.off} on a day off` : 'People expected today', ic: 'finger', onClick: () => { location.hash = '#/attendance'; } }),
      stat('Late today', t.late, { hint: 'Arrived after grace time', ic: 'clock', color: 'var(--warn)', bg: 'var(--warn-soft)', onClick: () => { location.hash = '#/attendance'; } }),
      stat('On leave', t.on_leave, { hint: 'Approved leave today', ic: 'calendar', color: 'var(--info)', bg: 'var(--info-soft)', onClick: () => { location.hash = '#/leave/calendar'; } }),
      stat('Not in yet', t.not_in, { hint: 'No punch on a working day', ic: 'alert', color: 'var(--bad)', bg: 'var(--bad-soft)', onClick: () => { location.hash = '#/attendance'; } })));
  }

  const left = h('div', { class: 'col gap-16' });
  const right = h('div', { class: 'col gap-16' });
  view.append(h('div', { class: 'grid grid-side' }, left, right));

  if (d.headcount) {
    const hc = d.headcount;
    const max = Math.max(1, ...d.by_department.map((x) => x.count));
    left.append(card('Headcount', h('div', null,
      h('div', { class: 'row wrap gap-16 mb-16' },
        h('div', null, h('div', { class: 'stat', style: { padding: 0 } }, h('div', { class: 'value' }, hc.total), h('div', { class: 'hint' }, 'current employees'))),
        h('div', { class: 'row wrap gap-8' },
          badge(`${hc.permanent} permanent`, 'ok', { dot: true }), badge(`${hc.probation} on probation`, 'warn', { dot: true }),
          hc.onboarding ? badge(`${hc.onboarding} joining soon`, 'info', { dot: true }) : null, hc.notice ? badge(`${hc.notice} serving notice`, 'violet', { dot: true }) : null)),
      d.by_department.length ? h('div', { class: 'bar-list' }, d.by_department.map((x) => h('div', { class: 'bar-row', title: `${x.name}: ${x.count}` },
        h('div', { class: 'row', style: { minWidth: 0 } }, h('span', { class: 'swatch', style: { background: x.color || 'var(--faint)' } }), h('span', { class: 'ellipsis' }, x.name)),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(x.count / max) * 100}%`, background: 'var(--brand)' } })),
        h('div', { class: 'num right strong' }, x.count)))) : empty('No employees yet', 'Add your first employee to get started.', can('employees.edit') ? h('a', { class: 'btn primary', href: '#/employees/new' }, 'Add employee') : null, 'users')),
    { actions: h('a', { class: 'btn sm ghost', href: '#/organogram' }, icon('org', 15), 'Organogram') }));
  }

  if (d.payroll_trend && d.payroll_trend.length) {
    const max = Math.max(1, ...d.payroll_trend.map((x) => x.net));
    const lp = d.last_payroll;
    left.append(card('Net payroll by month', h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '10px', height: '150px', padding: '8px 4px 0', borderBottom: '1px solid var(--line)' } },
        d.payroll_trend.map((x) => h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end' }, title: `${monthLabel(x.month)}: ${money(x.net, { symbol: true })}` },
          h('div', { class: 'tiny muted num' }, compact(x.net)),
          h('div', { style: { width: '100%', maxWidth: '38px', height: `${Math.max(2, (x.net / max) * 110)}px`, background: 'var(--brand)', borderRadius: '4px 4px 0 0' } })))),
      h('div', { style: { display: 'flex', gap: '10px', padding: '6px 4px 0' } }, d.payroll_trend.map((x) => h('div', { class: 'tiny muted center', style: { flex: 1 } }, monthLabel(x.month, false).split(' ')[0])))),
    { actions: lp ? h('a', { class: 'btn sm ghost', href: `#/payroll/${lp.id}` }, `${monthLabel(lp.month)} · `, reqStatus(lp.status)) : null }));
  } else if (can('payroll.run')) {
    left.append(card('Payroll', empty('No payroll yet', 'Once salaries are set, run your first payroll.', h('a', { class: 'btn primary', href: '#/payroll' }, 'Go to payroll'), 'wallet')));
  }

  if (d.probation_due && d.probation_due.length) {
    right.append(card('Probation ending soon', h('ul', { class: 'list' }, d.probation_due.map((p) => h('li', { class: 'click', onclick: () => { location.hash = `#/employees/${p.id}`; } },
      person(p.name, p.emp_code), h('div', { class: 'spacer' }),
      badge(p.days_left < 0 ? `${-p.days_left} d overdue` : p.days_left === 0 ? 'today' : `in ${p.days_left} d`, p.days_left <= 0 ? 'bad' : p.days_left <= 7 ? 'warn' : '')))), { flush: true }));
  }
  if (d.on_leave_today && d.on_leave_today.length) {
    right.append(card('Away today', h('ul', { class: 'list' }, d.on_leave_today.map((p) => h('li', null, person(p.name, `${p.type_name} · back after ${date(p.to_date, { year: false })}`)))), { flush: true }));
  }
  if (d.holidays && d.holidays.length) {
    right.append(card('Upcoming holidays', h('ul', { class: 'list' }, d.holidays.map((x) => h('li', null,
      h('div', { class: 'center', style: { width: '44px' } }, h('div', { class: 'strong' }, x.holiday_date.slice(8)), h('div', { class: 'tiny muted' }, date(x.holiday_date).split(' ')[1])),
      h('div', { class: 'grow' }, h('div', { class: 'strong' }, x.name), h('div', { class: 'tiny muted' }, x.kind === 'public' ? 'Public holiday' : `Exceptional day · ${x.treatment.replace('_', ' ')}`))))), { flush: true }));
  }
  const celebrations = [...(d.birthdays || []).map((b) => ({ ...b, what: 'Birthday', ic: 'gift' })), ...(d.anniversaries || []).map((a) => ({ ...a, what: `${a.years} year${a.years > 1 ? 's' : ''} with us`, ic: 'star' }))];
  if (celebrations.length) {
    right.append(card('Celebrations', h('ul', { class: 'list' }, celebrations.map((c) => h('li', null, icon(c.ic, 16), h('div', { class: 'grow' }, h('div', { class: 'strong' }, c.name), h('div', { class: 'tiny muted' }, c.what)), h('span', { class: 'small muted' }, date(`2000-${c.date}`, { year: false }))))), { flush: true }));
  }
  if (!right.children.length) right.append(card('All caught up', h('p', { class: 'muted' }, 'Probation reminders, people away, holidays and birthdays will show here.')));
}

function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
