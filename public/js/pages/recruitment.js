// Recruitment: job openings, candidates with PDF CVs, the public application link, and the AI helper.
import { api } from '../api.js';
import { S, loadLookups, navigate, options, employeeOptions } from '../state.js';
import {
  h, clear, icon, pageHead, card, badge, empty, modal, toast, errorToast, confirmDialog, buildForm, alertBox, money, date,
  sentence, utcToLocal, pickFile, readFile, kv, spinner,
} from '../ui.js';

const STATUS = { open: ['Open', 'ok'], on_hold: ['On hold', 'warn'], closed: ['Closed', ''], filled: ['Filled', 'brand'] };
const STAGE_KIND = { new: 'info', shortlisted: 'brand', interview: 'violet', offer: 'warn', hired: 'ok', rejected: 'bad' };
const REC = { shortlist: ['Shortlist', 'ok'], maybe: ['Maybe', 'warn'], reject: ['Not a fit', 'bad'] };
const SOURCES = ['Applied online', 'CV upload', 'Referral', 'Walk-in', 'Email'];

export default async function recruitment(view, params) {
  await loadLookups();
  if (params.id) return openingPage(view, Number(params.id));
  return listPage(view);
}

/* ------------------------------------------------------------------ helpers */
const salaryText = (o) => {
  if (!o.salary_min && !o.salary_max) return null;
  if (o.salary_min && o.salary_max) return `${money(o.salary_min)} – ${money(o.salary_max)}`;
  return o.salary_min ? `From ${money(o.salary_min)}` : `Up to ${money(o.salary_max)}`;
};
function deadlineBadge(d) {
  if (!d) return null;
  const days = Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);
  if (days < 0) return badge(`Closed for applications ${date(d)}`, '');
  if (days === 0) return badge('Last day to apply', 'warn');
  return badge(`${days} day${days === 1 ? '' : 's'} left · ${date(d, { year: false })}`, days <= 3 ? 'warn' : 'info');
}
const publicLink = (o) => `${location.origin}/apply/${o.public_token}`;
async function copy(text, what = 'Link') {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { window.prompt('Copy this:', text); }
}
function scoreChip(c) {
  if (!c.ai) return null;
  const s = c.ai_score;
  const kind = s >= 8 ? 'ok' : s >= 5 ? 'warn' : 'bad';
  return h('span', { class: ['fit', kind], title: `AI fit score ${s}/10 · ${REC[c.ai_recommendation] ? REC[c.ai_recommendation][0] : ''}` }, String(s));
}

/* ------------------------------------------------------------------ list of openings */
async function listPage(view) {
  const data = await api.get('/api/recruitment/openings');
  view.append(pageHead('Recruitment', {
    sub: 'Job openings and the people who apply for them.',
    actions: [h('button', { class: 'btn primary', onclick: () => editOpening(null, data.platforms) }, icon('plus', 16), 'New job opening')],
  }));
  if (!data.ai) view.append(h('div', { class: 'mb-16' }, alertBox('The AI helper that reads CVs is not switched on yet. The server owner turns it on by adding an Anthropic API key (ANTHROPIC_API_KEY).', 'info', 'info')));
  if (!data.openings.length) {
    view.append(card(null, empty('No job openings yet', 'Open a job for a new position or for someone’s existing position on the organogram.',
      h('button', { class: 'btn primary', onclick: () => editOpening(null, data.platforms) }, icon('plus', 16), 'New job opening'), 'briefcase')));
    return;
  }
  view.append(h('div', { class: 'job-grid' }, data.openings.map((o) => {
    const [label, kind] = STATUS[o.status] || [o.status, ''];
    return h('a', { class: 'card job-card', href: `#/recruitment/${o.id}` },
      h('div', { class: 'row', style: { alignItems: 'flex-start' } },
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('h3', { class: 'ellipsis' }, o.title),
          h('div', { class: 'small muted ellipsis' }, [o.department, o.location].filter(Boolean).join(' · ') || '—')),
        badge(label, kind, { dot: true })),
      h('div', { class: 'row mt-8', style: { flexWrap: 'wrap', gap: '6px' } }, deadlineBadge(o.deadline), salaryText(o) ? h('span', { class: 'chip' }, icon('banknote', 13), salaryText(o)) : null),
      h('div', { class: 'job-stats' },
        h('div', null, h('strong', null, String(o.candidates)), h('span', null, o.candidates === 1 ? 'candidate' : 'candidates')),
        h('div', null, h('strong', null, String(o.stages.shortlisted || 0)), h('span', null, 'shortlisted')),
        h('div', null, h('strong', null, String(o.stages.interview || 0)), h('span', null, 'interview')),
        h('div', null, h('strong', null, String(o.stages.hired || 0)), h('span', null, 'hired'))),
      o.advertised && o.platforms.length ? h('div', { class: 'tiny muted mt-8 ellipsis' }, `Advertised on ${o.platforms.join(', ')}`) : null);
  })));
}

/* ------------------------------------------------------------------ add / edit an opening */
function editOpening(o, platforms, onSaved = null) {
  const chosen = new Set(o ? o.platforms : []);
  const platformBox = h('div', { class: 'chip-picks' }, platforms.map((p) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(p) });
    box.addEventListener('change', () => { if (box.checked) chosen.add(p); else chosen.delete(p); });
    return h('label', { class: 'chip-pick' }, box, h('span', null, p));
  }));
  const sectionOpts = () => {
    const depts = new Map((S.lookups.departments || []).map((d) => [d.id, d.name]));
    return (S.lookups.sections || []).filter((x) => x.active).map((x) => [x.id, `${depts.get(x.department_id) || '—'} › ${x.name}`]);
  };
  let form;
  form = buildForm([
    { name: 'kind', label: 'This job is for', type: 'select', full: true, options: [['new', 'A new position'], ['existing', 'An existing position on the organogram (replacing someone)']] },
    { name: 'replaces_employee_id', label: 'Replacing', type: 'select', placeholder: '— Choose the person —', numeric: true, full: true, options: () => employeeOptions({ includeExited: true }), show: (v) => v.kind === 'existing', help: 'Fills in their title, department and designation.' },
    { name: 'title', label: 'Job title', required: true, full: true, placeholder: 'e.g. Accounts Officer' },
    { name: 'description', label: 'Description', type: 'textarea', rows: 6, full: true, placeholder: 'What the job involves and what you are looking for. The AI helper compares CVs with this.' },
    { name: 'department_id', label: 'Department', type: 'select', placeholder: '—', numeric: true, options: () => options('departments') },
    { name: 'section_id', label: 'Section', type: 'select', placeholder: '— None —', numeric: true, options: sectionOpts },
    { name: 'designation_id', label: 'Designation', type: 'select', placeholder: '—', numeric: true, options: () => options('designations') },
    { name: 'positions', label: 'How many people', type: 'number', min: 1 },
    { name: 'salary_min', label: 'Salary from (monthly)', type: 'money' },
    { name: 'salary_max', label: 'Salary to (monthly)', type: 'money' },
    { name: 'branch_id', label: 'Office', type: 'select', placeholder: '—', numeric: true, options: () => options('branches') },
    { name: 'location', label: 'Location', placeholder: 'e.g. Lahore, or Remote' },
    { name: 'deadline', label: 'Last date to apply', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS).map(([k, [l]]) => [k, l]) },
    { name: 'advertised', label: 'The job is advertised', type: 'checkbox', full: true },
    { key: 'platformsNode', node: h('div', null, h('div', { class: 'small strong mb-8' }, 'Where it is advertised'), platformBox), show: (v) => v.advertised },
    { name: 'ad_link', label: 'Link to the advert (optional)', full: true, placeholder: 'https://…', show: (v) => v.advertised },
    { name: 'accept_online', label: 'Candidates can apply online', type: 'checkbox', full: true, help: 'You get a link to share in your adverts. Candidates upload a PDF CV there.' },
  ], o ? { ...o, kind: o.replaces_employee_id ? 'existing' : 'new' } : { kind: 'new', positions: 1, status: 'open', accept_online: true }, {
    onChange: (v, name) => {
      if (name === 'branch_id' && v.branch_id && !v.location) form.set('location', (S.lookups.branches.find((b) => b.id === v.branch_id) || {}).name || '');
      if (name !== 'replaces_employee_id' || !v.replaces_employee_id) return;
      const e = S.lookups.employees.find((x) => x.id === v.replaces_employee_id);
      if (!e) return;
      if (e.department_id) form.set('department_id', e.department_id);
      if (e.section_id) form.set('section_id', e.section_id);
      if (e.designation_id) {
        form.set('designation_id', e.designation_id);
        if (!v.title) form.set('title', (S.lookups.designations.find((d) => d.id === e.designation_id) || {}).name || '');
      }
      if (e.branch_id) form.set('branch_id', e.branch_id);
    },
  });
  const err = h('div');
  const save = h('button', { class: 'btn primary' }, o ? 'Save' : 'Open the job');
  const m = modal({ title: o ? `Edit ${o.title}` : 'New job opening', size: 'lg', body: h('div', null, form.el, err), actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save] });
  save.addEventListener('click', async () => {
    if (!form.validate()) return;
    const v = form.values();
    if (v.kind !== 'existing') v.replaces_employee_id = null;
    delete v.kind;
    v.platforms = v.advertised ? [...chosen] : [];
    save.disabled = true;
    clear(err);
    try {
      const out = o ? await api.put(`/api/recruitment/openings/${o.id}`, v) : await api.post('/api/recruitment/openings', v);
      m.close();
      if (out && out.pending) { navigate('/approvals?tab=sent'); return; }
      toast(o ? 'Saved' : 'Job opened');
      if (onSaved) onSaved(); else navigate(`/recruitment/${out.id}`);
    } catch (e) { clear(err, h('div', { class: 'mt-16' }, alertBox(e.message, 'bad', 'alert'))); save.disabled = false; }
  });
}

/* ------------------------------------------------------------------ one opening */
async function openingPage(view, id) {
  const data = await api.get(`/api/recruitment/openings/${id}`);
  const o = data.opening;
  const reload = () => navigate(`/recruitment/${id}`);
  const [label, kind] = STATUS[o.status] || [o.status, ''];
  view.append(pageHead(o.title, {
    crumbs: [{ label: 'Recruitment', href: '#/recruitment' }, { label: o.title }],
    sub: [o.department && o.department.name, o.section && o.section.name, o.location].filter(Boolean).join(' · ') || null,
    actions: [
      o.accept_online ? h('button', { class: 'btn', onclick: () => copy(publicLink(o), 'Application link') }, icon('link', 16), 'Copy application link') : null,
      h('button', { class: 'btn', onclick: () => editOpening(o, data.platforms, reload) }, icon('edit', 16), 'Edit'),
    ].filter(Boolean),
  }));

  const info = card('About the job', h('div', null,
    h('div', { class: 'row mb-16', style: { flexWrap: 'wrap', gap: '6px' } }, badge(label, kind, { dot: true }), deadlineBadge(o.deadline), o.positions > 1 ? badge(`${o.positions} positions`, 'info') : null),
    kv([
      ['Designation', o.designation && o.designation.name],
      o.replaces ? ['Replacing', h('a', { href: `#/employees/${o.replaces.id}` }, o.replaces.name)] : ['Position', 'New position'],
      ['Salary (monthly)', salaryText(o)],
      ['Office', o.branch && o.branch.name],
      ['Advertised', o.advertised ? (o.platforms.join(', ') || 'Yes') : 'No'],
      o.ad_link ? ['Advert', h('a', { href: o.ad_link, target: '_blank', rel: 'noopener' }, 'Open the advert')] : null,
      o.accept_online ? ['Apply online', h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, h('code', { class: 'small ellipsis', style: { maxWidth: '260px' } }, publicLink(o)), h('button', { class: 'btn sm', onclick: () => copy(publicLink(o), 'Application link') }, icon('copy', 13), 'Copy'))] : ['Apply online', 'Off'],
    ]),
    o.description ? h('div', { class: 'job-desc mt-16' }, o.description) : null,
    h('div', { class: 'row mt-16' }, h('button', {
      class: 'btn sm danger', onclick: async () => {
        if (!(await confirmDialog(`Delete the ${o.title} opening?`, { danger: true, ok: 'Delete', detail: `Its ${data.candidates.length} candidate${data.candidates.length === 1 ? '' : 's'} and their CVs are deleted too.` }))) return;
        try { await api.del(`/api/recruitment/openings/${o.id}`); toast('Opening deleted'); navigate('/recruitment'); } catch (e) { errorToast(e); }
      },
    }, icon('trash', 14), 'Delete opening'))));

  const cands = data.candidates;
  const waiting = cands.filter((c) => c.has_cv && !c.ai);
  const aiNote = data.ai ? null : h('div', { style: { padding: '0 18px 12px' } }, alertBox('The AI helper is not switched on, so CVs are not read automatically. The server owner adds an ANTHROPIC_API_KEY to turn it on.', 'info', 'info'));
  const tools = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
    data.ai && waiting.length ? h('button', { class: 'btn sm', onclick: (e) => readAll(e.currentTarget, waiting, reload) }, icon('star', 14), `AI: read ${waiting.length} new CV${waiting.length === 1 ? '' : 's'}`) : null,
    data.ai && cands.filter((c) => c.ai).length >= 2 ? h('button', { class: 'btn sm', onclick: () => compare(o, reload) }, icon('chart', 14), 'AI: compare candidates') : null,
    h('button', { class: 'btn sm', onclick: () => bulkUpload(o, reload) }, icon('upload', 14), 'Upload CVs'),
    h('button', { class: 'btn sm primary', onclick: () => addCandidate(o, data.platforms, reload) }, icon('plus', 14), 'Add candidate'));

  const table = cands.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, ['Candidate', 'AI fit', 'Stage', 'Source', 'CV', 'Received'].map((t) => h('th', null, t)))),
    h('tbody', null, cands.map((c) => {
      const stage = h('select', { class: 'input sm', style: { width: '130px' }, onclick: (e) => e.stopPropagation() }, data.stages.map((s) => h('option', { value: s, selected: s === c.stage }, sentence(s))));
      stage.addEventListener('change', async () => { try { await api.put(`/api/recruitment/candidates/${c.id}`, { stage: stage.value }); toast(`${c.name}: ${sentence(stage.value)}`); } catch (e) { errorToast(e); } });
      return h('tr', { class: 'click', onclick: () => candidateDetail(c, o, data, reload) },
        h('td', null, h('div', { class: 'strong' }, c.name), h('div', { class: 'tiny muted' }, [c.email, c.phone].filter(Boolean).join(' · '))),
        h('td', null, c.ai ? h('div', { class: 'row', style: { gap: '6px' } }, scoreChip(c), REC[c.ai_recommendation] ? badge(REC[c.ai_recommendation][0], REC[c.ai_recommendation][1]) : null) : h('span', { class: 'faint' }, c.has_cv ? 'Not read yet' : '—')),
        h('td', null, stage),
        h('td', { class: 'small' }, c.source || '—'),
        h('td', null, c.has_cv ? h('a', { href: `/api/recruitment/candidates/${c.id}/cv`, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), class: 'row small', style: { gap: '4px' } }, icon('file', 14), 'PDF')
          : c.cv_deleted_at ? h('span', { class: 'tiny muted', title: 'CVs are deleted after one year' }, 'Deleted') : h('span', { class: 'faint' }, '—')),
        h('td', { class: 'small muted' }, utcToLocal(c.created_at).slice(0, 12)));
    })))) : empty('No candidates yet', o.accept_online ? 'Share the application link in your adverts, or add candidates and their CVs yourself.' : 'Add candidates and their CVs.', null, 'users');

  view.append(h('div', { class: 'grid grid-side rec-layout' }, card(`Candidates (${cands.length})`, h('div', null, aiNote, table), { flush: true, actions: tools }), info));
}

/* ------------------------------------------------------------------ candidates */
async function pickCv() {
  const file = await pickFile('application/pdf,.pdf');
  if (!file) return null;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('CVs must be PDF files.');
  if (file.size > 5 * 1024 * 1024) throw new Error('CVs can be at most 5 MB.');
  return { name: file.name, data: await readFile(file, false) };
}

function addCandidate(o, platforms, reload) {
  let cv = null;
  const cvLabel = h('span', { class: 'small muted' }, 'No file chosen');
  const form = buildForm([
    { name: 'name', label: 'Name', required: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone' },
    { name: 'source', label: 'Where they came from', type: 'select', options: [...SOURCES, ...platforms.filter((p) => !SOURCES.includes(p))] },
    { key: 'cv', node: h('div', null, h('div', { class: 'small strong mb-8' }, 'CV (PDF only)'), h('div', { class: 'row', style: { gap: '10px' } },
      h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { cv = await pickCv(); if (cv) cvLabel.textContent = cv.name; } catch (e) { errorToast(e); } } }, icon('upload', 14), 'Choose PDF'), cvLabel)) },
  ], { source: 'Email' });
  const err = h('div');
  const save = h('button', { class: 'btn primary' }, 'Add');
  const m = modal({ title: `Add a candidate for ${o.title}`, body: h('div', null, form.el, err), actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save] });
  save.addEventListener('click', async () => {
    if (!form.validate()) return;
    save.disabled = true;
    try { await api.post(`/api/recruitment/openings/${o.id}/candidates`, { ...form.values(), cv }); m.close(); toast('Candidate added'); reload(); } catch (e) { clear(err, h('div', { class: 'mt-16' }, alertBox(e.message, 'bad', 'alert'))); save.disabled = false; }
  });
}

/** Several PDF CVs at once: one candidate each, named after the file until the AI reads the name. */
function bulkUpload(o, reload) {
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.remove();
    if (!files.length) return;
    let ok = 0;
    const problems = [];
    for (const f of files) {
      try {
        if (!/\.pdf$/i.test(f.name)) throw new Error('not a PDF');
        if (f.size > 5 * 1024 * 1024) throw new Error('larger than 5 MB');
        const name = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\b(cv|resume)\b/ig, '').trim() || 'Candidate';
        await api.post(`/api/recruitment/openings/${o.id}/candidates`, { name, source: 'CV upload', cv: { name: f.name, data: await readFile(f, false) } });
        ok++;
      } catch (e) { problems.push(`${f.name}: ${e.message}`); }
    }
    toast(problems.length ? `${ok} added. Not added: ${problems.join('; ')}` : `${ok} CV${ok === 1 ? '' : 's'} added`, problems.length ? 'bad' : 'ok');
    reload();
  });
  document.body.append(input);
  input.click();
}

async function readAll(btn, list, reload) {
  btn.disabled = true;
  let done = 0;
  for (const c of list) {
    btn.lastChild.textContent = ` AI is reading ${done + 1} of ${list.length}…`;
    try { await api.post(`/api/recruitment/candidates/${c.id}/analyze`, {}); done++; } catch (e) { errorToast(e); break; }
  }
  toast(`AI read ${done} CV${done === 1 ? '' : 's'}`);
  reload();
}

async function compare(o) {
  const body = h('div', null, h('div', { class: 'row', style: { gap: '10px' } }, spinner(), h('span', { class: 'muted' }, 'The AI is comparing the candidates…')));
  const m = modal({ title: `Best fits for ${o.title}`, size: 'lg', body, actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close')] });
  try {
    const r = await api.post(`/api/recruitment/openings/${o.id}/compare`, {});
    clear(body,
      h('ol', { class: 'rank-list' }, r.ranking.map((x) => h('li', null, h('strong', null, x.name || `#${x.candidate_id}`), h('div', { class: 'small muted' }, x.reason)))),
      h('h3', { class: 'mt-16 mb-8' }, 'Advice'), h('p', { class: 'job-desc' }, r.advice),
      h('p', { class: 'tiny muted mt-16' }, 'AI suggestions help you decide; they don’t decide for you. Check the CVs before acting on them.'));
  } catch (e) { clear(body, alertBox(e.message, 'bad', 'alert')); }
}

function aiView(c) {
  const a = c.ai;
  const list = (items) => (items && items.length ? h('ul', { class: 'ai-list' }, items.map((x) => h('li', null, x))) : h('span', { class: 'muted small' }, 'None noted'));
  return h('div', { class: 'ai-box' },
    h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, scoreChip(c), h('strong', null, `Fit ${a.fit_score}/10`), REC[a.recommendation] ? badge(REC[a.recommendation][0], REC[a.recommendation][1]) : null,
      h('span', { class: 'tiny muted' }, `Read by AI ${utcToLocal(c.ai_at)}`)),
    h('p', { class: 'mt-8' }, a.summary),
    h('p', { class: 'small' }, h('strong', null, 'Advice: '), a.recommendation_reason),
    kv([['Current role', a.current_role], ['Experience', a.years_experience ? `${a.years_experience} years` : null], ['Education', a.education]]),
    a.key_skills.length ? h('div', { class: 'chip-row mt-8' }, a.key_skills.map((s) => h('span', { class: 'chip' }, s))) : null,
    h('div', { class: 'grid grid-2 mt-16' }, h('div', null, h('div', { class: 'small strong mb-4' }, 'Strengths'), list(a.strengths)), h('div', null, h('div', { class: 'small strong mb-4' }, 'Concerns and gaps'), list(a.concerns))),
    a.interview_questions.length ? h('div', { class: 'mt-16' }, h('div', { class: 'small strong mb-4' }, 'Questions to ask in the interview'), list(a.interview_questions)) : null,
    h('p', { class: 'tiny muted mt-16' }, 'AI suggestions help you decide; they don’t decide for you.'));
}

function candidateDetail(c, o, data, reload) {
  const aiArea = h('div', { class: 'mt-16' });
  const drawAi = () => {
    if (c.ai) clear(aiArea, aiView(c));
    else if (!c.has_cv) clear(aiArea, alertBox(c.cv_deleted_at ? 'This CV was deleted after one year, with its AI review.' : 'No CV yet. Upload a PDF to let the AI read it.', 'info', 'info'));
    else if (!data.ai) clear(aiArea, alertBox('The AI helper is not switched on.', 'info', 'info'));
    else clear(aiArea, h('p', { class: 'muted small' }, 'The AI hasn’t read this CV yet.'));
  };
  drawAi();
  const analyze = h('button', { class: 'btn sm', disabled: !c.has_cv || !data.ai }, icon('star', 14), c.ai ? 'Read again with AI' : 'Read CV with AI');
  analyze.addEventListener('click', async () => {
    analyze.disabled = true;
    clear(aiArea, h('div', { class: 'row', style: { gap: '10px' } }, spinner(), h('span', { class: 'muted' }, 'The AI is reading the CV…')));
    try { Object.assign(c, await api.post(`/api/recruitment/candidates/${c.id}/analyze`, {})); toast('CV read'); } catch (e) { errorToast(e); }
    drawAi();
    analyze.disabled = false;
  });
  const form = buildForm([
    { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' },
    { name: 'stage', label: 'Stage', type: 'select', options: data.stages.map((s) => [s, sentence(s)]) },
    { name: 'source', label: 'Source', type: 'select', options: [...new Set([c.source, ...SOURCES, ...data.platforms].filter(Boolean))] },
    { name: 'rating', label: 'Your rating', type: 'select', placeholder: '—', numeric: true, options: [[1, '★'], [2, '★★'], [3, '★★★'], [4, '★★★★'], [5, '★★★★★']] },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ], c);
  const save = h('button', { class: 'btn primary' }, 'Save');
  const m = modal({
    title: c.name, size: 'lg',
    body: h('div', null,
      h('div', { class: 'row mb-16', style: { flexWrap: 'wrap', gap: '8px' } }, badge(sentence(c.stage), STAGE_KIND[c.stage] || '', { dot: true }),
        c.has_cv ? h('a', { class: 'btn sm', href: `/api/recruitment/candidates/${c.id}/cv`, target: '_blank', rel: 'noopener' }, icon('file', 14), 'Open CV') : null,
        h('button', { class: 'btn sm', onclick: async () => { try { const cv = await pickCv(); if (!cv) return; await api.put(`/api/recruitment/candidates/${c.id}`, { cv }); toast('CV replaced'); m.close(); reload(); } catch (e) { errorToast(e); } } }, icon('upload', 14), c.has_cv ? 'Replace CV' : 'Upload CV'),
        analyze,
        c.has_cv && c.cv_expires_at ? h('span', { class: 'tiny muted' }, `CV kept until ${date(c.cv_expires_at.slice(0, 10))}`) : null),
      form.el, aiArea),
    actions: [
      h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => { if (!(await confirmDialog(`Delete ${c.name} and their CV?`, { danger: true, ok: 'Delete' }))) return; try { await api.del(`/api/recruitment/candidates/${c.id}`); toast('Deleted'); m.close(); reload(); } catch (e) { errorToast(e); } } }, 'Delete'),
      h('button', { class: 'btn', onclick: () => { m.close(); reload(); } }, 'Close'), save,
    ],
  });
  save.addEventListener('click', async () => {
    if (!form.validate()) return;
    try { await api.put(`/api/recruitment/candidates/${c.id}`, form.values()); toast('Saved'); m.close(); reload(); } catch (e) { errorToast(e); }
  });
}
