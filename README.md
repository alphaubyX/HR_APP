# Broadwing HR

HR and payroll for the Broadwing suite: employees from onboarding to exit, a drag-and-drop organogram, leave with approval chains, attendance from machines and phones (with geofences), and payroll with payslips. One server hosts many organizations, each with its own private data.

Everything that used to be hard-coded (salary parts, attendance rules, leave rules, holidays, approval levels, tax) is a setting each organization controls.

## What it does

**Employees**
- Step-by-step onboarding: personal details, job and line manager, shift and attendance setup, bank details, salary, and a sign-in account.
- Probation: every new employee starts on probation for the organization's default number of days (or their own). HR gets reminders 7 days and 1 day before it ends, then confirms them as permanent or extends it.
- Statuses: Joining → Probation → Permanent, plus Notice period, Suspended and Left (with rehire). Each change goes into the employee's history.
- Import employees from a spreadsheet (CSV) to move over from another system.
- Onboarding and exit checklists, documents (contracts, ID copies; with expiry dates), timeline, and a private HR notes field.

**Organogram**
- Reporting lines chart: drag a person (from the list or a card) onto their new manager. Drop on "top" to remove the manager. Loops (someone managing their own boss) are refused. Large teams of individual contributors stack compactly.
- Departments chart: drag departments inside each other; drop a person on a department to make them its head.
- Collapse and expand teams, search, filter by department, zoom, pan, fit, print. Works with touch (long-press to drag).
- The organogram drives approvals: an employee's leave goes to their line manager, then their manager's manager, and so on.

**Salary**
- Salary components (basic, house rent, fuel, medical, provident fund…) as earnings, deductions or employer contributions. Each is a fixed amount, a percentage of the gross or of another component, a formula, or "the rest of the gross".
- Formulas use component codes: `BASIC * 0.45`, `min(GROSS * 0.1, 5000)`, `if(GROSS > 100000, 2500, 1500)`.
- Salary structures (ready-made splits), grades, salary revisions with effective dates, bulk increments, loans and advances with monthly installments, and one-off adjustments (bonus, arrears, fines).
- Income tax from yearly slabs that each organization maintains.

**Leave**
- Leave types with yearly days, carry-forward limit, paid/unpaid, half days, notice, probation eligibility, gender, and the "sandwich" setting (weekends inside a leave count or not).
- Leave years reset on 1 January (or any month you choose): everyone gets a fresh allocation, prorated for people who joined during the year; leftover days carry forward up to the limit and the rest lapses. Everything is kept in a leave ledger.
- Approval chain: line manager → (optionally) the next levels up → (optionally) HR. A manager who is on leave or has left is skipped. Requests that wait too long move up a level by themselves. HR can always step in, and can record leave for someone.
- Team calendar with holidays, and a balances register for HR.

**Attendance**
- From machines: ZKTeco "ADMS" push (the machine sends punches to the server within seconds), the pull agent in `agent/` for machines on a closed network, a REST API with a device key, or CSV import from any machine software.
- From phones: each employee is set to machine only, phone inside an office geofence, or phone anywhere (field staff). Office locations and radiuses are set on a map. The server checks the distance and GPS accuracy itself.
- Shifts (with night shifts and short days such as Friday half day), public holidays and exceptional days (rain, strike, outage: office closed, attendance relaxed, or half day — for all branches or one).
- Attendance policies decide: grace time, every N lates = D days deducted, very late = half day, early leaving, short time, absences, single punches, the sandwich rule, whether deductions come from leave first, and overtime rates. Different policies for different groups.
- Daily board, a colour-coded monthly sheet, punches log, correction requests (approved by the manager), and HR can set any day by hand.

**Payroll**
- One payroll per month (or a custom period such as 26th–25th). Processing reads salaries, attendance, leave, loans, adjustments and tax, and makes payslips. Recalculate as often as needed, hold individual payslips, approve (locks it and records loan installments), mark as paid (employees are notified), reopen if needed.
- Payroll register and bank transfer list as CSV; printable payslips (save as PDF).

**Self-service (web and phone)**
- Check in / out with GPS, today's punches, monthly attendance, correction requests, leave balances and requests, payslips, own profile. Installable on phones as an app (PWA).
- Managers get an approvals inbox and see their team.

**Platform**
- Many organizations on one server, each with its own data. A person can belong to several organizations and switch between them.
- Roles: Administrator, HR manager, Payroll officer, Employee. Line managers are found from the organogram.
- The server owner sees every organization, sets plans, employee limits, and can suspend one.
- Single sign-on from Broadwing (see below), activity log, notifications, dark mode.

## Quick start (on your computer)

You need Node.js 22.13 or newer.

```bash
npm install
npm run seed:demo     # optional: a demo company (SQLite, in ./data)
npm start             # http://localhost:3100
```

Without a `.env`, it uses SQLite in `./data/hr.db`. With the demo, sign in as `demo` / `demo12345` (administrator), `ayesha` (HR), `bilal` (manager) or `sara` (employee with phone check-in); the password is `demo12345` for all.

Without the demo, the first visit asks you to create the owner account and your organization. For production, copy `.env.example` to `.env` and point it at MySQL.

## Configuration

| Variable | Meaning |
|---|---|
| `HR_DB_CLIENT` | `mysql` (production) or `sqlite` (trial). Defaults to MySQL when `HR_DB_NAME` is set. |
| `HR_DB_HOST`, `HR_DB_PORT`, `HR_DB_NAME`, `HR_DB_USER`, `HR_DB_PASSWORD`, `HR_DB_SOCKET` | MySQL / MariaDB connection |
| `HR_SQLITE_FILE` | SQLite file (default `data/hr.db`) |
| `HR_DATA_DIR` | Where uploaded documents are kept (default `data`) |
| `HR_OWNER_USERNAME`, `HR_OWNER_PASSWORD`, `HR_OWNER_NAME` | The server owner, created on first start |
| `HR_OWNER_RESET_PASSWORD` | `true` for one start to reset the owner's password |
| `HR_SIGNUP` | `on` lets companies sign up at `/#signup` |
| `BROADWING_SSO_SECRET` | Shared secret for single sign-on from Broadwing |
| `TRUST_PROXY` | `1` behind a proxy that handles HTTPS |
| `PORT` | Port (default 3100) |

The database tables are created and upgraded automatically on start.

## Connecting attendance machines

1. **ZKTeco push (best).** On the machine: *Comm. → Cloud Server Setting*: server address = your HR site, port 443 with HTTPS on (or 80). In HR: *Attendance → Machines & import → Add machine*, type "Machine pushes", and its serial number. Punches arrive within seconds.
2. **Pull agent.** For machines on the office network only: on an office PC, `cd agent && npm install`, fill in `.env` (HR address, the device key from *Get key*, the machine's IP) and run `npm start` (or `npm run once` from Task Scheduler). It uses the `node-zklib` library for ZKTeco machines; test it with your model before relying on it.
3. **API.** `POST /api/device/punches` with header `X-Device-Key` and `{ "punches": [{ "user_id": "15", "time": "2026-10-08 09:02:11" }] }`.
4. **CSV.** Export from the machine software and drop the file on the import box.

Each employee's *attendance machine number* links their punches. Punches for numbers nobody has yet are kept and linked as soon as the number is entered.

Phone check-in needs the site on **HTTPS** (browsers only share GPS with secure sites). A determined person can fake GPS on a rooted phone; the punches log shows each phone punch's location and distance, so HR can spot anything odd.

## Single sign-on from Broadwing

Set the same `BROADWING_SSO_SECRET` in both systems. Broadwing sends the signed-in user to:

```
https://hr.yourdomain.com/api/sso/broadwing?token=<payload>.<signature>
```

- `payload` = base64url of `{"u": "<username or email>", "org": "<organization code, optional>", "exp": <unix seconds, e.g. now + 60>}`
- `signature` = base64url of HMAC-SHA256(payload, secret)

PHP example:

```php
$b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
$payload = $b64(json_encode(['u' => $user['email'], 'org' => 'alpha-traders', 'exp' => time() + 60]));
$sig = $b64(hash_hmac('sha256', $payload, getenv('BROADWING_SSO_SECRET'), true));
header("Location: https://hr.yourdomain.com/api/sso/broadwing?token=$payload.$sig");
```

The HR user must exist with the same username or email (create it under *Settings → Users & roles*).

## Development

```bash
npm run dev     # restart on changes
npm test        # engine and API tests on SQLite
HR_TEST_MYSQL=mysql://user:pass@localhost npm test   # the same tests on MySQL (creates and drops a temporary database)
```

- `server/engine/`: the rules, with no database: formulas, salary components, attendance, leave, payroll, policies.
- `server/services/`: loading data and running the engines (attendance processing, leave ledger, approvals, payroll runs).
- `server/routes/`: the REST API. `server/routes/iclock.js` is the ZKTeco push endpoint.
- `server/db/`: one small API over MySQL and SQLite; the schema and migrations.
- `public/`: the web app (plain JavaScript modules, no build step). Maps use Leaflet with OpenStreetMap tiles.
- `agent/`: the attendance pull agent.

## Not included yet

Recruitment, performance reviews, e-mail / SMS notifications, final settlement and gratuity calculations, native Android/iOS apps (the web app installs on phones; a native wrapper can follow), and online payments for subscriptions.
