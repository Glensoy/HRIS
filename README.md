# Web-Based HRIS with SMS Integration

A working implementation of the case study "Web-Based Human Resource Information System with SMS Integration".

**Stack:** Node.js · Express · SQLite (normalized relational DB) · vanilla HTML/CSS/JS front end · Semaphore / Twilio SMS API

## Run it

```bash
npm install
cp .env.example .env     # optional; defaults to SMS sandbox mode
npm start                # http://localhost:3000
```

Requires Node.js 18+ (uses the built-in `fetch`). The database file `hris.db` is created and seeded on first run. Run `npm run seed` to reset it.

### Demo accounts

| Username | Password | Role |
|---|---|---|
| admin | admin123 | Admin |
| hr | hr123 | HR Staff |
| juan | emp123 | Employee |
| ana | emp123 | Employee |

Change these before any real use.

## Objectives -> features

| Study objective | Where it lives |
|---|---|
| Centralized web app with a secure relational database | `db.js` (users, roles, employees, departments, leave_types, leave_balances, leave_requests, announcements, sms_log, audit_log) |
| Multi-role access (Admin, HR Staff, Employee) | `requireRole()` in `server.js`; role-aware menus in `public/app.js` |
| Profile management and structured leave workflow | Employees page (staff), My Profile (self-service), My Leave -> Leave Approvals |
| Semaphore / Twilio SMS integration | `sms.js`; triggered on leave approve/reject and on announcements |
| Testing for usability, reliability, security | See "Security notes" below |

## SMS integration

Set `SMS_PROVIDER` in `.env`:

- `sandbox` (default): nothing is sent; every message is written to the **SMS Log** page and console. Good for the project demo.
- `semaphore`: set `SEMAPHORE_API_KEY` (and optionally `SEMAPHORE_SENDER_NAME`).
- `twilio`: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`. Trial accounts can only text verified numbers.

SMS is sent when:
1. HR/Admin approves or rejects a leave request (employee gets the decision and remarks).
2. An announcement is published with "Also send as SMS", or marked **urgent** (always sent). It can target all staff or one department.

Employees can opt out of SMS on their profile. Every attempt, successful or not, is stored in `sms_log`. The free-tier limits of the provider apply (as noted in the paper's limitations).

## Business rules

- Weekends are not counted as leave days.
- Overlapping pending/approved requests are blocked (prevents schedule clashes).
- Requests that exceed the remaining balance are blocked.
- Only pending requests can be reviewed; people cannot review their own requests.
- HR Staff cannot create Admin accounts; only Admin can change roles, deactivate, delete, or reset passwords.

## Security notes

- Passwords are hashed with bcrypt; sessions use httpOnly cookies.
- All SQL uses parameterized queries; all rendered output is HTML-escaped.
- Every API route checks authentication and role on the server.
- Sensitive actions are recorded in the Audit Log (Admin only).
- Before production: set a strong `SESSION_SECRET`, serve over HTTPS (and set `cookie.secure`), add login rate limiting, and change the demo passwords.

## Out of scope (per the paper)

No payroll or live monetary transactions, and no automated SSS / PhilHealth / Pag-IBIG remittances.
