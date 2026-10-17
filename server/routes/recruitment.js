'use strict';

/**
 * Recruitment: job openings (new positions or existing ones on the organogram), candidates with
 * PDF CVs, a public link where candidates apply themselves, and the AI helper that reads CVs.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { need } = require('../lib/auth');
const { pick, bad, notFound } = require('../lib/validate');
const { utcNow, nowIn } = require('../lib/dates');
const { audit, fullName, usersWithPerm, notifyUsers } = require('../services/common');
const { readCv, storeCv, removeCvFile, cvPath } = require('../services/recruitment');
const ai = require('../services/ai');

const PLATFORMS = ['LinkedIn', 'Rozee.pk', 'Indeed', 'Facebook', 'Instagram', 'Company website', 'Newspaper', 'Job fair', 'Referrals', 'Recruitment agency', 'Other'];
const STAGES = ['new', 'shortlisted', 'interview', 'offer', 'hired', 'rejected'];

const OPENING = {
  title: ['str', { required: true, max: 150 }],
  description: ['str', { max: 20000 }],
  department_id: ['id'], section_id: ['id'], designation_id: ['id'], replaces_employee_id: ['id'], branch_id: ['id'],
  location: ['str', { max: 150 }],
  positions: ['int', { min: 1, max: 1000 }],
  salary_min: ['money'], salary_max: ['money'],
  deadline: ['date'],
  status: ['str', { oneOf: ['open', 'on_hold', 'closed', 'filled'] }],
  advertised: ['bool'],
  ad_link: ['str', { max: 400 }],
  accept_online: ['bool'],
};

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

module.exports = function recruitmentRoutes(r, { db, options }) {
  const dataDir = options.dataDir;
  const manage = need('recruitment.manage');

  async function loadOpening(req, id) {
    const o = await db.get('SELECT * FROM job_openings WHERE id = ? AND org_id = ?', [id, req.org.id]);
    if (!o) throw notFound('Job opening');
    return o;
  }
  async function loadCandidate(req, id) {
    const c = await db.get('SELECT * FROM candidates WHERE id = ? AND org_id = ?', [id, req.org.id]);
    if (!c) throw notFound('Candidate');
    return c;
  }

  async function checkOpening(req, data) {
    const refs = { department_id: 'departments', section_id: 'sections', designation_id: 'designations', replaces_employee_id: 'employees', branch_id: 'branches' };
    for (const [col, table] of Object.entries(refs)) {
      if (data[col] && !(await db.get(`SELECT id FROM ${table} WHERE id = ? AND org_id = ?`, [data[col], req.org.id]))) throw bad(`${col.replace('_id', '').replace(/_/g, ' ')} not found.`);
    }
    if (data.section_id) data.department_id = await db.value('SELECT department_id FROM sections WHERE id = ?', [data.section_id]);
    if (data.salary_min && data.salary_max && Number(data.salary_min) > Number(data.salary_max)) throw bad('The lowest salary is more than the highest.');
    if (req.body && 'platforms' in req.body) {
      const list = Array.isArray(req.body.platforms) ? req.body.platforms : [];
      data.platforms = JSON.stringify([...new Set(list.map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 20));
    }
  }

  function openingOut(o, extra = {}) {
    return { ...o, platforms: parse(o.platforms, []), advertised: !!o.advertised, accept_online: !!o.accept_online, ...extra };
  }

  function candidateOut(c) {
    return {
      id: c.id, opening_id: c.opening_id, name: c.name, email: c.email, phone: c.phone, source: c.source, stage: c.stage, rating: c.rating, notes: c.notes,
      has_cv: !!c.cv_file, cv_name: c.cv_name, cv_size: c.cv_size, cv_uploaded_at: c.cv_uploaded_at, cv_expires_at: c.cv_expires_at, cv_deleted_at: c.cv_deleted_at,
      ai: parse(c.ai, null), ai_score: c.ai_score, ai_recommendation: c.ai_recommendation, ai_at: c.ai_at, created_at: c.created_at,
    };
  }

  /* ---------------------------------------------------------------- openings */
  r.get('/recruitment/openings', manage, async (req, res) => {
    const rows = await db.all(
      `SELECT o.*, d.name AS department, g.name AS designation FROM job_openings o
       LEFT JOIN departments d ON d.id = o.department_id LEFT JOIN designations g ON g.id = o.designation_id
       WHERE o.org_id = ? ORDER BY CASE o.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END, o.id DESC`, [req.org.id]);
    const counts = await db.all('SELECT opening_id, stage, COUNT(*) AS n FROM candidates WHERE org_id = ? GROUP BY opening_id, stage', [req.org.id]);
    const by = new Map();
    for (const c of counts) {
      const m = by.get(c.opening_id) || {};
      m[c.stage] = Number(c.n);
      by.set(c.opening_id, m);
    }
    res.json({
      openings: rows.map((o) => {
        const m = by.get(o.id) || {};
        return openingOut(o, { stages: m, candidates: Object.values(m).reduce((a, b) => a + b, 0) });
      }),
      platforms: PLATFORMS, ai: ai.aiEnabled(),
    });
  });

  r.post('/recruitment/openings', manage, async (req, res) => {
    const data = pick(req.body, OPENING);
    await checkOpening(req, data);
    const id = await db.insert('job_openings', {
      ...data, org_id: req.org.id, public_token: crypto.randomBytes(12).toString('base64url'), created_by: req.user.id, created_at: utcNow(),
    });
    await audit(db, req, 'recruitment.opening.create', 'job_openings', id, { title: data.title });
    res.json({ id });
  });

  r.get('/recruitment/openings/:id', manage, async (req, res) => {
    const o = await loadOpening(req, req.params.id);
    const [dept, section, desig, branch, repl] = await Promise.all([
      o.department_id && db.get('SELECT id, name FROM departments WHERE id = ?', [o.department_id]),
      o.section_id && db.get('SELECT id, name FROM sections WHERE id = ?', [o.section_id]),
      o.designation_id && db.get('SELECT id, name FROM designations WHERE id = ?', [o.designation_id]),
      o.branch_id && db.get('SELECT id, name FROM branches WHERE id = ?', [o.branch_id]),
      o.replaces_employee_id && db.get('SELECT id, first_name, last_name FROM employees WHERE id = ?', [o.replaces_employee_id]),
    ]);
    const candidates = await db.all('SELECT * FROM candidates WHERE opening_id = ? AND org_id = ? ORDER BY ai_score IS NULL, ai_score DESC, id DESC', [o.id, req.org.id]);
    res.json({
      opening: openingOut(o, {
        department: dept || null, section: section || null, designation: desig || null, branch: branch || null,
        replaces: repl ? { id: repl.id, name: fullName(repl) } : null,
      }),
      candidates: candidates.map(candidateOut),
      platforms: PLATFORMS, stages: STAGES, ai: ai.aiEnabled(),
    });
  });

  r.put('/recruitment/openings/:id', manage, async (req, res) => {
    const o = await loadOpening(req, req.params.id);
    const data = pick(req.body, OPENING, { partial: true });
    if (data.title === null) delete data.title;
    await checkOpening(req, data);
    data.updated_at = utcNow();
    await db.update('job_openings', { id: o.id }, data);
    await audit(db, req, 'recruitment.opening.update', 'job_openings', o.id, data);
    res.json({ ok: true });
  });

  r.delete('/recruitment/openings/:id', manage, async (req, res) => {
    const o = await loadOpening(req, req.params.id);
    const files = await db.all('SELECT cv_file FROM candidates WHERE opening_id = ? AND org_id = ?', [o.id, req.org.id]);
    await db.tx(async (t) => {
      await t.run('DELETE FROM candidates WHERE opening_id = ? AND org_id = ?', [o.id, req.org.id]);
      await t.run('DELETE FROM job_openings WHERE id = ?', [o.id]);
    });
    files.forEach((f) => removeCvFile(dataDir, f.cv_file));
    await audit(db, req, 'recruitment.opening.delete', 'job_openings', o.id, { title: o.title, candidates: files.length });
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------- candidates */
  const CANDIDATE = {
    name: ['str', { required: true, max: 150 }], email: ['email'], phone: ['str', { max: 50 }], source: ['str', { max: 60 }],
    stage: ['str', { oneOf: STAGES }], rating: ['int', { min: 1, max: 5 }], notes: ['str', { max: 5000 }],
  };

  r.post('/recruitment/openings/:id/candidates', manage, async (req, res) => {
    const o = await loadOpening(req, req.params.id);
    const data = pick(req.body, CANDIDATE);
    const cv = req.body && req.body.cv ? storeCv(dataDir, req.org.id, readCv(req.body.cv)) : {};
    const id = await db.insert('candidates', { ...data, ...cv, org_id: req.org.id, opening_id: o.id, created_at: utcNow() });
    await audit(db, req, 'recruitment.candidate.create', 'candidates', id, { name: data.name, opening: o.title });
    res.json({ id });
  });

  r.put('/recruitment/candidates/:id', manage, async (req, res) => {
    const c = await loadCandidate(req, req.params.id);
    const data = pick(req.body, CANDIDATE, { partial: true });
    if (data.name === null) delete data.name;
    if (req.body && req.body.cv) {
      Object.assign(data, storeCv(dataDir, req.org.id, readCv(req.body.cv)), { ai: null, ai_score: null, ai_recommendation: null, ai_at: null });
      removeCvFile(dataDir, c.cv_file);
    }
    data.updated_at = utcNow();
    await db.update('candidates', { id: c.id }, data);
    await audit(db, req, 'recruitment.candidate.update', 'candidates', c.id, { ...data, ai: undefined });
    res.json({ ok: true });
  });

  r.delete('/recruitment/candidates/:id', manage, async (req, res) => {
    const c = await loadCandidate(req, req.params.id);
    await db.run('DELETE FROM candidates WHERE id = ?', [c.id]);
    removeCvFile(dataDir, c.cv_file);
    await audit(db, req, 'recruitment.candidate.delete', 'candidates', c.id, { name: c.name });
    res.json({ ok: true });
  });

  r.get('/recruitment/candidates/:id/cv', manage, async (req, res) => {
    const c = await loadCandidate(req, req.params.id);
    if (!c.cv_file || !fs.existsSync(cvPath(dataDir, c.cv_file))) throw notFound('CV');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${String(c.cv_name || 'cv.pdf').replace(/[^\w.\- ]/g, '_')}"`);
    res.sendFile(cvPath(dataDir, c.cv_file));
  });

  /* ---------------------------------------------------------------- AI helper */
  const jobFor = async (req, o) => ({
    ...o, department: o.department_id ? await db.value('SELECT name FROM departments WHERE id = ?', [o.department_id]) : null,
  });

  r.post('/recruitment/candidates/:id/analyze', manage, async (req, res) => {
    const c = await loadCandidate(req, req.params.id);
    if (!c.cv_file || !fs.existsSync(cvPath(dataDir, c.cv_file))) throw bad('This candidate has no CV to read.');
    const o = await loadOpening(req, c.opening_id);
    const out = await ai.assessCv({ pdf: fs.readFileSync(cvPath(dataDir, c.cv_file)), job: await jobFor(req, o), currency: req.org.currency });
    const data = { ai: JSON.stringify(out), ai_score: out.fit_score, ai_recommendation: out.recommendation, ai_at: utcNow(), updated_at: utcNow() };
    // fill in contact details the CV gives when they were left empty
    if (!c.email && out.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) data.email = out.email.slice(0, 150).toLowerCase();
    if (!c.phone && out.phone) data.phone = out.phone.slice(0, 50);
    // a CV dropped in without a name (named after its file): use the name in the CV
    if (c.source === 'CV upload' && !c.updated_at && out.candidate_name) data.name = out.candidate_name.slice(0, 150);
    await db.update('candidates', { id: c.id }, data);
    await audit(db, req, 'recruitment.ai.assess', 'candidates', c.id, { score: out.fit_score });
    res.json(candidateOut({ ...c, ...data }));
  });

  r.post('/recruitment/openings/:id/compare', manage, async (req, res) => {
    const o = await loadOpening(req, req.params.id);
    const rows = (await db.all("SELECT * FROM candidates WHERE opening_id = ? AND org_id = ? AND ai IS NOT NULL AND stage <> 'rejected'", [o.id, req.org.id]))
      .map((c) => ({ ...c, ai: parse(c.ai, null) })).filter((c) => c.ai);
    if (rows.length < 2) throw bad('Let the AI read at least two CVs first, then compare them.');
    const out = await ai.rankCandidates({ job: await jobFor(req, o), currency: req.org.currency, candidates: rows.slice(0, 60) });
    const names = new Map(rows.map((c) => [c.id, c.name]));
    res.json({ ...out, ranking: out.ranking.map((x) => ({ ...x, name: names.get(x.candidate_id) })) });
  });

  /* ---------------------------------------------------------------- public application page */
  const recent = new Map(); // ip -> times, a simple brake on automated applications
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (recent.get(ip) || []).filter((t) => now - t < 3600000);
    list.push(now);
    recent.set(ip, list);
    if (recent.size > 5000) recent.clear();
    return list.length > 10;
  };

  async function publicOpening(token) {
    const o = token && await db.get('SELECT o.*, g.name AS org_name, g.logo AS org_logo, g.currency, g.timezone, g.status AS org_status FROM job_openings o JOIN orgs g ON g.id = o.org_id WHERE o.public_token = ?', [String(token)]);
    if (!o || o.org_status !== 'active') throw notFound('Job');
    const today = nowIn(o.timezone).date;
    const open = o.status === 'open' && !!o.accept_online && (!o.deadline || o.deadline >= today);
    return { o, open };
  }

  r.get('/public/jobs/:token', async (req, res) => {
    const { o, open } = await publicOpening(req.params.token);
    res.json({
      title: o.title, description: o.description, location: o.location, deadline: o.deadline, positions: o.positions,
      salary_min: o.salary_min, salary_max: o.salary_max, currency: o.currency, org: { name: o.org_name, logo: o.org_logo }, open,
    });
  });

  r.post('/public/jobs/:token/apply', async (req, res) => {
    const { o, open } = await publicOpening(req.params.token);
    if (!open) throw bad('This job is no longer taking applications.');
    if (tooMany(req.ip)) throw bad('Too many applications from this connection. Please try again later.');
    if (!req.body || !req.body.consent) throw bad('Please agree to how your CV is kept and used.');
    const data = pick(req.body, { name: ['str', { required: true, max: 150 }], email: ['email', { required: true }], phone: ['str', { max: 50 }] });
    const cv = storeCv(dataDir, o.org_id, readCv(req.body.cv));
    const dup = await db.get('SELECT id, cv_file FROM candidates WHERE opening_id = ? AND email = ?', [o.id, data.email]);
    if (dup) { // applying again replaces the earlier CV
      await db.update('candidates', { id: dup.id }, { ...data, ...cv, ai: null, ai_score: null, ai_recommendation: null, ai_at: null, updated_at: utcNow() });
      removeCvFile(dataDir, dup.cv_file);
    } else {
      await db.insert('candidates', { ...data, ...cv, org_id: o.org_id, opening_id: o.id, source: 'Applied online', stage: 'new', created_at: utcNow() });
      const hr = await usersWithPerm(db, o.org_id, 'recruitment.manage');
      await notifyUsers(db, o.org_id, hr.map((h) => h.user_id), `New application: ${o.title}`, data.name, `#/recruitment/${o.id}`);
    }
    res.json({ ok: true });
  });
};
