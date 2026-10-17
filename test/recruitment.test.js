'use strict';

/** Recruitment: openings, PDF-only CVs, the public application link, the one-year limit, the AI helper. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, client } = require('./helpers');
const { purgeExpiredCvs } = require('../server/services/recruitment');

const PW = 'password123';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n').toString('base64');
let srv;
let admin;
let opening;
let fakeAi;
let lastAiRequest = null;

// a stand-in for the Anthropic API, so the AI helper can be tested without a real key
function startFakeAi() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastAiRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        const isCompare = typeof lastAiRequest.body.messages[0].content === 'string';
        const out = isCompare
          ? { ranking: [{ candidate_id: 999999, rank: 1, reason: 'not in the list' }], advice: 'Interview Ayesha first.' }
          : {
            candidate_name: 'Ayesha Raza', email: 'ayesha@example.com', phone: '0300 1234567', current_role: 'Accountant', years_experience: 6,
            education: 'ACCA', summary: 'Experienced accountant.', key_skills: ['IFRS', 'Excel'], strengths: ['Audit experience'], concerns: ['No payroll'],
            fit_score: 14, recommendation: 'shortlist', recommendation_reason: 'Strong match.', interview_questions: ['Tell us about month-end close.'],
          };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: lastAiRequest.body.model,
          content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test.before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  srv = await startServer();
  admin = client(srv.base);
  await admin.post('/api/setup', { name: 'Owner', username: 'owner', password: PW, org_name: 'Acme Ltd' });
  fakeAi = await startFakeAi();
});
test.after(async () => { await srv.close(); fakeAi.close(); });

test('openings: new or replacing someone, with salary, deadline and platforms', async () => {
  const leaver = (await admin.post('/api/employees', { first_name: 'Old', last_name: 'Hand', join_date: '2025-01-01', probation_days: 0 })).id;
  assert.match((await admin.call('POST', '/api/recruitment/openings', { title: 'X', salary_min: 200, salary_max: 100 })).data.error, /lowest salary/);
  const { id } = await admin.post('/api/recruitment/openings', {
    title: 'Accounts Officer', description: 'Month-end close, IFRS.', salary_min: 120000, salary_max: 180000, location: 'Lahore',
    deadline: '2099-12-31', advertised: true, platforms: ['LinkedIn', 'Rozee.pk', 'LinkedIn'], replaces_employee_id: leaver, accept_online: true,
  });
  const got = await admin.get(`/api/recruitment/openings/${id}`);
  opening = got.opening;
  assert.deepEqual(opening.platforms, ['LinkedIn', 'Rozee.pk']);
  assert.equal(opening.replaces.name, 'Old Hand');
  assert.ok(opening.public_token.length >= 16);
  assert.equal(got.ai, false);
  const list = await admin.get('/api/recruitment/openings');
  assert.equal(list.openings[0].title, 'Accounts Officer');

  // people without the recruitment right can't see it
  const emp = (await admin.post('/api/employees', { first_name: 'Plain', join_date: '2025-01-01', probation_days: 0 })).id;
  await admin.post(`/api/employees/${emp}/account`, { username: 'plain', password: PW, role: 'employee' });
  const plain = client(srv.base);
  await plain.post('/api/login', { username: 'plain', password: PW });
  assert.equal((await plain.call('GET', '/api/recruitment/openings')).status, 403);
});

test('CVs: PDF only, opened by HR, kept a year', async () => {
  const notPdf = Buffer.from('hello').toString('base64');
  assert.match((await admin.call('POST', `/api/recruitment/openings/${opening.id}/candidates`, { name: 'A', cv: { name: 'cv.docx', data: notPdf } })).data.error, /PDF/);
  assert.match((await admin.call('POST', `/api/recruitment/openings/${opening.id}/candidates`, { name: 'A', cv: { name: 'cv.pdf', data: notPdf } })).data.error, /not a real PDF/);
  const { id } = await admin.post(`/api/recruitment/openings/${opening.id}/candidates`, { name: 'Bilal', email: 'b@example.com', source: 'Referral', cv: { name: 'bilal.pdf', data: PDF } });
  const res = await fetch(`${srv.base}/api/recruitment/candidates/${id}/cv`, { headers: { cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const c = (await admin.get(`/api/recruitment/openings/${opening.id}`)).candidates.find((x) => x.id === id);
  assert.ok(c.has_cv);
  const keepDays = (Date.parse(`${c.cv_expires_at}Z`) - Date.parse(`${c.cv_uploaded_at}Z`)) / 86400000;
  assert.ok(keepDays > 364 && keepDays < 366, 'kept for one year');

  // a year later the CV (and any AI review) is deleted, the candidate record stays
  const row = await srv.db.get('SELECT cv_file FROM candidates WHERE id = ?', [id]);
  await srv.db.run("UPDATE candidates SET cv_expires_at = '2000-01-01 00:00:00', ai = '{}' WHERE id = ?", [id]);
  const files = await srv.db.all('SELECT cv_file FROM candidates WHERE cv_file IS NOT NULL');
  assert.ok(files.some((f) => f.cv_file === row.cv_file));
  const n = await purgeExpiredCvs(srv.db, await findDataDir(row.cv_file));
  assert.equal(n, 1);
  const after = (await admin.get(`/api/recruitment/openings/${opening.id}`)).candidates.find((x) => x.id === id);
  assert.equal(after.has_cv, false);
  assert.equal(after.ai, null);
  assert.ok(after.cv_deleted_at);
  assert.equal((await admin.call('GET', `/api/recruitment/candidates/${id}/cv`)).status, 404);
});

// the test server's data folder (where CVs are stored)
async function findDataDir(file) {
  const tmp = require('node:os').tmpdir();
  for (const d of fs.readdirSync(tmp)) {
    if (d.startsWith('hr-test-') && fs.existsSync(path.join(tmp, d, 'cvs', file))) return path.join(tmp, d);
  }
  throw new Error('data folder not found');
}

test('public application link: candidates apply with a PDF, once per email', async () => {
  const anon = client(srv.base);
  const job = await anon.get(`/api/public/jobs/${opening.public_token}`);
  assert.equal(job.title, 'Accounts Officer');
  assert.equal(job.open, true);
  assert.equal(job.org.name, 'Acme Ltd');
  assert.equal((await anon.call('GET', '/api/public/jobs/nope')).status, 404);
  const form = { name: 'Ayesha', email: 'ayesha@example.com', cv: { name: 'ayesha.pdf', data: PDF } };
  assert.match((await anon.call('POST', `/api/public/jobs/${opening.public_token}/apply`, form)).data.error, /agree/);
  await anon.post(`/api/public/jobs/${opening.public_token}/apply`, { ...form, consent: true });
  await anon.post(`/api/public/jobs/${opening.public_token}/apply`, { ...form, consent: true, phone: '123' });
  const cands = (await admin.get(`/api/recruitment/openings/${opening.id}`)).candidates.filter((c) => c.email === 'ayesha@example.com');
  assert.equal(cands.length, 1, 'applying again replaces the earlier application');
  assert.equal(cands[0].source, 'Applied online');
  assert.equal(cands[0].phone, '123');
  const page = await fetch(`${srv.base}/apply/${opening.public_token}`);
  assert.match(await page.text(), /apply\.js/);

  // closed jobs take no applications
  await admin.put(`/api/recruitment/openings/${opening.id}`, { status: 'closed' });
  assert.equal((await anon.get(`/api/public/jobs/${opening.public_token}`)).open, false);
  assert.equal((await anon.call('POST', `/api/public/jobs/${opening.public_token}/apply`, { ...form, consent: true })).status, 400);
  await admin.put(`/api/recruitment/openings/${opening.id}`, { status: 'open' });
});

test('AI helper: off without a key, then reads the CV and compares candidates', async () => {
  const ayesha = (await admin.get(`/api/recruitment/openings/${opening.id}`)).candidates.find((c) => c.email === 'ayesha@example.com');
  assert.match((await admin.call('POST', `/api/recruitment/candidates/${ayesha.id}/analyze`)).data.error, /not switched on/);

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}`;
  const out = await admin.post(`/api/recruitment/candidates/${ayesha.id}/analyze`);
  assert.equal(out.ai_score, 10, 'scores are kept between 1 and 10');
  assert.equal(out.ai_recommendation, 'shortlist');
  assert.deepEqual(out.ai.key_skills, ['IFRS', 'Excel']);
  // what was sent: the PDF itself, the job, structured output and the refusal fallback
  const sent = lastAiRequest.body;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.match(lastAiRequest.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.messages[0].content[0].type, 'document');
  assert.equal(sent.messages[0].content[0].source.media_type, 'application/pdf');
  assert.match(sent.messages[0].content[1].text, /Accounts Officer[\s\S]*Month-end close/);

  // bulk-uploaded CVs get the name from the CV
  const { id } = await admin.post(`/api/recruitment/openings/${opening.id}/candidates`, { name: 'scan 0042', source: 'CV upload', cv: { name: 'scan_0042.pdf', data: PDF } });
  const named = await admin.post(`/api/recruitment/candidates/${id}/analyze`);
  assert.equal(named.name, 'Ayesha Raza');

  const cmp = await admin.post(`/api/recruitment/openings/${opening.id}/compare`);
  assert.equal(cmp.advice, 'Interview Ayesha first.');
  assert.deepEqual(cmp.ranking, [], 'made-up candidate ids are dropped');
  delete process.env.ANTHROPIC_BASE_URL;
});

test('deleting an opening deletes its candidates and CV files', async () => {
  const before = await srv.db.all('SELECT cv_file FROM candidates WHERE opening_id = ? AND cv_file IS NOT NULL', [opening.id]);
  const dir = await findDataDir(before[0].cv_file);
  await admin.del(`/api/recruitment/openings/${opening.id}`);
  assert.equal(Number(await srv.db.value('SELECT COUNT(*) FROM candidates WHERE opening_id = ?', [opening.id])), 0);
  for (const f of before) assert.equal(fs.existsSync(path.join(dir, 'cvs', f.cv_file)), false);
});
