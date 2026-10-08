'use strict';

/**
 * ZKTeco "ADMS" / push protocol: the attendance machine itself calls this server over HTTP.
 * On the machine: Menu → Comm. → Cloud Server Setting → Server address = this site's address,
 * port 80 or 443 (HTTPS on newer firmware), and register the machine's serial number under
 * Attendance → Machines. The machine then sends every punch within seconds.
 *
 *   GET  /iclock/cdata?SN=…              handshake: we reply with the options
 *   POST /iclock/cdata?SN=…&table=ATTLOG punches, one per line: PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify …
 *   GET  /iclock/getrequest?SN=…         the machine asks for commands: we have none
 *   POST /iclock/devicecmd?SN=…          command results
 */

const express = require('express');
const { ingestPunches } = require('../services/attendance');
const { utcNow } = require('../lib/dates');

module.exports = function iclock(db) {
  const r = express.Router();

  async function device(req) {
    const sn = String(req.query.SN || req.query.sn || '').trim().toUpperCase();
    if (!sn) return null;
    const d = await db.get('SELECT * FROM devices WHERE serial_no = ? AND active = 1', [sn]);
    if (d) await db.update('devices', { id: d.id }, { last_seen_at: utcNow() });
    return d;
  }

  const text = (res, body) => res.type('text/plain').send(body);

  r.get('/cdata', async (req, res) => {
    const d = await device(req);
    if (!d) return text(res, 'OK'); // unknown machine: answer politely, store nothing
    text(res, [
      `GET OPTION FROM: ${d.serial_no}`,
      `ATTLOGStamp=${d.last_stamp || 'None'}`,
      'OPERLOGStamp=9999',
      'ATTPHOTOStamp=None',
      'ErrorDelay=30',
      'Delay=10',
      'TransTimes=00:00;14:05',
      'TransInterval=1',
      'TransFlag=TransData AttLog',
      'Realtime=1',
      'Encrypt=None',
    ].join('\n'));
  });

  r.post('/cdata', async (req, res) => {
    const d = await device(req);
    const table = String(req.query.table || '').toUpperCase();
    const body = typeof req.body === 'string' ? req.body : '';
    if (!d || table !== 'ATTLOG') {
      const n = body.split(/\r?\n/).filter((l) => l.trim()).length;
      return text(res, `OK: ${n}`);
    }
    const items = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [pin, time, status] = line.split('\t').map((x) => (x || '').trim());
      if (!pin || !time) continue;
      // status 0 = check in, 1 = check out, 4/5 = overtime in/out; others: let the rules decide
      const direction = status === '0' || status === '4' ? 'in' : status === '1' || status === '5' ? 'out' : 'auto';
      items.push({ device_user_id: pin, time, direction });
    }
    await ingestPunches(db, d.org_id, items, { source: 'device', deviceId: d.id });
    if (req.query.Stamp) await db.update('devices', { id: d.id }, { last_stamp: String(req.query.Stamp).slice(0, 40) });
    text(res, `OK: ${items.length}`);
  });

  r.get('/getrequest', async (req, res) => { await device(req); text(res, 'OK'); });
  r.post('/devicecmd', (req, res) => text(res, 'OK'));
  r.all(/.*/, (req, res) => text(res, 'OK'));
  return r;
};
