// The public page where candidates apply for a job: no sign-in, PDF CV only.
import { h, clear, alertBox, money, date } from './ui.js';

const token = location.pathname.split('/').filter(Boolean)[1] || '';
const root = document.getElementById('app');

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
  return data;
}

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.readAsDataURL(file);
});

async function main() {
  let job;
  try { job = await call('GET', `/api/public/jobs/${encodeURIComponent(token)}`); } catch {
    clear(root, h('div', { class: 'card apply-card' }, h('h1', null, 'Job not found'), h('p', { class: 'muted' }, 'This link is not valid or the job was removed.')));
    return;
  }
  document.getElementById('org-name').textContent = job.org.name;
  document.title = `${job.title} · ${job.org.name}`;
  const salary = job.salary_min || job.salary_max
    ? `${job.currency} ${job.salary_min ? money(job.salary_min) : '…'} – ${job.salary_max ? money(job.salary_max) : '…'} a month` : null;
  const head = h('div', null,
    h('h1', null, job.title),
    h('div', { class: 'apply-meta' }, [job.location, salary, job.deadline && `Apply by ${date(job.deadline)}`, job.positions > 1 && `${job.positions} positions`].filter(Boolean).map((t) => h('span', { class: 'chip' }, t))),
    job.description ? h('div', { class: 'job-desc mt-16' }, job.description) : null);
  if (!job.open) {
    clear(root, h('div', { class: 'card apply-card' }, head, h('div', { class: 'mt-16' }, alertBox('This job is no longer taking applications.', 'warn', 'info'))));
    return;
  }
  const err = h('div');
  const name = h('input', { class: 'input', name: 'name', required: true, autocomplete: 'name' });
  const email = h('input', { class: 'input', name: 'email', type: 'email', required: true, autocomplete: 'email' });
  const phone = h('input', { class: 'input', name: 'phone', autocomplete: 'tel' });
  const cv = h('input', { class: 'input', name: 'cv', type: 'file', accept: 'application/pdf,.pdf', required: true });
  const consent = h('input', { type: 'checkbox', name: 'consent' });
  const send = h('button', { class: 'btn primary block', type: 'submit' }, 'Send my application');
  const field = (label, input, help) => h('div', { class: 'field full' }, h('label', null, label), input, help ? h('div', { class: 'help' }, help) : null);
  const form = h('form', { class: 'form one mt-24' },
    h('h2', null, 'Apply'),
    field('Full name *', name), field('Email *', email), field('Phone', phone),
    field('CV (PDF only, up to 5 MB) *', cv),
    h('label', { class: 'check mt-8' }, consent, h('div', { class: 'small' },
      `I agree that ${job.org.name} keeps my CV for up to one year to consider me for jobs, and may use an AI assistant to help review it. It is deleted after one year.`)),
    err, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    const file = cv.files[0];
    try {
      if (!name.value.trim() || !email.value.trim()) throw new Error('Please fill in your name and email.');
      if (!file) throw new Error('Please attach your CV as a PDF.');
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('Your CV must be a PDF file.');
      if (file.size > 5 * 1024 * 1024) throw new Error('Your CV must be 5 MB or smaller.');
      if (!consent.checked) throw new Error('Please tick the box to agree to how your CV is kept.');
      send.disabled = true;
      send.textContent = 'Sending…';
      await call('POST', `/api/public/jobs/${encodeURIComponent(token)}/apply`, {
        name: name.value, email: email.value, phone: phone.value, consent: true, cv: { name: file.name, data: await fileToBase64(file) },
      });
      clear(root, h('div', { class: 'card apply-card' }, h('h1', null, 'Thank you!'), h('p', null, `Your application for ${job.title} has been sent to ${job.org.name}. They will contact you if your profile matches.`)));
    } catch (x) {
      clear(err, h('div', { class: 'mt-16' }, alertBox(x.message, 'bad', 'alert')));
      send.disabled = false;
      send.textContent = 'Send my application';
    }
  });
  clear(root, h('div', { class: 'card apply-card' }, head, form));
}

main();
