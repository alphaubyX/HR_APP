// Settings pages for who may do what: roles & rights, and approval workflows.
import { api } from '../api.js';
import { loadMe, S } from '../state.js';
import {
  h, clear, icon, card, badge, formModal, toast, errorToast, confirmDialog, alertBox, modal, empty,
} from '../ui.js';

/* ------------------------------------------------------------------ roles & rights */
export async function roles(body, ctx) {
  const data = await api.get('/api/roles');
  const { permissions, canEdit } = data;
  let list = data.roles;
  const groups = [...new Set(permissions.map((p) => p.group))];

  const addRole = async () => {
    const ok = await formModal({
      title: 'Add a role', one: true,
      intro: h('p', { class: 'muted small' }, 'For example “Chief Executive”, “Branch manager” or “Accounts”. Tick its rights in the table afterwards.'),
      fields: [
        { name: 'name', label: 'Role name', required: true },
        { name: 'description', label: 'What it is for', placeholder: 'Optional' },
        { name: 'copy_from', label: 'Start with the rights of', type: 'select', placeholder: '— No rights —', options: list.map((r) => [r.role_key, r.name]) },
      ],
      onSubmit: (v) => api.post('/api/roles', v),
    });
    if (ok) { toast('Role added'); ctx.reload(); }
  };

  const editRole = async (r) => {
    const ok = await formModal({
      title: `Edit ${r.name}`, one: true,
      fields: [{ name: 'name', label: 'Role name', required: true }, { name: 'description', label: 'What it is for' }],
      values: r,
      onSubmit: (v) => api.put(`/api/roles/${r.id}`, v),
      danger: r.is_system ? null : {
        label: 'Delete role',
        onClick: async () => {
          if (!(await confirmDialog(`Delete the ${r.name} role?`, { danger: true, ok: 'Delete' }))) return false;
          try { await api.del(`/api/roles/${r.id}`); toast('Role deleted'); return true; } catch (err) { errorToast(err); return false; }
        },
      },
    });
    if (ok) { toast(ok === 'deleted' ? 'Role deleted' : 'Saved'); ctx.reload(); }
  };

  const toggle = async (r, perm, on, box) => {
    const perms = on ? [...r.perms, perm] : r.perms.filter((p) => p !== perm);
    box.disabled = true;
    try {
      await api.put(`/api/roles/${r.id}`, { perms });
      r.perms = perms;
      toast(`${r.name}: ${on ? 'can now' : 'can no longer'} ${permissions.find((p) => p.key === perm).label.toLowerCase()}`);
      if (r.role_key === S.me.role) await loadMe();
    } catch (err) { box.checked = !on; errorToast(err); }
    box.disabled = false;
  };

  const head = h('tr', null, h('th', { class: 'rights-label' }, 'Right'), list.map((r) => h('th', { class: 'rights-role' },
    h('button', { class: 'linkish', type: 'button', disabled: !canEdit, onclick: () => editRole(r), title: r.description || '' }, r.name),
    h('div', { class: 'tiny muted' }, `${r.members} ${r.members === 1 ? 'person' : 'people'}`))));
  const rows = groups.flatMap((g) => [
    h('tr', { class: 'rights-group' }, h('td', { colspan: String(list.length + 1) }, g)),
    ...permissions.filter((p) => p.group === g).map((p) => h('tr', null,
      h('td', { class: 'rights-label' }, p.label),
      list.map((r) => {
        const box = h('input', { type: 'checkbox', checked: r.locked || r.perms.includes(p.key), disabled: !canEdit || r.locked, 'aria-label': `${r.name}: ${p.label}` });
        box.addEventListener('change', () => toggle(r, p.key, box.checked, box));
        return h('td', { class: 'rights-cell' }, box);
      }))),
  ]);

  body.append(card('Roles & rights', h('div', null,
    h('div', { style: { padding: '14px 18px 0' } }, alertBox(h('div', null,
      'Tick what each role may do. Changes save straight away and apply the next time people open a page. ',
      'Administrator always has every right. Line managers need no role: anyone with people under them on the organogram sees their team and approves their requests.',
      canEdit ? null : h('div', { class: 'mt-8 strong' }, 'Only an administrator can change rights.')), 'info', 'shield')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table rights' }, h('thead', null, head), h('tbody', null, rows)))),
  { flush: true, actions: canEdit ? h('button', { class: 'btn sm primary', onclick: addRole }, icon('plus', 14), 'Add role') : null }));
}

/* ------------------------------------------------------------------ approval workflows */
export async function workflows(body, ctx) {
  const data = await api.get('/api/workflows');
  const byAction = new Map(data.workflows.map((w) => [w.action, w]));
  const roleName = (k) => (data.roles.find((r) => r.role_key === k) || {}).name || k;
  const userName = (id) => (data.users.find((u) => u.id === id) || {}).name || 'Someone without access';
  const stepLabel = (s) => (s.type === 'role' ? roleName(s.role_key) : s.type === 'user' ? userName(s.user_id) : data.stepTypes[s.type]);

  const chain = (a, w) => h('div', { class: 'chain' },
    h('span', { class: 'step done', title: `Anyone whose role has this right: ${a.initiators.join(', ')}` }, icon('user', 12), 'Initiator'),
    (w ? w.steps : []).map((s) => h('span', { class: 'step' }, icon('shield', 12), stepLabel(s))),
    !w || !w.steps.length ? h('span', { class: 'tiny muted' }, 'no approvers yet') : null);

  const groups = [...new Set(data.actions.map((a) => a.group))];
  for (const g of groups) {
    const actions = data.actions.filter((a) => a.group === g);
    body.append(card(g, h('ul', { class: 'list' }, actions.map((a) => {
      const w = byAction.get(a.key);
      return h('li', { class: 'click', onclick: () => edit(a) },
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'strong' }, a.label), h('div', { class: 'mt-8' }, chain(a, w))),
        w && w.active ? badge('On', 'ok', { dot: true }) : badge('Off'));
    })), { flush: true, className: 'mb-16' }));
  }
  body.prepend(h('div', { class: 'mb-16' }, alertBox(h('div', null,
    'Choose which actions need approval and who approves them, in order. When a workflow is on, the action waits in ',
    h('a', { href: '#/approvals' }, 'Approvals'), ' and only happens after the last approver agrees. ',
    'Nobody approves their own request: a step whose only approver is the initiator is skipped.'), 'info', 'layers')));

  function edit(a) {
    const w = byAction.get(a.key);
    const steps = (w ? w.steps : []).map((s) => ({ ...s }));
    const active = h('input', { type: 'checkbox', checked: w ? w.active : true });
    const list = h('div', { class: 'col gap-8' });
    const errBox = h('div');
    const draw = () => {
      clear(list, steps.length ? steps.map((s, i) => {
        const type = h('select', { class: 'input sm' }, Object.entries(data.stepTypes).map(([k, l]) => h('option', { value: k, selected: k === s.type }, l)));
        const target = s.type === 'role'
          ? h('select', { class: 'input sm' }, h('option', { value: '' }, '— Choose a role —'), data.roles.map((r) => h('option', { value: r.role_key, selected: r.role_key === s.role_key }, r.name)))
          : s.type === 'user'
            ? h('select', { class: 'input sm' }, h('option', { value: '' }, '— Choose a person —'), data.users.map((u) => h('option', { value: u.id, selected: u.id === s.user_id }, u.name)))
            : null;
        type.addEventListener('change', () => { s.type = type.value; delete s.role_key; delete s.user_id; draw(); });
        if (target) target.addEventListener('change', () => { if (s.type === 'role') s.role_key = target.value; else s.user_id = Number(target.value) || null; });
        const move = (d) => { const j = i + d; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; draw(); };
        return h('div', { class: 'wf-step' },
          h('span', { class: 'wf-num' }, String(i + 1)),
          h('div', { class: 'grow row', style: { gap: '8px', flexWrap: 'wrap' } }, type, target),
          h('button', { class: 'icon-btn', type: 'button', title: 'Earlier', disabled: i === 0, onclick: () => move(-1) }, icon('up', 16)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Later', disabled: i === steps.length - 1, onclick: () => move(1) }, icon('down', 16)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Remove', onclick: () => { steps.splice(i, 1); draw(); } }, icon('trash', 16)));
      }) : empty('No approvers yet', 'Add the first person or role who must approve.', null, 'shield'));
    };
    draw();
    const save = h('button', { class: 'btn primary' }, 'Save');
    const m = modal({
      title: a.label, size: 'lg',
      body: h('div', null,
        h('div', { class: 'wf-step initiator' }, h('span', { class: 'wf-num' }, icon('user', 14)),
          h('div', { class: 'grow' }, h('div', { class: 'strong' }, 'Initiator'), h('div', { class: 'tiny muted' }, `Anyone whose role has the right to do this: ${a.initiators.join(', ') || 'nobody yet'}. Change rights under Roles & rights.`))),
        h('div', { class: 'mt-8' }, list),
        h('button', { class: 'btn sm mt-8', type: 'button', onclick: () => { steps.push({ type: 'role', role_key: '' }); draw(); } }, icon('plus', 14), 'Add approver'),
        h('label', { class: 'row mt-16', style: { gap: '8px' } }, active, h('span', null, 'Workflow on: this action needs these approvals')),
        errBox),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      clear(errBox);
      try {
        await api.put(`/api/workflows/${a.key}`, { active: active.checked, steps });
        toast(active.checked ? `${a.label} now needs approval` : 'Saved');
        m.close();
        ctx.reload();
      } catch (err) { clear(errBox, h('div', { class: 'mt-16' }, alertBox(err.message, 'bad', 'alert'))); save.disabled = false; }
    });
  }
}
