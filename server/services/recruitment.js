'use strict';

/** CV files for recruitment: PDF only, kept for one year, then deleted with their AI review. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { bad } = require('../lib/validate');
const { utcNow, utcPlus } = require('../lib/dates');

const MAX_CV_BYTES = 5 * 1024 * 1024;
const KEEP_MS = 365 * 86400000;

const cvDir = (dataDir) => path.join(dataDir, 'cvs');

/** Check an uploaded CV ({ name, data: base64 }) and return its bytes. */
function readCv(cv) {
  if (!cv || !cv.data) throw bad('Attach the CV as a PDF file.');
  const name = String(cv.name || 'cv.pdf').slice(0, 200);
  if (!/\.pdf$/i.test(name)) throw bad('CVs must be PDF files.');
  const buf = Buffer.from(String(cv.data).replace(/^data:application\/pdf;base64,/, ''), 'base64');
  if (!buf.length) throw bad('The CV file is empty.');
  if (buf.length > MAX_CV_BYTES) throw bad('CVs can be at most 5 MB.');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('That file is not a real PDF. Save the CV as PDF and try again.');
  return { name, buf };
}

/** Store a checked CV; returns the candidate columns to save. */
function storeCv(dataDir, orgId, { name, buf }) {
  const file = `${orgId}-${crypto.randomBytes(16).toString('hex')}.pdf`;
  fs.mkdirSync(cvDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(cvDir(dataDir), file), buf);
  return { cv_file: file, cv_name: name, cv_size: buf.length, cv_uploaded_at: utcNow(), cv_expires_at: utcPlus(KEEP_MS), cv_deleted_at: null };
}

function removeCvFile(dataDir, file) {
  if (!file) return;
  try { fs.unlinkSync(path.join(cvDir(dataDir), path.basename(file))); } catch { /* already gone */ }
}

const cvPath = (dataDir, file) => path.join(cvDir(dataDir), path.basename(file));

/** Delete CVs (and the AI reviews made from them) that are more than a year old. */
async function purgeExpiredCvs(db, dataDir) {
  const due = await db.all('SELECT id, cv_file FROM candidates WHERE cv_file IS NOT NULL AND cv_expires_at < ?', [utcNow()]);
  for (const c of due) {
    removeCvFile(dataDir, c.cv_file);
    await db.update('candidates', { id: c.id }, {
      cv_file: null, cv_size: null, cv_deleted_at: utcNow(), ai: null, ai_score: null, ai_recommendation: null, ai_at: null, updated_at: utcNow(),
    });
  }
  return due.length;
}

module.exports = { readCv, storeCv, removeCvFile, cvPath, purgeExpiredCvs, MAX_CV_BYTES };
