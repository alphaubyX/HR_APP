'use strict';

/** A database made by an older version is upgraded on start-up without losing anything. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { migrate, MIGRATIONS } = require('../server/db/migrate');

test('version 1 databases get sections, approved strength, roles and workflows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-migrate-'));
  const file = path.join(dir, 'hr.db');
  let db = await openDb({ client: 'sqlite', file });
  await migrate(db);
  // turn it back into a version 1 database with a department in it
  for (const t of ['sections', 'roles', 'workflows', 'approval_requests']) await db.run(`DROP TABLE ${t}`);
  await db.run("INSERT INTO orgs (name, code, currency, timezone, plan, status, created_at) VALUES ('Old Co', 'OLD', 'PKR', 'Asia/Karachi', 'trial', 'active', '2025-01-01 00:00:00')");
  await db.run('ALTER TABLE departments DROP COLUMN approved_strength');
  await db.run('ALTER TABLE employees DROP COLUMN section_id');
  await db.run('DELETE FROM schema_version WHERE version > 1');
  await db.run("INSERT INTO departments (org_id, name, created_at) VALUES (1, 'Finance', '2025-01-01 00:00:00')");
  await db.close();

  db = await openDb({ client: 'sqlite', file });
  await migrate(db);
  await migrate(db); // running again changes nothing
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).then((r) => r.map((c) => c.name));
  assert.ok((await cols('departments')).includes('approved_strength'));
  assert.ok((await cols('employees')).includes('section_id'));
  assert.ok((await cols('sections')).includes('department_id'));
  assert.equal(await db.value("SELECT name FROM departments WHERE name = 'Finance'"), 'Finance');
  assert.equal(Number(await db.value('SELECT MAX(version) FROM schema_version')), MIGRATIONS.at(-1).version);
  // the organization got the starting roles, once
  const roles = (await db.all('SELECT role_key FROM roles ORDER BY sort')).map((r) => r.role_key);
  assert.deepEqual(roles, ['admin', 'hr', 'payroll', 'employee']);
  assert.ok((await cols('approval_requests')).includes('followups'));
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
