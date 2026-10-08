'use strict';

const { TABLES, tableDdl } = require('./schema');

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
];

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
