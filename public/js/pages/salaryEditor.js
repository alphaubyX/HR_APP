// Salary editor: pick a structure, enter the gross, adjust components and see the amounts live.
import { api } from '../api.js';
import { S } from '../state.js';
import { h, clear, icon, money, alertBox, popMenu } from '../ui.js';

const CALC_LABEL = { fixed: 'Fixed amount', percent: '% of', formula: 'Formula', remainder: 'Rest of gross' };

/**
 * Returns { el, value(): { gross, structure_id, lines }, ready: Promise }.
 * initial: { gross, structure_id, lines: [{ component_id, calc, value, percent_of, formula }] }
 */
export function salaryEditor(initial = {}) {
  const comps = (S.lookups.components || []).filter((c) => c.active);
  const structures = (S.lookups.structures || []).filter((s) => s.active);
  let lines = (initial.lines || []).map((l) => ({ ...l }));
  let structureId = initial.structure_id || (structures[0] && structures[0].id) || '';
  const gross = h('input', { class: 'input num', type: 'number', min: 0, step: '1', value: initial.gross ?? '', placeholder: 'e.g. 120000', inputmode: 'decimal' });
  const structSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Custom (no structure)'), structures.map((s) => h('option', { value: s.id, selected: s.id === Number(structureId) }, s.name)));
  const body = h('tbody');
  const totals = h('div', { class: 'row wrap gap-16 mt-16' });
  const errors = h('div');
  let timer = null;

  async function loadStructure(id) {
    structureId = id;
    if (!id) return;
    lines = (await api.get(`/api/salary-structures/${id}/lines`)).map((l) => ({ ...l }));
    draw();
  }
  structSel.addEventListener('change', () => loadStructure(structSel.value));
  gross.addEventListener('input', schedule);

  function schedule() { clearTimeout(timer); timer = setTimeout(preview, 250); }

  async function preview() {
    if (!lines.length) { clear(totals); clear(errors); return; }
    try {
      const r = await api.post('/api/salary/preview', { gross: Number(gross.value) || 0, lines });
      r.lines.forEach((l, i) => { const cell = body.querySelector(`[data-amt="${i}"]`); if (cell) cell.textContent = money(l.amount); });
      const g = Number(gross.value) || 0;
      clear(totals,
        h('div', null, h('div', { class: 'tiny muted' }, 'Monthly earnings'), h('div', { class: 'strong num', style: { fontSize: '18px' } }, money(r.earnings, { symbol: true }))),
        r.deductions ? h('div', null, h('div', { class: 'tiny muted' }, 'Fixed deductions'), h('div', { class: 'strong num', style: { fontSize: '18px' } }, money(r.deductions))) : null,
        r.employer ? h('div', null, h('div', { class: 'tiny muted' }, 'Employer contributions'), h('div', { class: 'strong num', style: { fontSize: '18px' } }, money(r.employer))) : null,
        g && Math.abs(r.earnings - g) > 0.5 ? h('span', { class: 'badge warn' }, `Earnings differ from the gross by ${money(r.earnings - g)}`) : null);
      clear(errors, r.errors.length ? alertBox(r.errors.join(' '), 'bad', 'alert') : null);
    } catch (err) {
      clear(errors, alertBox(err.message, 'bad', 'alert'));
    }
  }

  function draw() {
    const codes = comps.map((c) => c.code);
    clear(body, lines.map((l, i) => {
      const c = comps.find((x) => x.id === Number(l.component_id)) || (S.lookups.components || []).find((x) => x.id === Number(l.component_id));
      const calc = h('select', { class: 'input sm', onchange: (e) => { l.calc = e.target.value; draw(); schedule(); } },
        Object.entries(CALC_LABEL).map(([k, v]) => h('option', { value: k, selected: k === l.calc }, v)));
      let input = null;
      if (l.calc === 'fixed') input = h('input', { class: 'input sm num', type: 'number', step: 'any', value: l.value ?? 0, oninput: (e) => { l.value = Number(e.target.value) || 0; schedule(); } });
      else if (l.calc === 'percent') {
        input = h('div', { class: 'row gap-4' },
          h('input', { class: 'input sm num', type: 'number', step: 'any', value: l.value ?? 0, style: { width: '80px' }, oninput: (e) => { l.value = Number(e.target.value) || 0; schedule(); } }),
          h('span', { class: 'muted small' }, '% of'),
          h('select', { class: 'input sm', onchange: (e) => { l.percent_of = e.target.value; schedule(); } },
            ['GROSS', ...codes.filter((x) => x !== (c && c.code))].map((x) => h('option', { value: x, selected: (l.percent_of || 'GROSS') === x }, x === 'GROSS' ? 'Gross' : x))));
      } else if (l.calc === 'formula') input = h('input', { class: 'input sm mono', value: l.formula || '', placeholder: 'e.g. BASIC * 0.45', oninput: (e) => { l.formula = e.target.value; schedule(); } });
      else input = h('span', { class: 'muted small' }, 'Whatever is left of the gross');
      return h('tr', null,
        h('td', null, h('div', { class: 'strong' }, c ? c.name : 'Unknown'), h('div', { class: 'tiny muted mono' }, c ? `${c.code} · ${c.kind}` : '')),
        h('td', { style: { width: '150px' } }, calc),
        h('td', null, input),
        h('td', { class: 'num strong', 'data-amt': i }, '…'),
        h('td', { style: { width: '40px' } }, h('button', { class: 'icon-btn', type: 'button', title: 'Remove', onclick: () => { lines.splice(i, 1); draw(); schedule(); } }, icon('x', 16))));
    }));
    schedule();
  }

  const addBtn = h('button', {
    class: 'btn sm', type: 'button',
    onclick: (e) => {
      const free = comps.filter((c) => !lines.some((l) => Number(l.component_id) === c.id));
      if (!free.length) return;
      popMenu(e.currentTarget, free.map((c) => ({ label: `${c.name} (${c.kind})`, onClick: () => { lines.push({ component_id: c.id, calc: c.calc, value: c.value, percent_of: c.percent_of, formula: c.formula }); draw(); } })));
    },
  }, icon('plus', 14), 'Add component');

  const el = h('div', null,
    h('div', { class: 'form' },
      h('div', { class: 'field' }, h('label', null, 'Monthly gross salary'), h('div', { class: 'input-group' }, gross, h('span', { class: 'addon' }, S.me.org.currency)),
        h('div', { class: 'help' }, 'Components marked "% of Gross" or "Rest of gross" are worked out from this.')),
      h('div', { class: 'field' }, h('label', null, 'Salary structure'), structSel, h('div', { class: 'help' }, 'Choosing a structure fills in its components.'))),
    h('div', { class: 'table-wrap mt-16', style: { border: '1px solid var(--line)', borderRadius: '10px' } },
      h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Component'), h('th', null, 'Calculation'), h('th', null, 'Value'), h('th', { class: 'num' }, 'Monthly'), h('th'))), body)),
    h('div', { class: 'row mt-8' }, addBtn, h('span', { class: 'tiny muted' }, 'Manage components under Settings → Salary components.')),
    totals, errors);

  let ready;
  if (!lines.length && structureId) ready = loadStructure(structureId);
  else { draw(); ready = Promise.resolve(); }

  return {
    el,
    ready,
    value: () => ({ gross: Number(gross.value) || 0, structure_id: structureId ? Number(structureId) : null, lines }),
  };
}
