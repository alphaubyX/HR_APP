// Self-service: check in / out from the phone, my attendance, my leave, my payslips, my profile.
import { api } from '../api.js';
import { S, navigate } from '../state.js';
import {
  h, clear, icon, pageHead, card, tabs, badge, date, time, money, monthLabel, toast, errorToast, alertBox, attBadge, empty, table, duration,
} from '../ui.js';
import { makeMap, distanceM } from '../map.js';
import { balanceCards, applyLeave, leaveRequestsTable, attendanceMonth, requestCorrection } from './widgets.js';

export default async function me(view, params) {
  if (!S.me.employee) {
    view.append(card(null, empty('Your sign-in is not linked to an employee', 'Ask HR to link your account to your employee record (Settings → Users).', null, 'user')));
    return;
  }
  const tab = params.tab || 'checkin';
  view.append(pageHead(tab === 'checkin' ? 'Check in / out' : { attendance: 'My attendance', leave: 'My leave', payslips: 'My payslips', profile: 'My profile' }[tab] || 'My space'));
  view.append(tabs([
    { id: 'checkin', label: 'Check in', href: '#/me', icon: 'finger' },
    { id: 'attendance', label: 'Attendance', href: '#/me/attendance', icon: 'clock' },
    { id: 'leave', label: 'Leave', href: '#/me/leave', icon: 'calendar' },
    { id: 'payslips', label: 'Payslips', href: '#/me/payslips', icon: 'banknote' },
    { id: 'profile', label: 'Profile', href: '#/me/profile', icon: 'user' },
  ], tab));
  const body = h('div');
  view.append(body);
  if (tab === 'profile') { navigate(`/employees/${S.me.employee.id}`); return; }
  await ({ checkin, attendance, leave, payslips }[tab] || checkin)(body);
}

/* ------------------------------------------------------------------ check in */
async function checkin(body) {
  let d = await api.get('/api/me/attendance');
  const clockEl = h('div', { class: 'clock-time' });
  const dateEl = h('div', { class: 'clock-date' });
  const tick = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  tick();
  let attached = false;
  const timer = setInterval(() => {
    if (clockEl.isConnected) attached = true;
    else if (attached) { clearInterval(timer); return; }
    tick();
  }, 1000);

  const geoBox = h('div', { class: 'mt-8' });
  const btnBox = h('div');
  const todayBox = h('div');
  const mapEl = h('div', { class: 'map' });
  let pos = null; // { lat, lng, accuracy, ts }
  let watchId = null;
  let mapObj = null;
  let meMarker = null;
  let meCircle = null;
  const fenceLayers = [];

  const nearest = () => {
    if (!pos || !d.fences.length) return null;
    return d.fences.map((f) => ({ f, dist: distanceM(pos.lat, pos.lng, f.lat, f.lng) })).sort((a, b) => a.dist - b.dist)[0];
  };

  function drawGeo() {
    if (d.mode === 'none') return clear(geoBox);
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      return clear(geoBox, alertBox('This browser cannot share your location. Open the site over https:// and allow location access.', 'bad', 'alert'));
    }
    if (!pos) return clear(geoBox, h('span', { class: 'geo-status', style: { background: 'var(--grey-soft)', color: 'var(--muted)' } }, h('span', { class: 'spinner', style: { width: '14px', height: '14px', borderWidth: '2px' } }), 'Finding your location…'));
    const n = nearest();
    const inside = n && n.dist <= n.f.radius_m;
    const accOk = pos.accuracy <= d.maxAccuracy;
    const parts = [];
    if (d.mode === 'geofence') {
      parts.push(inside
        ? h('span', { class: 'geo-status', style: { background: 'var(--ok-soft)', color: 'var(--ok)' } }, icon('checkCircle', 16), `At ${n.f.name}`)
        : h('span', { class: 'geo-status', style: { background: 'var(--bad-soft)', color: 'var(--bad)' } }, icon('pin', 16), n ? `${fmtDist(n.dist)} from ${n.f.name} (need ${n.f.radius_m} m)` : 'No office location set up for you'));
    } else {
      parts.push(h('span', { class: 'geo-status', style: { background: 'var(--info-soft)', color: 'var(--info)' } }, icon('pin', 16), inside ? `At ${n.f.name}` : 'Field attendance: any location'));
    }
    parts.push(h('div', { class: 'tiny muted mt-8' }, `GPS accuracy ±${Math.round(pos.accuracy)} m${accOk ? '' : ` — needs ±${d.maxAccuracy} m or better`}`));
    clear(geoBox, h('div', { class: 'col', style: { alignItems: 'center' } }, parts));
    drawButton();
  }

  function drawButton() {
    const punchesToday = d.punches.length;
    const isOut = punchesToday % 2 === 1;
    if (d.mode === 'none') {
      return clear(btnBox, h('div', { class: 'mt-16' }, alertBox('Please use the attendance machine at your office. Mobile check-in is not switched on for you.', '', 'finger')));
    }
    const n = nearest();
    const can = pos && pos.accuracy <= d.maxAccuracy && (d.mode === 'anywhere' || (n && n.dist <= n.f.radius_m));
    const btn = h('button', { class: ['punch-btn', isOut && 'out'], disabled: !can, onclick: () => punch(btn, isOut) },
      h('span', null, icon(isOut ? 'logout' : 'finger', 34), isOut ? 'Check out' : 'Check in'));
    clear(btnBox, btn);
  }

  async function punch(btn, isOut) {
    btn.disabled = true;
    try {
      // the live position from the watch is used when it is recent; otherwise ask for a fix
      const fresh = pos && Date.now() - pos.ts < 15000 ? pos : await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() }),
        (e) => reject(new Error(e.code === 1 ? 'Location permission was denied. Allow it in your browser settings.' : 'Could not get your location. Try again.')),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }));
      pos = fresh;
      let note = null;
      const n = nearest();
      if (d.mode === 'anywhere' && !(n && n.dist <= n.f.radius_m) && S.me.org.settings.mobile_require_note_anywhere) {
        note = window.prompt('Where are you working from? (e.g. client visit)');
        if (!note) { btn.disabled = false; return; }
      }
      const r = await api.post('/api/me/punch', { lat: fresh.lat, lng: fresh.lng, accuracy: fresh.accuracy, direction: isOut ? 'out' : 'in', note });
      if (navigator.vibrate) navigator.vibrate(30);
      toast(`${isOut ? 'Checked out' : 'Checked in'} at ${time(r.time)}${r.place ? ` · ${r.place}` : ''}`);
      d = await api.get('/api/me/attendance');
      drawToday();
      drawGeo();
    } catch (err) {
      errorToast(err);
      btn.disabled = false;
    }
  }

  function drawToday() {
    const day = d.day;
    clear(todayBox, card('Today', h('div', null,
      h('div', { class: 'row wrap gap-16 mb-16' },
        h('div', null, h('div', { class: 'tiny muted' }, 'Status'), day ? attBadge(day) : badge('Not started')),
        h('div', null, h('div', { class: 'tiny muted' }, 'First in'), h('div', { class: 'strong' }, day ? time(day.first_in) : '—')),
        h('div', null, h('div', { class: 'tiny muted' }, 'Last out'), h('div', { class: 'strong' }, day ? time(day.last_out) : '—')),
        h('div', null, h('div', { class: 'tiny muted' }, 'Worked'), h('div', { class: 'strong' }, day ? duration(day.worked_minutes) : '—')),
        day && day.shift_start ? h('div', null, h('div', { class: 'tiny muted' }, 'Shift'), h('div', { class: 'strong' }, `${day.shift_start}–${day.shift_end}`)) : null),
      day && day.late_minutes ? h('div', { class: 'mb-8' }, alertBox(`You were ${duration(day.late_minutes)} late today.`, 'warn', 'clock')) : null,
      d.punches.length ? h('ul', { class: 'list', style: { margin: '0 -18px -18px' } }, d.punches.map((p, i) => h('li', null,
        h('span', { class: 'avatar sm', style: { background: i % 2 ? '#e11d48' : 'var(--brand)' } }, icon(i % 2 ? 'logout' : 'login', 13)),
        h('strong', null, time(p.punch_time)), h('span', { class: 'small muted grow' }, `${p.source === 'mobile' ? 'Phone' : p.source === 'device' ? 'Machine' : p.source}${p.branch_name ? ` · ${p.branch_name}` : p.distance_m !== null && p.source === 'mobile' ? ` · ${fmtDist(p.distance_m)} from office` : ''}`))))
        : h('p', { class: 'muted small' }, 'No punches yet today.')),
    { actions: h('button', { class: 'btn sm ghost', onclick: () => requestCorrection() }, icon('edit', 14), 'Correct attendance') }));
  }

  body.append(h('div', { class: 'grid grid-2' },
    h('div', { class: 'card clock-card' }, clockEl, dateEl, btnBox, geoBox),
    h('div', { class: 'col gap-16' }, todayBox, d.mode !== 'none' && d.fences.length ? card('Your offices', mapEl, { flush: false }) : null)));
  drawToday();
  drawButton();
  drawGeo();

  if (d.mode !== 'none' && 'geolocation' in navigator && window.isSecureContext) {
    watchId = navigator.geolocation.watchPosition((p) => {
      if (!body.isConnected) { navigator.geolocation.clearWatch(watchId); return; }
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() };
      drawGeo();
      if (mapObj) {
        const { L, map } = mapObj;
        if (!meMarker) {
          meMarker = L.circleMarker([pos.lat, pos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map).bindTooltip('You');
          meCircle = L.circle([pos.lat, pos.lng], { radius: pos.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(map);
          map.fitBounds(L.featureGroup([meMarker, ...fenceLayers]).getBounds().pad(0.3), { maxZoom: 17 });
        } else { meMarker.setLatLng([pos.lat, pos.lng]); meCircle.setLatLng([pos.lat, pos.lng]).setRadius(pos.accuracy); }
      }
    }, (e) => {
      clear(geoBox, alertBox(e.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings, then reload.' : 'Could not get your location. Make sure GPS is on.', 'bad', 'alert'));
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  if (d.mode !== 'none' && d.fences.length) {
    makeMap(mapEl, { lat: d.fences[0].lat, lng: d.fences[0].lng, zoom: 16 }).then((m) => {
      mapObj = m;
      for (const f of d.fences) {
        const c = m.L.circle([f.lat, f.lng], { radius: f.radius_m, color: '#4f46e5', weight: 2, fillOpacity: 0.12 }).addTo(m.map).bindTooltip(h('span', null, f.name));
        fenceLayers.push(c);
      }
      if (fenceLayers.length > 1) m.map.fitBounds(m.L.featureGroup(fenceLayers).getBounds().pad(0.2));
    }).catch(() => clear(mapEl, h('p', { class: 'muted small', style: { padding: '12px' } }, 'The map could not load.')));
  }
}

function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }

/* ------------------------------------------------------------------ my attendance */
async function attendance(body) {
  body.append(h('div', { class: 'row mb-16' }, h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => requestCorrection(() => navigate('/me/attendance')) }, icon('edit', 16), 'Correct attendance')));
  const corr = await api.get('/api/regularizations', { scope: 'mine' });
  body.append(attendanceMonth(null));
  if (corr.length) {
    body.append(h('div', { class: 'mt-16' }, card('My correction requests', table({
      rows: corr, compact: true,
      columns: [
        { key: 'work_date', label: 'Day', render: (r) => date(r.work_date) },
        { key: 'in_time', label: 'In', render: (r) => r.in_time || '—' },
        { key: 'out_time', label: 'Out', render: (r) => r.out_time || '—' },
        { key: 'reason', label: 'Reason' },
        { key: 'status', label: 'Status', render: (r) => badge(r.status, { pending: 'warn', approved: 'ok', rejected: 'bad' }[r.status] || '') },
        { key: 'x', label: '', render: (r) => (r.status === 'pending' ? h('button', { class: 'btn xs', onclick: async () => { await api.post(`/api/regularizations/${r.id}/cancel`); toast('Cancelled'); navigate('/me/attendance'); } }, 'Cancel') : null) },
      ],
    }), { flush: true })));
  }
}

/* ------------------------------------------------------------------ my leave */
async function leave(body) {
  const reload = () => navigate('/me/leave');
  const [bal, reqs] = await Promise.all([api.get('/api/leave/balances'), api.get('/api/leave/requests', { scope: 'mine' })]);
  body.append(h('div', { class: 'row wrap mb-16' }, h('h3', { class: 'grow', style: { minWidth: '220px' } }, `Leave year ${bal.year}`),
    h('a', { class: 'btn', href: '#/leave/calendar' }, icon('calendar', 16), 'Team calendar'),
    h('button', { class: 'btn primary', onclick: () => applyLeave({ onDone: reload }) }, icon('plus', 16), 'Apply for leave')));
  if (S.me.employee.status === 'probation') body.append(h('div', { class: 'mb-16' }, alertBox('You are on probation: some leave types become available once you are confirmed.', 'info', 'info')));
  body.append(balanceCards(bal.balances));
  body.append(h('div', { class: 'mt-24' }, card('My requests', reqs.length ? leaveRequestsTable(reqs, { showName: false, onChange: reload }) : empty('No leave requests yet', 'Apply for leave and your manager will be asked to approve it.', null, 'calendar'), { flush: true })));
}

/* ------------------------------------------------------------------ my payslips */
async function payslips(body) {
  const list = await api.get('/api/me/payslips');
  body.append(card(null, list.length ? h('ul', { class: 'list' }, list.map((p) => h('li', { class: 'click', onclick: () => navigate(`/payslips/${p.id}`) },
    h('span', { class: 'avatar', style: { background: 'var(--brand-soft)', color: 'var(--brand)', borderRadius: '10px' } }, icon('banknote', 18)),
    h('div', { class: 'grow' }, h('div', { class: 'strong' }, monthLabel(p.month)), h('div', { class: 'tiny muted' }, p.status === 'paid' ? 'Paid' : 'Approved')),
    h('div', { class: 'right' }, h('div', { class: 'strong num' }, money(p.net, { symbol: true })), h('div', { class: 'tiny muted' }, 'net pay')), icon('right', 16))))
    : empty('No payslips yet', 'Your payslips appear here once payroll is approved.', null, 'banknote'), { flush: true }));
}

