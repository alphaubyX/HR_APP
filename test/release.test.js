'use strict';

/**
 * The upload package (npm run build) must run on its own: copied to an empty folder with no
 * node_modules, it has to start, answer /api/health and serve the app, and with bad settings it
 * has to stay up and say what's wrong instead of crashing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function start(dir, port, extraEnv) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return { child, log: () => output };
}

async function waitFor(url, check, ms = 15000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      last = { status: res.status, body: await res.text() };
      if (check(last)) return last;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}; last answer: ${JSON.stringify(last)}`);
}

test('the upload package runs without node_modules', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: 'pipe' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-release-'));
  fs.cpSync(path.join(ROOT, 'release'), dir, { recursive: true });
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'nothing for npm install to do');

  // misconfigured: stays up and explains
  const bad = start(dir, 3311, { HR_DB_CLIENT: 'mysql', HR_DB_NAME: 'x', HR_DB_PASSWORD: 'y' });
  try {
    const r = await waitFor('http://127.0.0.1:3311/api/health', (x) => x.status === 503);
    assert.match(JSON.parse(r.body).problem, /Missing setting: HR_DB_USER/);
    const page = await fetch('http://127.0.0.1:3311/');
    assert.match(await page.text(), /not ready yet/);
  } finally { bad.child.kill(); }

  // working (SQLite, so the test needs no database server)
  const ok = start(dir, 3312, {
    HR_DB_CLIENT: 'sqlite', HR_DATA_DIR: path.join(dir, 'data'), HR_OWNER_USERNAME: 'Owner', HR_OWNER_PASSWORD: 'password123', HR_ORG_NAME: 'Test Co',
  });
  try {
    const r = await waitFor('http://127.0.0.1:3312/api/health', (x) => x.status === 200);
    assert.equal(JSON.parse(r.body).ok, true);
    for (const u of ['/', '/js/app.js', '/js/pages/organogram.js', '/vendor/leaflet/leaflet.js']) {
      assert.equal((await fetch(`http://127.0.0.1:3312${u}`)).status, 200, u);
    }
    const login = await fetch('http://127.0.0.1:3312/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'password123' }) });
    assert.equal(login.status, 200);
    const me = await fetch('http://127.0.0.1:3312/api/me', { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } });
    const body = await me.json();
    assert.equal(body.org.name, 'Test Co', 'the first organization is created from the settings');
    assert.equal(body.role, 'admin');
  } catch (err) {
    err.message += `\n--- app output ---\n${ok.log()}`;
    throw err;
  } finally {
    ok.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
