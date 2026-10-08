'use strict';

/**
 * Broadwing HR attendance agent ("pull" mode).
 *
 * Use it when the attendance machine can't push to the internet itself (no ADMS / cloud option, or
 * it sits on a closed office network). Run it on any always-on PC in the office:
 *
 *   cd agent && npm install && copy .env.example .env   (fill it in)
 *   npm start            keeps running, reads the machine every few minutes
 *   npm run once         reads once and exits (for Windows Task Scheduler / cron)
 *
 * It remembers the newest punch it has sent (state.json), and the server ignores duplicates anyway,
 * so it is safe to restart at any time. Works with ZKTeco and compatible machines (TCP port 4370).
 */

const fs = require('node:fs');
const path = require('node:path');

const ENV = path.join(__dirname, '.env');
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const { HR_URL, HR_DEVICE_KEY, ZK_IP } = process.env;
const ZK_PORT = Number(process.env.ZK_PORT) || 4370;
const INTERVAL = Math.max(1, Number(process.env.INTERVAL_MINUTES) || 5) * 60000;
const STATE = path.join(__dirname, 'state.json');

function log(...a) { console.log(new Date().toISOString(), ...a); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { last: null }; } }
function writeState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

/** Local date-time 'YYYY-MM-DD HH:MM:SS' as the machine recorded it. */
function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function readMachine() {
  const ZKLib = require('node-zklib');
  const zk = new ZKLib(ZK_IP, ZK_PORT, 10000, 4000);
  await zk.createSocket();
  try {
    const { data } = await zk.getAttendances();
    return data.map((r) => ({ user_id: String(r.deviceUserId), time: fmt(new Date(r.recordTime)) }));
  } finally {
    try { await zk.disconnect(); } catch { /* already closed */ }
  }
}

async function send(punches) {
  for (let i = 0; i < punches.length; i += 5000) {
    const res = await fetch(`${HR_URL.replace(/\/$/, '')}/api/device/punches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-key': HR_DEVICE_KEY },
      body: JSON.stringify({ punches: punches.slice(i, i + 5000) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Server said ${res.status}: ${body.error || 'unknown error'}`);
    log(`sent ${Math.min(5000, punches.length - i)}: ${body.inserted} new, ${body.duplicates} already there, ${body.unmatched} for unknown machine numbers`);
  }
}

async function cycle() {
  const state = readState();
  const all = await readMachine();
  const fresh = all.filter((p) => !state.last || p.time > state.last).sort((a, b) => (a.time < b.time ? -1 : 1));
  if (!fresh.length) { log(`machine has ${all.length} punches, nothing new`); return; }
  await send(fresh);
  writeState({ last: fresh[fresh.length - 1].time });
}

async function main() {
  if (!HR_URL || !HR_DEVICE_KEY || !ZK_IP) {
    console.error('Fill in HR_URL, HR_DEVICE_KEY and ZK_IP in agent/.env first (see .env.example).');
    process.exit(1);
  }
  const once = process.argv.includes('--once');
  do {
    try { await cycle(); } catch (err) { log('failed:', err.message); if (once) process.exitCode = 1; }
    if (!once) await new Promise((r) => setTimeout(r, INTERVAL));
  } while (!once);
}

main();
