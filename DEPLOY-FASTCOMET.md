# Putting Broadwing HR on FastComet (cPanel)

This puts the HR app at an address like `https://hr.yourdomain.com`, as its own Node.js app, using a MySQL database.

> Menu names are cPanel's standard ones; FastComet's may differ slightly.

## 1. Make the address

**cPanel → Domains → Create A New Domain**: e.g. `hr.yourdomain.com`.

## 2. Create the MySQL database

1. **cPanel → MySQL® Databases**.
2. Create a database, e.g. `cpaneluser_hr`.
3. Create a user, e.g. `cpaneluser_hr`, with a strong password.
4. **Add User To Database** and tick **ALL PRIVILEGES**.

The app creates its tables on first start.

## 3. Direct upload from GitHub

Every push to `main` runs the tests and then uploads the changed files straight into the app folder on the server over FTPS, restarts the app and checks it answers. Set it up once:

1. **File Manager**: in your home folder (not inside `public_html`) create `broadwing-hr` (the app) and `broadwing-hr-data` (uploaded documents).
2. **cPanel → FTP Accounts → Add FTP Account**: e.g. `hrdeploy@yourdomain.com`, a strong password, and set **Directory** to `broadwing-hr`. This account can only touch the HR app folder.
3. **GitHub → HR_APP → Settings → Secrets and variables → Actions**:
   - **Secrets** → New repository secret:
     | Name | Value |
     |---|---|
     | `FTP_SERVER` | your FTP host, e.g. `ftp.yourdomain.com` (shown under *FTP Accounts → Configure FTP Client*) |
     | `FTP_USERNAME` | `hrdeploy@yourdomain.com` |
     | `FTP_PASSWORD` | its password |
   - **Variables** → New repository variable: `SITE_URL` = `https://hr.yourdomain.com` (used to check the site after each upload; add it after step 5).
4. **GitHub → Actions → "Test and upload to the web server" → Run workflow** for the first upload. After that it runs on every push to `main`.

If you'd rather use an FTP account that opens higher up (e.g. your main cPanel account), also add the secret `FTP_SERVER_DIR` = `broadwing-hr/`.

The upload never sends `node_modules`, `.env`, `test/`, `agent/` or your data, and only sends files that changed since the last upload.

Prefer doing it by hand? Download the repository as a ZIP (**Code → Download ZIP**), upload and extract it in `broadwing-hr` so `package.json` is directly inside it.

## 4. Create the Node.js app

**cPanel → Setup Node.js App → Create Application**:

| Field | Value |
|---|---|
| Node.js version | the highest available (22 or newer recommended; 20 works with MySQL) |
| Application mode | Production |
| Application root | `broadwing-hr` |
| Application URL | `hr.yourdomain.com` |
| Application startup file | `server/index.js` |

Environment variables (**Add Variable** for each):

| Name | Value |
|---|---|
| `HR_DB_CLIENT` | `mysql` |
| `HR_DB_HOST` | `localhost` |
| `HR_DB_NAME` | `cpaneluser_hr` |
| `HR_DB_USER` | `cpaneluser_hr` |
| `HR_DB_PASSWORD` | the database password |
| `HR_DATA_DIR` | `/home/CPANELUSER/broadwing-hr-data` |
| `HR_OWNER_USERNAME` | your owner username |
| `HR_OWNER_PASSWORD` | a strong password |
| `HR_OWNER_NAME` | your name |
| `TRUST_PROXY` | `1` |
| `HR_SIGNUP` | `off` (or `on` to let companies sign up) |
| `BROADWING_SSO_SECRET` | optional, see README |

Click **Create**. Once the first upload has finished (step 3), click **Run NPM Install**, then **Restart**.

## 5. HTTPS

**cPanel → SSL/TLS Status → Run AutoSSL** for `hr.yourdomain.com`, and turn on **Force HTTPS Redirect** under **Domains**. HTTPS is required for phone check-in (browsers only share location with secure sites) and for ZKTeco machines set to HTTPS.

## 6. First sign-in

Open `https://hr.yourdomain.com` and sign in as the owner. Then:

1. **Settings → Company profile**: name, logo, currency, time zone.
2. **Settings → Branches & geofences**: set each office's location on the map.
3. **Settings → Shifts, Attendance policies, Holidays, Leave types, Salary components, Tax slabs**.
4. **Employees → Import** your current employees from a spreadsheet (download the template there), or **Add employee** one by one.
5. **Organogram**: drag people under their managers.
6. **Attendance → Machines & import**: connect the machine.

To start another organization: **All organizations → New organization**.

## Updating later

Push to `main`: the workflow tests and uploads, and the app restarts by itself. Only when `package.json` changed (new libraries) click **Run NPM Install** and **Restart** in Setup Node.js App. Database upgrades run automatically. Your data in MySQL and `broadwing-hr-data` is not touched.

## Backups

Back up the MySQL database (**cPanel → Backup** or phpMyAdmin → Export) and the `broadwing-hr-data` folder (uploaded documents).

## If something goes wrong

- The app's log (`stderr.log` in `broadwing-hr`, or the log link on the app page) shows `Broadwing HR could not start: …` with the reason, e.g. a wrong database password.
- **"SQLite needs Node.js 22.13"**: you are missing `HR_DB_CLIENT=mysql`.
- **Phone check-in says the browser can't share location**: the site is not on HTTPS.
- **Forgot the owner password**: set `HR_OWNER_RESET_PASSWORD` = `true`, put a new `HR_OWNER_PASSWORD`, Restart, then remove the reset variable.
- **Background tasks** (attendance processing, leave year allocation, probation reminders, escalations) run inside the app every 15 minutes. If cPanel puts the app to sleep when nobody uses it, they catch up as soon as someone opens it.
