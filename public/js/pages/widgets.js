// Pieces shared by several pages: leave balances, leave form, attendance month, request details.
import { api } from '../api.js';
import { S, can, employeeOptions } from '../state.js';
import {
  h, clear, icon, card, table, badge, reqStatus, date, time, duration, num, modal, formModal, toast, errorToast, attBadge, attKey, ATT,
  monthLabel, addMonths, todayLocal, alertBox, kv, confirmDialog, promptDialog, spinner, sentence, utcToLocal, DOW, weekday,
} from '../ui.js';

/* ------------------------------------------------------------------ leave */
export function balanceCards(balances) {
  if (!balances.length) return h('p', { class: 'muted' }, 'No leave types apply.');
  return h('div', { class: 'grid grid-4' }, balances.map((b) => {
    const total = b.allocated + b.carried + b.adjusted;
    const pct = total > 0 ? Math.max(0, Math.min(100, (b.balance / total) * 100)) : 0;
    return h('div', { class: 'card stat' },
      h('div', { class: 'label' }, h('span', { class: 'swatch', style: { background: b.color || 'var(--brand)' } }), b.name),
      h('div', { class: 'value' }, b.unlimited ? '∞' : num(b.available), h('span', { class: 'small muted', style: { fontWeight: 500, marginLeft: '6px' } }, b.unlimited ? 'unpaid, as needed' : 'days left')),
      b.unlimited ? null : h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%`, background: b.color || 'var(--brand)' } })),
      h('div', { class: 'hint' }, b.unlimited ? `${num(b.taken)} taken` : [`${num(total)} entitled`, `${num(b.taken)} taken`, b.pending ? `${num(b.pending)} pending` : null, b.carried ? `${num(b.carried)} carried over` : null].filter(Boolean).join(' · ')));
  }));
}

export function chainView(chain, step, status) {
  return h('div', { class: 'chain' }, chain.map((s, i) => h('span', {
    class: ['step', status === 'approved' || (status === 'pending' && i < step) ? 'done' : status === 'pending' && i === step ? 'now' : ''],
  }, i < step || status === 'approved' ? icon('check', 12) : icon(s.type === 'hr' ? 'shield' : 'user', 12), s.name)));
}

/** Apply for leave. employeeId = null for yourself; HR may apply for someone else. */
export async function applyLeave({ employeeId = null, onDone = null } = {}) {
  const types = S.lookups.leaveTypes.filter((t) => t.active);
  const forOthers = can('leave.manage');
  const info = h('div', { class: 'mt-16' });
  let timer = null;
  const fields = [
    forOthers && !employeeId ? { name: 'employee_id', label: 'Employee', type: 'select', placeholder: 'Myself', options: () => employeeOptions(), numeric: true } : null,
    { name: 'leave_type_id', label: 'Leave type', type: 'select', required: true, options: types.map((t) => [t.id, t.name]), numeric: true },
    { name: 'half_day', label: 'Length', type: 'select', options: [['none', 'Full day(s)'], ['first', 'Half day — first half'], ['second', 'Half day — second half']] },
    { name: 'from_date', label: 'From', type: 'date', required: true },
    { name: 'to_date', label: 'To', type: 'date', show: (v) => v.half_day === 'none' },
    { name: 'reason', label: 'Reason', type: 'textarea', full: true, placeholder: 'Optional' },
    forOthers ? { name: 'approve_now', label: 'Approve straight away', type: 'checkbox', help: 'For leave HR records on someone’s behalf.', show: (v) => !!(v.employee_id || employeeId) } : null,
  ].filter(Boolean);
  const check = async (v) => {
    const body = { ...v, employee_id: employeeId || v.employee_id || undefined };
    if (!body.from_date || !body.leave_type_id) { clear(info); return; }
    if (body.half_day !== 'none' || !body.to_date) body.to_date = body.from_date;
    const r = await api.post('/api/leave/preview', body).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { clear(info, alertBox(r.error, 'warn', 'alert')); return; }
    clear(info, h('div', { class: 'card', style: { padding: '12px 14px', background: 'var(--panel-2)' } },
      h('div', { class: 'row wrap' }, h('span', { class: 'strong' }, `${num(r.days)} day${r.days === 1 ? '' : 's'}`), h('span', { class: 'muted' }, '·'),
        r.unlimited ? h('span', { class: 'muted' }, 'unpaid leave') : h('span', { class: r.enough ? 'muted' : '', style: r.enough ? null : { color: 'var(--bad)', fontWeight: 600 } }, `${num(r.available)} available`),
        r.enough ? null : badge('Not enough balance', 'bad')),
      h('div', { class: 'row wrap mt-8 small' }, h('span', { class: 'muted' }, 'Approval:'), chainView(r.chain, 0, 'new'))));
  };
  return formModal({
    title: 'Apply for leave',
    fields,
    values: { half_day: 'none', from_date: todayLocal(), leave_type_id: types[0] && types[0].id },
    submit: 'Send request',
    extra: info,
    onChange: (v) => { clearTimeout(timer); timer = setTimeout(() => check(v), 250); },
    onSubmit: async (v) => {
      const body = { ...v, employee_id: employeeId || v.employee_id || undefined };
      if (body.half_day !== 'none' || !body.to_date) body.to_date = body.from_date;
      const r = await api.post('/api/leave/requests', body);
      toast(r.status === 'approved' ? 'Leave recorded and approved' : 'Leave request sent');
      if (onDone) onDone();
    },
  });
}

export async function leaveDetail(id, { onChange = null } = {}) {
  const r = await api.get(`/api/leave/requests/${id}`);
  const decide = async (approve) => {
    const comment = approve ? await promptDialog('Approve leave', { label: 'Comment (optional)', required: false, ok: 'Approve' }) : await promptDialog('Reject leave', { label: 'Reason', ok: 'Reject', multiline: true });
    if (comment === null) return;
    try { await api.post(`/api/leave/requests/${id}/decide`, { approve, comment: comment || null }); toast(approve ? 'Approved' : 'Rejected'); m.close(); if (onChange) onChange(); } catch (err) { errorToast(err); }
  };
  const cancel = async () => {
    if (!(await confirmDialog('Cancel this leave?', { ok: 'Cancel leave', danger: true, detail: r.status === 'approved' ? 'The days go back to the balance.' : null }))) return;
    try { await api.post(`/api/leave/requests/${id}/cancel`); toast('Leave cancelled'); m.close(); if (onChange) onChange(); } catch (err) { errorToast(err); }
  };
  const own = S.me.employee && S.me.employee.id === r.employee_id;
  const canCancel = (own && (r.status === 'pending' || (r.status === 'approved' && r.from_date > todayLocal()))) || (can('leave.manage') && ['pending', 'approved'].includes(r.status));
  const m = modal({
    title: `${r.type_name} · ${r.name}`,
    body: h('div', null,
      kv([
        ['Status', reqStatus(r.status)],
        ['Dates', r.from_date === r.to_date ? `${date(r.from_date)}${r.half_day !== 'none' ? ` (${r.half_day} half)` : ''}` : `${date(r.from_date)} → ${date(r.to_date)}`],
        ['Days', num(r.days)],
        ['Reason', r.reason || '—'],
        r.balance ? ['Balance now', r.balance.unlimited ? 'Unpaid leave' : `${num(r.balance.balance)} days (${num(r.balance.pending)} pending)`] : null,
        ['Approval', chainView(r.chain, r.step, r.status)],
      ]),
      h('h3', { class: 'mt-24 mb-8' }, 'History'),
      h('ul', { class: 'timeline' }, r.history.map((x) => h('li', null, h('div', { class: 'strong' }, `${sentence(x.action)}${x.user_name ? ` by ${x.user_name}` : ''}`), x.comment ? h('div', null, x.comment) : null, h('div', { class: 'when' }, utcToLocal(x.created_at)))))),
    actions: [
      canCancel ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: cancel }, 'Cancel leave') : null,
      r.can_act ? h('button', { class: 'btn', onclick: () => decide(false) }, icon('x', 16), 'Reject') : null,
      r.can_act ? h('button', { class: 'btn ok solid', onclick: () => decide(true) }, icon('check', 16), 'Approve') : null,
      !r.can_act ? h('button', { class: 'btn', onclick: () => m.close() }, 'Close') : null,
    ].filter(Boolean),
  });
}

export function leaveRequestsTable(rows, { showName = true, onChange = null } = {}) {
  return table({
    rows,
    onRow: (r) => leaveDetail(r.id, { onChange }),
    columns: [
      showName ? { key: 'name', label: 'Employee', sort: true, render: (r) => h('div', null, h('div', { class: 'strong' }, r.name), h('div', { class: 'tiny muted' }, r.emp_code)) } : null,
      { key: 'type_name', label: 'Type', sort: true, render: (r) => h('span', { class: 'row gap-4' }, h('span', { class: 'swatch', style: { background: r.color || 'var(--brand)' } }), r.type_name) },
      { key: 'from_date', label: 'Dates', sort: true, render: (r) => (r.from_date === r.to_date ? `${date(r.from_date)}${r.half_day !== 'none' ? ' (½)' : ''}` : `${date(r.from_date, { year: false })} – ${date(r.to_date)}`) },
      { key: 'days', label: 'Days', num: true, sort: true, render: (r) => num(r.days) },
      { key: 'status', label: 'Status', sort: true, render: (r) => h('div', { class: 'col gap-4', style: { alignItems: 'flex-start' } }, reqStatus(r.status),
        r.status === 'pending' && r.chain[r.step] ? h('span', { class: 'tiny muted' }, `with ${r.chain[r.step].name}`) : null) },
      { key: 'act', label: '', render: (r) => (r.can_act ? h('span', { class: 'badge warn' }, 'Needs you') : null) },
    ].filter(Boolean),
  });
}

/* ------------------------------------------------------------------ attendance month */
export function attendanceMonth(employeeId, { month = todayLocal().slice(0, 7), canEdit = false } = {}) {
  const el = h('div');
  let cur = month;
  const load = async () => {
    clear(el, spinner());
    const d = await api.get(`/api/attendance/employee/${employeeId || 'me'}`, { month: cur });
    const s = d.summary;
    const picker = h('div', { class: 'row' },
      h('button', { class: 'icon-btn', onclick: () => { cur = addMonths(cur, -1); load(); }, 'aria-label': 'Previous month' }, icon('left')),
      h('strong', { style: { minWidth: '130px', textAlign: 'center' } }, monthLabel(cur)),
      h('button', { class: 'icon-btn', onclick: () => { cur = addMonths(cur, 1); load(); }, 'aria-label': 'Next month' }, icon('right')));
    const tiles = [
      ['Present', num(s.present_days)], ['Absent', s.absent_days], ['Leave', num(s.paid_leave_days + s.unpaid_leave_days)], ['Late', s.late_count],
      ['Hours worked', duration(s.worked_minutes)], s.ot_minutes ? ['Overtime', duration(s.ot_minutes)] : null, s.missing_days ? ['Missing punches', s.missing_days] : null,
      s.late_deduction_days ? ['Late deduction', `${num(s.late_deduction_days)} d`] : null,
    ].filter(Boolean);
    const punchesBy = (day) => d.punches.filter((p) => (day.first_in && p.punch_time >= day.first_in && (!day.last_out || p.punch_time <= day.last_out)) || p.punch_time.slice(0, 10) === day.work_date);
    const rows = [...d.days].reverse();
    clear(el,
      h('div', { class: 'row wrap mb-16' }, picker, h('div', { class: 'spacer' }), h('span', { class: 'small muted' }, `Policy: ${d.policy.name} · ${date(d.start)} – ${date(d.end)}`)),
      h('div', { class: 'row wrap gap-8 mb-16' }, tiles.map(([k, v]) => h('div', { class: 'chip', style: { padding: '6px 12px' } }, h('span', { class: 'muted' }, k), h('strong', null, v)))),
      card(null, table({
        rows, pageSize: 40, compact: true,
        columns: [
          { key: 'work_date', label: 'Date', render: (r) => h('div', null, h('div', { class: 'strong' }, date(r.work_date, { year: false })), h('div', { class: 'tiny muted' }, DOW[weekday(r.work_date) - 1])) },
          { key: 'status', label: 'Status', render: (r) => h('div', { class: 'row gap-4 wrap' }, attBadge(r), r.manual ? badge('Set by HR', 'violet') : null) },
          { key: 'first_in', label: 'In', render: (r) => time(r.first_in) },
          { key: 'last_out', label: 'Out', render: (r) => time(r.last_out) },
          { key: 'worked_minutes', label: 'Worked', num: true, render: (r) => duration(r.worked_minutes) },
          { key: 'late_minutes', label: 'Late', num: true, render: (r) => (r.late_minutes ? h('span', { style: { color: 'var(--warn)', fontWeight: 600 } }, duration(r.late_minutes)) : '—') },
          { key: 'overtime_minutes', label: 'OT', num: true, className: 'hide-sm', render: (r) => duration(r.overtime_minutes) },
          { key: 'remarks', label: 'Notes', className: 'hide-sm', render: (r) => h('span', { class: 'small muted' }, [r.remarks, r.manual_note].filter(Boolean).join(' · ') || (r.punch_count > 2 ? `${r.punch_count} punches` : '')) },
          canEdit ? { key: 'x', label: '', render: (r) => h('button', { class: 'btn xs', onclick: () => overrideDay(employeeId, r, load) }, icon('edit', 12), 'Set') } : null,
        ].filter(Boolean),
        onRow: (r) => dayPunches(r, punchesBy(r)),
      }), { flush: true }));
  };
  load().catch((err) => clear(el, alertBox(err.message, 'bad', 'alert')));
  el.reload = load;
  return el;
}

function dayPunches(day, punches) {
  modal({
    title: `${date(day.work_date)} · ${(ATT[attKey(day)] || { label: day.status }).label}`,
    body: h('div', null,
      kv([
        ['Shift', day.shift_start ? `${day.shift_start} – ${day.shift_end}` : '—'],
        ['Worked', duration(day.worked_minutes)], ['Late by', duration(day.late_minutes)], ['Left early by', duration(day.early_minutes)],
        ['Overtime', duration(day.overtime_minutes)], ['Deduction', day.deduction_days ? `${num(day.deduction_days)} day` : '—'], ['Notes', [day.remarks, day.manual_note].filter(Boolean).join(' · ') || '—'],
      ]),
      h('h3', { class: 'mt-24 mb-8' }, 'Punches'),
      punches.length ? h('ul', { class: 'list card' }, punches.map((p) => h('li', null, icon(p.source === 'mobile' ? 'device' : p.source === 'manual' ? 'edit' : 'finger', 16),
        h('strong', null, time(p.punch_time)), h('span', { class: 'muted small' }, `${sentence(p.source)}${p.device_name ? ` · ${p.device_name}` : ''}${p.branch_name ? ` · ${p.branch_name}` : ''}${p.distance_m !== null && p.distance_m !== undefined && p.source === 'mobile' ? ` · ${p.distance_m} m from office` : ''}`),
        p.note ? h('span', { class: 'small' }, p.note) : null))) : h('p', { class: 'muted' }, 'No punches.')),
    actions: [h('button', { class: 'btn', onclick: (e) => e.target.closest('.overlay').remove() }, 'Close')],
  });
}

export async function overrideDay(employeeId, day, after) {
  const res = await formModal({
    title: `Set ${date(day.work_date)} by hand`,
    intro: h('p', { class: 'muted small' }, 'A day set by hand is kept as it is when attendance is recalculated. Use "Back to automatic" to undo.'),
    fields: [
      { name: 'status', label: 'Status', type: 'select', options: [['present', 'Present'], ['half_day', 'Half day'], ['absent', 'Absent'], ['leave', 'Leave'], ['holiday', 'Holiday'], ['off', 'Day off']] },
      { name: 'deduction_days', label: 'Days to deduct', type: 'number', min: 0, max: 5, step: '0.5' },
      { name: 'late_minutes', label: 'Late minutes (counts toward lates)', type: 'number', min: 0 },
      { name: 'overtime_minutes', label: 'Overtime minutes', type: 'number', min: 0 },
      { name: 'note', label: 'Reason', required: true, full: true, placeholder: 'e.g. Client visit, approved by manager' },
    ],
    values: { status: day.status === 'absent' ? 'present' : day.status, deduction_days: 0, late_minutes: 0, overtime_minutes: day.overtime_minutes || 0 },
    danger: day.manual ? { label: 'Back to automatic', onClick: async () => { await api.del(`/api/attendance/days/${employeeId}/${day.work_date}`); toast('Back to automatic'); after(); } } : null,
    onSubmit: (v) => api.put(`/api/attendance/days/${employeeId}/${day.work_date}`, v),
  });
  if (res === true) { toast('Day updated'); after(); }
}

/* ------------------------------------------------------------------ correction request */
export async function requestCorrection(onDone) {
  const ok = await formModal({
    title: 'Correct my attendance',
    intro: h('p', { class: 'muted small' }, 'Forgot to punch, or the machine missed you? Your manager approves the correction.'),
    fields: [
      { name: 'work_date', label: 'Day', type: 'date', required: true },
      { name: 'in_time', label: 'Came in at', type: 'time' },
      { name: 'out_time', label: 'Left at', type: 'time' },
      { name: 'reason', label: 'Reason', type: 'textarea', required: true, full: true },
    ],
    values: { work_date: todayLocal() },
    submit: 'Send for approval',
    onSubmit: (v) => api.post('/api/regularizations', v),
  });
  if (ok === true) { toast('Correction sent'); if (onDone) onDone(); }
}
