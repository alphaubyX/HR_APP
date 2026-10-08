// Loans & advances, one-off adjustments (bonus, fine, arrears) and bulk salary increments.
import { api } from '../api.js';
import { S, can, employeeOptions, navigate } from '../state.js';
import {
  h, clear, icon, pageHead, card, tabs, table, money, monthLabel, todayLocal, formModal, toast, errorToast, confirmDialog, badge, empty, addMonths, sentence, } from '../ui.js';

export default async function moneyPage(view, params, query) {
  const tab = params.tab || 'loans';
  view.append(pageHead('Loans & adjustments', { sub: 'Everything payroll adds or takes away besides the regular salary.' }));
  view.append(tabs([
    { id: 'loans', label: 'Loans & advances', href: '#/money' },
    { id: 'adjustments', label: 'Monthly adjustments', href: '#/money/adjustments' },
    can('salary.edit') ? { id: 'increments', label: 'Bulk increment', href: '#/money/increments' } : null,
  ], tab));
  const body = h('div');
  view.append(body);
  await ({ loans, adjustments, increments }[tab] || loans)(body, query);
}

async function loans(body) {
  const rows = await api.get('/api/loans');
  const edit = can('salary.edit');
  const reload = () => navigate('/money');
  const add = async () => {
    const ok = await formModal({
      title: 'New loan or advance',
      intro: h('p', { class: 'muted small' }, 'The installment is deducted from each payroll from the start month until it is repaid.'),
      fields: [
        { name: 'employee_id', label: 'Employee', type: 'select', required: true, options: () => employeeOptions(), numeric: true, placeholder: 'Choose…', full: true },
        { name: 'kind', label: 'Type', type: 'select', options: [['loan', 'Loan'], ['advance', 'Salary advance']] },
        { name: 'start_month', label: 'First deduction', type: 'month', required: true },
        { name: 'amount', label: 'Amount', type: 'money', required: true, suffix: S.me.org.currency },
        { name: 'installment', label: 'Monthly installment', type: 'money', required: true, suffix: S.me.org.currency },
        { name: 'reason', label: 'Reason', full: true },
      ],
      values: { kind: 'loan', start_month: addMonths(todayLocal().slice(0, 7), 0) },
      onSubmit: (v) => api.post('/api/loans', v),
    });
    if (ok) { toast('Saved'); reload(); }
  };
  const repay = async (l) => {
    const ok = await formModal({
      title: `Record a repayment · ${l.name}`, one: true,
      fields: [{ name: 'amount', label: 'Amount', type: 'money', required: true }, { name: 'month', label: 'Month', type: 'month', required: true }, { name: 'note', label: 'Note', placeholder: 'e.g. Paid in cash' }],
      values: { amount: Math.min(l.balance, l.installment), month: todayLocal().slice(0, 7) },
      onSubmit: (v) => api.post(`/api/loans/${l.id}/repayments`, v),
    });
    if (ok) { toast('Recorded'); reload(); }
  };
  body.append(card(null, rows.length ? table({
    rows, search: 'Search…',
    columns: [
      { key: 'name', label: 'Employee', sort: true, render: (l) => h('div', null, h('div', { class: 'strong' }, l.name), h('div', { class: 'tiny muted' }, `${sentence(l.kind)}${l.reason ? ` · ${l.reason}` : ''}`)) },
      { key: 'amount', label: 'Amount', num: true, sort: true, render: (l) => money(l.amount) },
      { key: 'installment', label: 'Per month', num: true, render: (l) => money(l.installment) },
      { key: 'start_month', label: 'From', sort: true, render: (l) => monthLabel(l.start_month, false) },
      { key: 'balance', label: 'Left to repay', num: true, sort: true, render: (l) => h('strong', null, money(l.balance)) },
      { key: 'status', label: 'Status', sort: true, render: (l) => badge(sentence(l.status), { active: 'info', closed: 'ok', paused: 'warn' }[l.status]) },
      edit ? { key: 'x', label: '', render: (l) => h('div', { class: 'row gap-4' },
        l.status !== 'closed' ? h('button', { class: 'btn xs', onclick: () => repay(l) }, 'Repayment') : null,
        l.status === 'active' ? h('button', { class: 'btn xs', onclick: async () => { await api.put(`/api/loans/${l.id}`, { status: 'paused' }); reload(); } }, 'Pause') : null,
        l.status === 'paused' ? h('button', { class: 'btn xs', onclick: async () => { await api.put(`/api/loans/${l.id}`, { status: 'active' }); reload(); } }, 'Resume') : null,
        Number(l.repaid) === 0 ? h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => { if (await confirmDialog('Delete this loan?', { danger: true, ok: 'Delete' })) { try { await api.del(`/api/loans/${l.id}`); reload(); } catch (err) { errorToast(err); } } } }, icon('trash', 14)) : null) } : null,
    ].filter(Boolean),
  }) : empty('No loans or advances', '', edit ? h('button', { class: 'btn primary', onclick: add }, icon('plus', 16), 'New loan') : null, 'coins'),
  { flush: true, actions: edit && rows.length ? h('button', { class: 'btn sm primary', onclick: add }, icon('plus', 14), 'New loan') : null }));
}

async function adjustments(body, query) {
  let month = query.month || todayLocal().slice(0, 7);
  const holder = h('div');
  const edit = can('salary.edit');
  const label = h('strong', { style: { minWidth: '130px', textAlign: 'center' } });
  const add = async () => {
    const ok = await formModal({
      title: `Add to ${monthLabel(month)} payroll`,
      fields: [
        { name: 'employee_id', label: 'Employee', type: 'select', required: true, options: () => employeeOptions(), numeric: true, placeholder: 'Choose…', full: true },
        { name: 'kind', label: 'Type', type: 'select', options: [['earning', 'Addition (bonus, arrears, reimbursement…)'], ['deduction', 'Deduction (fine, damage, recovery…)']] },
        { name: 'title', label: 'Shown on payslip as', required: true, placeholder: 'e.g. Performance bonus' },
        { name: 'amount', label: 'Amount', type: 'money', required: true },
        { name: 'taxable', label: 'Taxable', type: 'checkbox', default: true, show: (v) => v.kind === 'earning' },
      ],
      values: { kind: 'earning' },
      onSubmit: (v) => api.post('/api/adjustments', { ...v, month }),
    });
    if (ok) { toast('Added — recalculate the payroll to include it'); load(); }
  };
  body.append(h('div', { class: 'toolbar' },
    h('button', { class: 'icon-btn', onclick: () => { month = addMonths(month, -1); load(); } }, icon('left')), label,
    h('button', { class: 'icon-btn', onclick: () => { month = addMonths(month, 1); load(); } }, icon('right')),
    h('div', { class: 'spacer' }), edit ? h('button', { class: 'btn sm primary', onclick: add }, icon('plus', 14), 'Add adjustment') : null), holder);
  async function load() {
    label.textContent = monthLabel(month);
    const rows = await api.get('/api/adjustments', { month });
    clear(holder, card(null, rows.length ? table({
      rows,
      footer: (list) => h('tr', null, h('td', null, 'Total'), h('td'), h('td'), h('td', { class: 'num' }, money(list.reduce((a, r) => a + (r.kind === 'deduction' ? -r.amount : r.amount), 0))), h('td')),
      columns: [
        { key: 'name', label: 'Employee', sort: true },
        { key: 'title', label: 'Item' },
        { key: 'kind', label: 'Type', render: (r) => badge(r.kind === 'earning' ? 'Addition' : 'Deduction', r.kind === 'earning' ? 'ok' : 'bad') },
        { key: 'amount', label: 'Amount', num: true, render: (r) => `${r.kind === 'deduction' ? '−' : ''}${money(r.amount)}` },
        edit ? { key: 'x', label: '', render: (r) => h('button', { class: 'icon-btn', onclick: async () => { try { await api.del(`/api/adjustments/${r.id}`); load(); } catch (err) { errorToast(err); } } }, icon('trash', 14)) } : null,
      ].filter(Boolean),
    }) : empty(`Nothing for ${monthLabel(month)}`, 'Bonuses, fines, arrears and reimbursements for one month go here.', edit ? h('button', { class: 'btn primary', onclick: add }, icon('plus', 16), 'Add adjustment') : null, 'coins'), { flush: true }));
  }
  await load();
}

async function increments(body) {
  const selected = new Set();
  const people = S.lookups.employees.filter((e) => e.status !== 'exited');
  const list = h('div', { style: { maxHeight: '360px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '10px', padding: '6px 10px' } },
    h('label', { class: 'check strong' }, h('input', { type: 'checkbox', onchange: (e) => { list.querySelectorAll('input[data-id]').forEach((c) => { c.checked = e.target.checked; if (c.checked) selected.add(Number(c.dataset.id)); else selected.delete(Number(c.dataset.id)); }); } }), 'Everyone'),
    people.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { id: p.id }, onchange: (e) => { if (e.target.checked) selected.add(p.id); else selected.delete(p.id); } }), `${p.name} · ${p.emp_code}`)));
  const pct = h('input', { class: 'input num', type: 'number', step: 'any', placeholder: 'e.g. 10' });
  const amt = h('input', { class: 'input num', type: 'number', step: 'any', placeholder: 'or a fixed amount' });
  const eff = h('input', { class: 'input', type: 'date', value: `${addMonths(todayLocal().slice(0, 7), 1)}-01` });
  const reason = h('input', { class: 'input', value: 'Annual increment' });
  const go = h('button', {
    class: 'btn primary',
    onclick: async () => {
      if (!selected.size) { errorToast(new Error('Choose at least one person.')); return; }
      if (!(await confirmDialog(`Give ${selected.size} people a new salary from ${eff.value}?`, { ok: 'Apply' }))) return;
      try {
        const r = await api.post('/api/salary/bulk-revision', { employee_ids: [...selected], percent: pct.value ? Number(pct.value) : null, amount: amt.value ? Number(amt.value) : null, effective_from: eff.value, reason: reason.value });
        toast(`${r.updated} salaries revised${r.updated < selected.size ? ` (${selected.size - r.updated} had no salary yet)` : ''}`);
      } catch (err) { errorToast(err); }
    },
  }, icon('check', 16), 'Apply increment');
  body.append(h('div', { class: 'grid grid-2' },
    card('Who', list),
    card('Increment', h('div', { class: 'form one' },
      h('div', { class: 'field' }, h('label', null, 'Increase gross by %'), pct),
      h('div', { class: 'field' }, h('label', null, `Or add a fixed amount (${S.me.org.currency})`), amt),
      h('div', { class: 'field' }, h('label', null, 'Effective from'), eff),
      h('div', { class: 'field' }, h('label', null, 'Reason'), reason),
      h('p', { class: 'small muted' }, 'A new salary revision is added for each person, based on their latest salary. Components that are a % of gross follow automatically; fixed amounts grow by the same percentage.'),
      h('div', null, go)))));
}
