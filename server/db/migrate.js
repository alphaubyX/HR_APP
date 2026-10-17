'use strict';

const { TABLES, tableDdl, addColumnDdl } = require('./schema');

/**
 * Versioned migrations. Version 1 creates every table in schema.js. When the schema changes later,
 * add the column to schema.js AND a numbered step below (e.g. using addColumnDdl), so existing
 * databases are upgraded on start-up.
 */
const MIGRATIONS = [
  {
    version: 1,
    async up(db) {
      for (const [name, def] of Object.entries(TABLES)) {
        for (const stmt of tableDdl(name, def, db.dialect)) await db.run(stmt);
      }
    },
  },
  {
    // sections inside departments, and approved strength (sanctioned headcount)
    version: 2,
    async up(db) {
      for (const stmt of tableDdl('sections', TABLES.sections, db.dialect)) await db.run(stmt);
      await addColumn(db, 'departments', 'approved_strength');
      await addColumn(db, 'employees', 'section_id');
    },
  },
  {
    // roles you can change, approval workflows
    version: 3,
    async up(db) {
      for (const t of ['roles', 'workflows', 'approval_requests']) {
        for (const stmt of tableDdl(t, TABLES[t], db.dialect)) await db.run(stmt);
      }
      const { seedRoles } = require('../services/roles');
      for (const o of await db.all('SELECT id FROM orgs')) await seedRoles(db, o.id);
    },
  },
  {
    // recruitment, platform branding; HR managers get the new recruitment right
    version: 4,
    async up(db) {
      for (const t of ['job_openings', 'candidates', 'platform_settings']) {
        for (const stmt of tableDdl(t, TABLES[t], db.dialect)) await db.run(stmt);
      }
      for (const r of await db.all("SELECT id, perms FROM roles WHERE role_key = 'hr' AND is_system = 1")) {
        let perms = [];
        try { perms = JSON.parse(r.perms || '[]'); } catch { /* keep empty */ }
        if (!perms.includes('recruitment.manage')) await db.run('UPDATE roles SET perms = ? WHERE id = ?', [JSON.stringify([...perms, 'recruitment.manage']), r.id]);
      }
    },
  },
];

/** Add a column unless it is already there (a new database gets it from version 1). */
async function addColumn(db, table, column) {
  const cols = db.dialect === 'mysql'
    ? (await db.all('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])).map((c) => c.name)
    : (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (!cols.includes(column)) await db.run(addColumnDdl(table, column, db.dialect));
}

async function migrate(db) {
  await db.run(db.dialect === 'mysql'
    ? 'CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB'
    : 'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
  const current = Number(await db.value('SELECT MAX(version) AS v FROM schema_version')) || 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await m.up(db);
    await db.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
      [m.version, new Date().toISOString().slice(0, 19).replace('T', ' ')]);
  }
}

module.exports = { migrate, MIGRATIONS };
