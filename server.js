require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const sms = require('./sms');
const email = require('./email');
const notifier = require('./notify');
const holidays = require('./holidays');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const audit = (userId, action, detail) =>
  db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)').run(userId, action, detail || null);

const requireAuth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: 'Please log in.' });

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.session.user?.role) ? next() : res.status(403).json({ error: 'Access denied.' });

const isStaff = (u) => u.role === 'Admin' || u.role === 'HR Staff';

const wrap = (fn) => (req, res) => {
  try { const r = fn(req, res); if (r && r.catch) r.catch(e => fail(res, e)); }
  catch (e) { fail(res, e); }
};
function fail(res, e) {
  console.error(e);
  const msg = /UNIQUE/.test(e.message) ? 'Duplicate value (username or employee number already exists).' : e.message;
  res.status(400).json({ error: msg });
}

function businessDays(start, end) {
  // inclusive count of working days: weekends and public/company holidays are skipped
  const hol = new Set(db.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(start, end).map(r => r.date));
  const d = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
  let n = 0;
  while (d <= e) { const w = d.getDay(); if (w !== 0 && w !== 6 && !hol.has(localDate(d))) n++; d.setDate(d.getDate() + 1); }
  return n;
}

// Send one message to many employees by SMS and email (sequential, to respect free-tier rate limits).
// People without a number/address or who opted out are skipped, not counted as failures.
async function broadcast(targets, subject, text, trigger) {
  const tally = { sms: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0 } };
  const count = (bucket, r) => { if (r.ok) bucket.sent++; else if (!/opted out/.test(r.error || '')) bucket.failed++; };
  for (const t of targets) {
    const out = await notifier.notify(t.id, { subject, message: text, trigger });
    count(tally.sms, out.sms); count(tally.email, out.email);
  }
  return tally;
}

const EMP_SELECT = `
  SELECT e.*, u.username, u.is_active, u.otp_enabled, r.name AS role, d.name AS department
  FROM employees e
  JOIN users u ON u.id = e.user_id
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = e.department_id`;

// ---------- Auth ----------
// Login: password first, then (when required) a 6-digit code sent by SMS.
const OTP_MODE = (process.env.OTP_MODE || 'optional').toLowerCase(); // off | optional (user opts in) | staff (Admin + HR always) | all
const OTP_TTL_MS = 5 * 60 * 1000, OTP_MAX_TRIES = 5, OTP_RESEND_MS = 30 * 1000;
const hashCode = (c) => crypto.createHash('sha256').update(String(c) + (process.env.SESSION_SECRET || 'dev-secret')).digest('hex');
const maskMobile = (m) => { const n = sms.normalizeNumber(m, 'semaphore') || ''; return n.length > 5 ? n.slice(0, 2) + '*'.repeat(n.length - 5) + n.slice(-3) : '****'; };
const otpRequired = (u) => OTP_MODE === 'off' ? false : OTP_MODE === 'all' ? true
  : (OTP_MODE === 'staff' && (u.role === 'Admin' || u.role === 'HR Staff')) || !!u.otp_enabled;
const userById = (id) => db.prepare('SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(id);

function finishLogin(req, u) {
  const emp = db.prepare('SELECT id, first_name, last_name FROM employees WHERE user_id = ?').get(u.id);
  req.session.user = { id: u.id, username: u.username, role: u.role, employeeId: emp?.id, name: emp ? `${emp.first_name} ${emp.last_name}` : u.username };
  audit(u.id, 'login');
  return req.session.user;
}

async function sendOtp(req, res, u) {
  const emp = db.prepare('SELECT id, mobile FROM employees WHERE user_id = ?').get(u.id);
  if (!emp || !sms.normalizeNumber(emp.mobile, sms.PROVIDER)) {
    delete req.session.pending;
    return res.status(400).json({ error: 'An SMS code is required but your account has no valid mobile number. Ask HR or an administrator to add one.' });
  }
  const code = String(crypto.randomInt(100000, 1000000));
  req.session.pending = { userId: u.id, hash: hashCode(code), expires: Date.now() + OTP_TTL_MS, tries: 0, sentAt: Date.now() };
  const out = await sms.sendSMS({ employeeId: emp.id, mobile: emp.mobile, trigger: 'otp',
    message: `HRIS login code: ${code}. Valid for 5 minutes. Never share this code.`, logMessage: 'HRIS login code: ****** (hidden)' });
  if (!out.ok) { delete req.session.pending; return res.status(502).json({ error: `Could not send the SMS code: ${out.error}` }); }
  audit(u.id, 'otp_sent');
  // In sandbox mode no real SMS exists, so the code is returned for demos. Never done with a real provider.
  res.json({ otpRequired: true, mobile: maskMobile(emp.mobile), expiresInSeconds: OTP_TTL_MS / 1000, ...(sms.PROVIDER === 'sandbox' ? { devCode: code } : {}) });
}

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare(`SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE username = ?`).get(username || '');
  if (!u || !u.is_active || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password.' });
  delete req.session.user;
  if (otpRequired(u)) return sendOtp(req, res, u);
  res.json(finishLogin(req, u));
}));

app.post('/api/login/verify', wrap((req, res) => {
  const p = req.session.pending;
  if (!p) return res.status(400).json({ error: 'No login in progress. Please sign in again.' });
  if (Date.now() > p.expires) { delete req.session.pending; return res.status(401).json({ error: 'The code expired. Please sign in again.' }); }
  if (p.tries >= OTP_MAX_TRIES) { delete req.session.pending; return res.status(429).json({ error: 'Too many wrong codes. Please sign in again.' }); }
  p.tries++;
  const ok = crypto.timingSafeEqual(Buffer.from(hashCode(String(req.body.code || '').trim())), Buffer.from(p.hash));
  if (!ok) return res.status(401).json({ error: `Wrong code. ${OTP_MAX_TRIES - p.tries} attempt(s) left.` });
  const u = userById(p.userId);
  if (!u || !u.is_active) { delete req.session.pending; return res.status(401).json({ error: 'Account is not active.' }); }
  delete req.session.pending;
  res.json(finishLogin(req, u));
}));

app.post('/api/login/resend', wrap(async (req, res) => {
  const p = req.session.pending;
  if (!p) return res.status(400).json({ error: 'No login in progress. Please sign in again.' });
  const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - p.sentAt)) / 1000);
  if (wait > 0) return res.status(429).json({ error: `Please wait ${wait} second(s) before requesting another code.` });
  const u = userById(p.userId);
  if (!u) return res.status(400).json({ error: 'Please sign in again.' });
  return sendOtp(req, res, u);
}));

// Employee turns "SMS code at login" on/off for their own account (in 'optional' mode)
app.put('/api/profile/otp', requireAuth, wrap((req, res) => {
  const enable = !!req.body.enabled;
  if (enable) {
    const e = db.prepare('SELECT mobile FROM employees WHERE id = ?').get(req.session.user.employeeId);
    if (!e || !sms.normalizeNumber(e.mobile, sms.PROVIDER)) return res.status(400).json({ error: 'Add a valid mobile number to your profile first.' });
  }
  db.prepare('UPDATE users SET otp_enabled = ? WHERE id = ?').run(enable ? 1 : 0, req.session.user.id);
  audit(req.session.user.id, enable ? 'otp_enabled' : 'otp_disabled');
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', (req, res) => res.json(req.session.user || null));

app.post('/api/change-password', requireAuth, wrap((req, res) => {
  const { current, next } = req.body;
  if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), u.id);
  audit(u.id, 'change_password');
  res.json({ ok: true });
}));

// ---------- Lookups ----------
app.get('/api/lookups', requireAuth, (req, res) => {
  res.json({
    roles: db.prepare('SELECT * FROM roles').all(),
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    leaveTypes: db.prepare('SELECT * FROM leave_types ORDER BY name').all(),
    smsProvider: sms.PROVIDER,
    emailProvider: email.PROVIDER,
    otpMode: OTP_MODE,
  });
});

// ---------- Employees ----------
app.get('/api/employees', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  res.json(db.prepare(EMP_SELECT + ' ORDER BY e.last_name, e.first_name').all());
});

app.get('/api/profile', requireAuth, (req, res) => {
  const row = db.prepare(EMP_SELECT + ' WHERE e.id = ?').get(req.session.user.employeeId);
  res.json(row);
});

// Employees may edit only their own contact info
app.put('/api/profile', requireAuth, wrap((req, res) => {
  const { email: mail, mobile, sms_opt_in, email_opt_in } = req.body;
  if (db.prepare('SELECT otp_enabled FROM users WHERE id = ?').get(req.session.user.id).otp_enabled && !sms.normalizeNumber(mobile, sms.PROVIDER))
    return res.status(400).json({ error: 'A valid mobile number is needed for SMS login codes. Turn off "SMS code at login" first.' });
  db.prepare('UPDATE employees SET email = ?, mobile = ?, sms_opt_in = ?, email_opt_in = ? WHERE id = ?')
    .run(mail || null, mobile || null, sms_opt_in ? 1 : 0, email_opt_in === undefined ? 1 : (email_opt_in ? 1 : 0), req.session.user.employeeId);
  audit(req.session.user.id, 'update_profile');
  res.json({ ok: true });
}));

app.post('/api/employees', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const b = req.body;
  if (!b.username || !b.password || !b.first_name || !b.last_name || !b.employee_no)
    return res.status(400).json({ error: 'Username, password, employee no., first and last name are required.' });
  // HR Staff may not create Admin accounts
  let roleId = Number(b.role_id) || 3;
  if (req.session.user.role !== 'Admin' && roleId === 1) roleId = 3;

  const tx = db.transaction(() => {
    const u = db.prepare('INSERT INTO users (username, password_hash, role_id) VALUES (?,?,?)')
      .run(b.username.trim(), bcrypt.hashSync(b.password, 10), roleId);
    const e = db.prepare(`INSERT INTO employees (user_id, employee_no, first_name, last_name, email, mobile, department_id, position, date_hired)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(u.lastInsertRowid, b.employee_no.trim(), b.first_name.trim(), b.last_name.trim(),
      b.email || null, b.mobile || null, b.department_id || null, b.position || null, b.date_hired || null);
    db.prepare(`INSERT INTO leave_balances (employee_id, leave_type_id, year, days_allowed)
      SELECT ?, id, ?, default_days FROM leave_types`).run(e.lastInsertRowid, new Date().getFullYear());
    db.prepare('INSERT OR IGNORE INTO shift_assignments (employee_id, shift_id) SELECT ?, MIN(id) FROM shifts').run(e.lastInsertRowid);
    return e.lastInsertRowid;
  });
  const id = tx();
  audit(req.session.user.id, 'create_employee', `employee ${id}`);
  res.json({ id });
}));

app.put('/api/employees/:id', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const b = req.body, id = Number(req.params.id);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  db.prepare(`UPDATE employees SET first_name=?, last_name=?, email=?, mobile=?, department_id=?, position=?, date_hired=? WHERE id=?`)
    .run(b.first_name, b.last_name, b.email || null, b.mobile || null, b.department_id || null, b.position || null, b.date_hired || null, id);
  if (req.session.user.role === 'Admin') {
    if (b.role_id) db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(b.role_id, emp.user_id);
    if (b.is_active !== undefined) db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(b.is_active ? 1 : 0, emp.user_id);
    if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), emp.user_id);
  }
  audit(req.session.user.id, 'update_employee', `employee ${id}`);
  res.json({ ok: true });
}));

app.delete('/api/employees/:id', requireAuth, requireRole('Admin'), wrap((req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Not found.' });
  if (emp.user_id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(emp.user_id); // cascades to employee
  audit(req.session.user.id, 'delete_employee', `employee ${emp.id}`);
  res.json({ ok: true });
}));

// ---------- Leave ----------
function balancesFor(employeeId) {
  const year = new Date().getFullYear();
  return db.prepare(`
    SELECT lt.id AS leave_type_id, lt.name, COALESCE(b.days_allowed, lt.default_days) AS allowed,
      COALESCE((SELECT SUM(days) FROM leave_requests lr
                WHERE lr.employee_id = ? AND lr.leave_type_id = lt.id AND lr.status = 'Approved'
                AND strftime('%Y', lr.start_date) = ?), 0) AS used,
      COALESCE((SELECT SUM(days) FROM leave_requests lr
                WHERE lr.employee_id = ? AND lr.leave_type_id = lt.id AND lr.status = 'Pending'
                AND strftime('%Y', lr.start_date) = ?), 0) AS pending
    FROM leave_types lt
    LEFT JOIN leave_balances b ON b.leave_type_id = lt.id AND b.employee_id = ? AND b.year = ?
    ORDER BY lt.name`).all(employeeId, String(year), employeeId, String(year), employeeId, year);
}

app.get('/api/leave/balances', requireAuth, (req, res) => res.json(balancesFor(req.session.user.employeeId)));

const LEAVE_SELECT = `
  SELECT lr.*, lt.name AS leave_type, e.first_name || ' ' || e.last_name AS employee_name, e.employee_no,
         d.name AS department, rv.username AS reviewer
  FROM leave_requests lr
  JOIN leave_types lt ON lt.id = lr.leave_type_id
  JOIN employees e ON e.id = lr.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN users rv ON rv.id = lr.reviewed_by`;

// Employees see their own; staff see all (optional ?status=)
app.get('/api/leave', requireAuth, (req, res) => {
  const u = req.session.user;
  const params = [];
  let where = [];
  if (!isStaff(u) || req.query.mine === '1') { where.push('lr.employee_id = ?'); params.push(u.employeeId); }
  if (req.query.status) { where.push('lr.status = ?'); params.push(req.query.status); }
  const sql = LEAVE_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY lr.created_at DESC, lr.id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/leave', requireAuth, wrap((req, res) => {
  const { leave_type_id, start_date, end_date, reason } = req.body;
  if (!leave_type_id || !start_date || !end_date) return res.status(400).json({ error: 'Leave type and dates are required.' });
  if (end_date < start_date) return res.status(400).json({ error: 'End date cannot be before start date.' });
  const empId = req.session.user.employeeId;
  const days = businessDays(start_date, end_date);
  if (days < 1) return res.status(400).json({ error: 'Selected dates contain no working days (weekends and holidays are not counted).' });

  // overlap check against Pending/Approved requests (prevents scheduling clashes)
  const clash = db.prepare(`SELECT id FROM leave_requests WHERE employee_id = ? AND status IN ('Pending','Approved')
      AND start_date <= ? AND end_date >= ?`).get(empId, end_date, start_date);
  if (clash) return res.status(400).json({ error: 'You already have a pending/approved leave overlapping these dates.' });

  const bal = balancesFor(empId).find(b => b.leave_type_id === Number(leave_type_id));
  if (bal && bal.used + bal.pending + days > bal.allowed)
    return res.status(400).json({ error: `Insufficient balance. Remaining: ${bal.allowed - bal.used - bal.pending} day(s).` });

  const r = db.prepare(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason) VALUES (?,?,?,?,?,?)`)
    .run(empId, leave_type_id, start_date, end_date, days, reason || null);
  audit(req.session.user.id, 'file_leave', `request ${r.lastInsertRowid}`);
  res.json({ id: r.lastInsertRowid, days });
}));

app.post('/api/leave/:id/cancel', requireAuth, wrap((req, res) => {
  const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!lr || lr.employee_id !== req.session.user.employeeId) return res.status(404).json({ error: 'Request not found.' });
  if (lr.status !== 'Pending') return res.status(400).json({ error: 'Only pending requests can be cancelled.' });
  db.prepare("UPDATE leave_requests SET status = 'Cancelled' WHERE id = ?").run(lr.id);
  res.json({ ok: true });
}));

// Approve / reject -> triggers SMS
app.post('/api/leave/:id/review', requireAuth, requireRole('Admin', 'HR Staff'), wrap(async (req, res) => {
  const { decision, remarks } = req.body; // 'Approved' | 'Rejected'
  if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
  const lr = db.prepare(LEAVE_SELECT + ' WHERE lr.id = ?').get(req.params.id);
  if (!lr) return res.status(404).json({ error: 'Request not found.' });
  if (lr.status !== 'Pending') return res.status(400).json({ error: `Request is already ${lr.status}.` });
  if (lr.employee_id === req.session.user.employeeId) return res.status(400).json({ error: 'You cannot review your own leave request.' });

  db.prepare(`UPDATE leave_requests SET status=?, reviewed_by=?, review_remarks=?, reviewed_at=datetime('now') WHERE id=?`)
    .run(decision, req.session.user.id, remarks || null, lr.id);
  audit(req.session.user.id, 'review_leave', `request ${lr.id} -> ${decision}`);

  const msg = `HRIS: Your ${lr.leave_type} (${lr.start_date} to ${lr.end_date}) has been ${decision.toUpperCase()}.` +
    (remarks ? ` Remarks: ${remarks}` : '');
  const out = await notifier.notify(lr.employee_id, { subject: `Your leave request was ${decision.toLowerCase()}`, message: msg, trigger: 'leave_status' });
  res.json({ ok: true, sms: out.sms, email: out.email });
}));

// ---------- Announcements ----------
app.get('/api/announcements', requireAuth, (req, res) => {
  const u = req.session.user;
  const me = db.prepare('SELECT department_id FROM employees WHERE id = ?').get(u.employeeId);
  const rows = db.prepare(`
    SELECT a.*, d.name AS department, us.username AS author FROM announcements a
    LEFT JOIN departments d ON d.id = a.department_id
    JOIN users us ON us.id = a.created_by
    WHERE a.department_id IS NULL OR a.department_id = ? OR ? = 1
    ORDER BY a.created_at DESC, a.id DESC LIMIT 50`).all(me?.department_id ?? -1, isStaff(u) ? 1 : 0);
  res.json(rows);
});

app.post('/api/announcements', requireAuth, requireRole('Admin', 'HR Staff'), wrap(async (req, res) => {
  const { title, body, is_urgent, department_id, send_sms } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and message are required.' });
  const deptId = department_id ? Number(department_id) : null;
  const r = db.prepare('INSERT INTO announcements (title, body, is_urgent, department_id, created_by) VALUES (?,?,?,?,?)')
    .run(title, body, is_urgent ? 1 : 0, deptId, req.session.user.id);
  audit(req.session.user.id, 'create_announcement', `announcement ${r.lastInsertRowid}`);

  let result = { sms: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0 } };
  if (send_sms || is_urgent) {
    const targets = db.prepare(`SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id
      WHERE u.is_active = 1 AND (? IS NULL OR e.department_id = ?)`).all(deptId, deptId);
    const text = `${is_urgent ? 'URGENT ' : ''}HRIS Announcement: ${title} - ${body}`.slice(0, 450);
    result = await broadcast(targets, `${is_urgent ? 'URGENT: ' : ''}${title}`, text, 'announcement');
  }
  res.json({ id: r.lastInsertRowid, ...result });
}));

app.delete('/api/announcements/:id', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- SMS log & test ----------
app.get('/api/sms-log', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  res.json(db.prepare(`SELECT s.*, e.first_name || ' ' || e.last_name AS employee_name FROM sms_log s
    LEFT JOIN employees e ON e.id = s.employee_id ORDER BY s.id DESC LIMIT 200`).all());
});

app.post('/api/sms-test', requireAuth, requireRole('Admin'), wrap(async (req, res) => {
  const { mobile, message } = req.body;
  res.json(await sms.sendSMS({ mobile, message: message || 'HRIS test message.', trigger: 'test' }));
}));


// ================= Shifts, Attendance, Payroll updates, Python report =================
const { execFile } = require('child_process');
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localTime = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(new Date(d));

function shiftFor(employeeId) {
  return db.prepare(`SELECT s.* FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id WHERE sa.employee_id = ?`).get(employeeId);
}
// Late if clock-in is more than grace minutes after the shift start (handles night shifts via modulo)
function statusFor(shift, timeIn) {
  if (!shift || !timeIn) return 'Present';
  const diff = ((toMin(timeIn) - toMin(shift.start_time) + 720) % 1440 + 1440) % 1440 - 720;
  return diff > shift.grace_minutes ? 'Late' : 'Present';
}
const onApprovedLeave = (employeeId, date) =>
  !!db.prepare("SELECT 1 FROM leave_requests WHERE employee_id = ? AND status = 'Approved' AND ? BETWEEN start_date AND end_date").get(employeeId, date);

// ---------- Shifts ----------
app.get('/api/shifts', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM shift_assignments sa WHERE sa.shift_id = s.id) AS assigned FROM shifts s ORDER BY s.start_time`).all());
});
function shiftBody(b) {
  if (!b.name || !validTime(b.start_time) || !validTime(b.end_time)) throw new Error('Shift name and valid start/end times (HH:MM) are required.');
  const days = (Array.isArray(b.work_days) ? b.work_days : String(b.work_days || '').split(',')).map(Number).filter(n => n >= 0 && n <= 6);
  if (!days.length) throw new Error('Pick at least one work day.');
  const grace = Math.max(0, Math.min(120, Number(b.grace_minutes) || 0));
  return [b.name.trim(), b.start_time, b.end_time, [...new Set(days)].sort().join(','), grace];
}
app.post('/api/shifts', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const r = db.prepare('INSERT INTO shifts (name, start_time, end_time, work_days, grace_minutes) VALUES (?,?,?,?,?)').run(...shiftBody(req.body));
  audit(req.session.user.id, 'create_shift', `shift ${r.lastInsertRowid}`);
  res.json({ id: r.lastInsertRowid });
}));
app.put('/api/shifts/:id', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  db.prepare('UPDATE shifts SET name=?, start_time=?, end_time=?, work_days=?, grace_minutes=? WHERE id=?').run(...shiftBody(req.body), req.params.id);
  audit(req.session.user.id, 'update_shift', `shift ${req.params.id}`);
  res.json({ ok: true });
}));
app.delete('/api/shifts/:id', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM shift_assignments WHERE shift_id = ?').get(req.params.id).c;
  if (n) return res.status(400).json({ error: `${n} employee(s) are still assigned to this shift. Reassign them first.` });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
  audit(req.session.user.id, 'delete_shift', `shift ${req.params.id}`);
  res.json({ ok: true });
}));
app.get('/api/schedule', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  res.json(db.prepare(`SELECT e.id, e.employee_no, e.first_name || ' ' || e.last_name AS name, d.name AS department, sa.shift_id
    FROM employees e JOIN users u ON u.id = e.user_id AND u.is_active = 1
    LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN shift_assignments sa ON sa.employee_id = e.id
    ORDER BY e.last_name, e.first_name`).all());
});
app.put('/api/schedule/:employeeId', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const shiftId = Number(req.body.shift_id);
  if (!db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(shiftId)) return res.status(400).json({ error: 'Shift not found.' });
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(req.params.employeeId)) return res.status(404).json({ error: 'Employee not found.' });
  db.prepare('INSERT INTO shift_assignments (employee_id, shift_id) VALUES (?, ?) ON CONFLICT(employee_id) DO UPDATE SET shift_id = excluded.shift_id').run(req.params.employeeId, shiftId);
  audit(req.session.user.id, 'assign_shift', `employee ${req.params.employeeId} -> shift ${shiftId}`);
  res.json({ ok: true });
}));

// ---------- Attendance (employee self-service) ----------
app.get('/api/attendance/today', requireAuth, (req, res) => {
  const id = req.session.user.employeeId, today = localDate();
  const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(id, today);
  const open = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND time_out IS NULL AND time_in IS NOT NULL ORDER BY work_date DESC LIMIT 1').get(id);
  res.json({ today, now: localTime(), record: rec || null, open: open || null, shift: shiftFor(id) || null, onLeave: onApprovedLeave(id, today), holiday: db.prepare('SELECT name FROM holidays WHERE date = ?').get(today)?.name || null });
});

app.post('/api/attendance/clock-in', requireAuth, wrap((req, res) => {
  const id = req.session.user.employeeId, today = localDate(), now = localTime();
  if (onApprovedLeave(id, today)) return res.status(400).json({ error: 'You are on approved leave today.' });
  if (db.prepare('SELECT 1 FROM attendance WHERE employee_id = ? AND work_date = ?').get(id, today)) return res.status(400).json({ error: 'You already clocked in today.' });
  const open = db.prepare('SELECT work_date FROM attendance WHERE employee_id = ? AND time_out IS NULL AND time_in IS NOT NULL').get(id);
  if (open) return res.status(400).json({ error: `Please clock out first (open record from ${open.work_date}).` });
  const status = statusFor(shiftFor(id), now);
  db.prepare('INSERT INTO attendance (employee_id, work_date, time_in, status) VALUES (?,?,?,?)').run(id, today, now, status);
  audit(req.session.user.id, 'clock_in', `${today} ${now} ${status}`);
  res.json({ ok: true, time_in: now, status });
}));

app.post('/api/attendance/clock-out', requireAuth, wrap((req, res) => {
  const id = req.session.user.employeeId, now = localTime();
  const open = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND time_out IS NULL AND time_in IS NOT NULL ORDER BY work_date DESC LIMIT 1').get(id);
  if (!open) return res.status(400).json({ error: 'You have not clocked in.' });
  db.prepare('UPDATE attendance SET time_out = ? WHERE id = ?').run(now, open.id);
  audit(req.session.user.id, 'clock_out', `${open.work_date} ${now}`);
  res.json({ ok: true, time_out: now });
}));

app.get('/api/attendance/mine', requireAuth, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : localDate().slice(0, 7);
  res.json(db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND substr(work_date,1,7) = ? ORDER BY work_date DESC").all(req.session.user.employeeId, month));
});

// ---------- Attendance (HR/Admin) ----------
app.get('/api/attendance', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  const date = validDate(req.query.date) ? req.query.date : localDate();
  const dow = new Date(date + 'T00:00:00').getDay();
  const hol = db.prepare('SELECT name FROM holidays WHERE date = ?').get(date);
  const rows = db.prepare(`
    SELECT e.id AS employee_id, e.employee_no, e.first_name || ' ' || e.last_name AS name, d.name AS department,
           s.name AS shift, s.start_time, s.end_time, s.work_days, a.time_in, a.time_out, a.status AS att_status, a.remarks
    FROM employees e JOIN users u ON u.id = e.user_id AND u.is_active = 1
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN shift_assignments sa ON sa.employee_id = e.id LEFT JOIN shifts s ON s.id = sa.shift_id
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
    ORDER BY e.last_name, e.first_name`).all(date);
  const today = localDate();
  res.json({ date, holiday: hol?.name || null, rows: rows.map(r => {
    const workDays = (r.work_days || '1,2,3,4,5').split(',').map(Number);
    let status;
    if (r.time_in) status = r.att_status;
    else if (onApprovedLeave(r.employee_id, date)) status = 'On Leave';
    else if (hol) status = 'Holiday';
    else if (!workDays.includes(dow)) status = 'Day off';
    else status = date > today ? 'Scheduled' : date === today ? 'Not yet in' : 'Absent';
    return { ...r, status };
  }) });
});

// HR/Admin can add or correct a record (e.g. forgot to clock out)
app.put('/api/attendance', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const { employee_id, work_date, time_in, time_out, remarks } = req.body;
  if (!employee_id || !validDate(work_date) || !validTime(time_in)) return res.status(400).json({ error: 'Employee, date and a valid time-in are required.' });
  if (time_out && !validTime(time_out)) return res.status(400).json({ error: 'Invalid time-out.' });
  const status = statusFor(shiftFor(employee_id), time_in);
  db.prepare(`INSERT INTO attendance (employee_id, work_date, time_in, time_out, status, remarks) VALUES (?,?,?,?,?,?)
    ON CONFLICT(employee_id, work_date) DO UPDATE SET time_in = excluded.time_in, time_out = excluded.time_out, status = excluded.status, remarks = excluded.remarks`)
    .run(employee_id, work_date, time_in, time_out || null, status, remarks || null);
  audit(req.session.user.id, 'edit_attendance', `employee ${employee_id} ${work_date}`);
  res.json({ ok: true, status });
}));

// ---------- Payroll processing updates (status notices only: no amounts, no money handling) ----------
app.get('/api/payroll', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT p.*, u.username AS author FROM payroll_updates p JOIN users u ON u.id = p.created_by ORDER BY p.id DESC LIMIT 30`).all());
});
app.post('/api/payroll', requireAuth, requireRole('Admin', 'HR Staff'), wrap(async (req, res) => {
  const { period_label, pay_date, status, note, send_sms } = req.body;
  if (!period_label || !['Processing', 'Released', 'Delayed'].includes(status)) return res.status(400).json({ error: 'Pay period and a valid status are required.' });
  if (pay_date && !validDate(pay_date)) return res.status(400).json({ error: 'Invalid pay date.' });
  const r = db.prepare('INSERT INTO payroll_updates (period_label, pay_date, status, note, created_by) VALUES (?,?,?,?,?)')
    .run(period_label.trim(), pay_date || null, status, note || null, req.session.user.id);
  audit(req.session.user.id, 'payroll_update', `${period_label} -> ${status}`);
  let result = { sms: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0 } };
  if (send_sms) {
    const targets = db.prepare(`SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id WHERE u.is_active = 1`).all();
    const text = `HRIS Payroll: ${period_label} is ${status.toUpperCase()}.` + (pay_date ? ` Pay date: ${pay_date}.` : '') + (note ? ` ${note}` : '');
    result = await broadcast(targets, `Payroll update: ${period_label} (${status})`, text.slice(0, 450), 'payroll');
  }
  res.json({ id: r.lastInsertRowid, ...result });
}));
app.delete('/api/payroll/:id', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  db.prepare('DELETE FROM payroll_updates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Holidays (external API: Nager.Date) ----------
app.get('/api/holidays', requireAuth, (req, res) => {
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
  res.json({ year: Number(year), country: holidays.COUNTRY, api: holidays.API,
    rows: db.prepare("SELECT * FROM holidays WHERE substr(date,1,4) = ? ORDER BY date").all(year) });
});
app.post('/api/holidays/sync', requireAuth, requireRole('Admin', 'HR Staff'), wrap(async (req, res) => {
  const year = Number(req.body.year) || new Date().getFullYear();
  if (year < 2000 || year > 2100) return res.status(400).json({ error: 'Invalid year.' });
  const r = await holidays.syncYear(year);
  audit(req.session.user.id, 'sync_holidays', `${year}: ${r.source || 'failed'}`);
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(r);
}));
app.post('/api/holidays', requireAuth, requireRole('Admin', 'HR Staff'), wrap((req, res) => {
  const { date, name } = req.body;
  if (!validDate(date) || !name) return res.status(400).json({ error: 'Date and holiday name are required.' });
  db.prepare("INSERT INTO holidays (date, name, source) VALUES (?,?, 'manual') ON CONFLICT(date) DO UPDATE SET name = excluded.name, source = 'manual'").run(date, name.trim());
  audit(req.session.user.id, 'add_holiday', `${date} ${name}`);
  res.json({ ok: true });
}));
app.delete('/api/holidays/:id', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  db.prepare('DELETE FROM holidays WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Email log & test ----------
app.get('/api/email-log', requireAuth, requireRole('Admin', 'HR Staff'), (req, res) => {
  res.json(db.prepare(`SELECT m.*, e.first_name || ' ' || e.last_name AS employee_name FROM email_log m
    LEFT JOIN employees e ON e.id = m.employee_id ORDER BY m.id DESC LIMIT 200`).all());
});
app.post('/api/email-test', requireAuth, requireRole('Admin'), wrap(async (req, res) => {
  res.json(await email.sendEmail({ to: req.body.to, subject: 'HRIS test email', text: req.body.message || 'This is a test email from the HRIS.', trigger: 'test' }));
}));

// ---------- Python: reports and Excel / PDF exports ----------
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const DB_FILE = path.join(__dirname, 'hris.db');
const MIME = { csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function runPython(script, args, binary = false) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [path.join(__dirname, 'reports', script), ...args],
      { timeout: 30000, maxBuffer: 30 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        console.error('[python]', err.message, String(stderr || ''));
        if (err.code === 'ENOENT') return reject(new Error(`Python was not found (tried "${PYTHON}"). Install Python 3 or set PYTHON in .env.`));
        let msg = String(stderr || err.message).trim();
        try { msg = JSON.parse(msg).error || msg; } catch (_) { /* plain text */ }
        reject(new Error(msg.slice(0, 400)));
      });
  });
}
const sendFile = (res, buf, format, filename) => {
  res.setHeader('Content-Type', MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
};

app.get('/api/reports/attendance', requireAuth, requireRole('Admin', 'HR Staff'), wrap(async (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') ? req.query.month : localDate().slice(0, 7);
  const format = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'json';
  if (format === 'json' || format === 'csv') {
    const out = await runPython('attendance_report.py', ['--db', DB_FILE, '--month', month, '--format', format, '--today', localDate()]);
    return format === 'csv' ? sendFile(res, out, 'csv', `attendance-${month}.csv`) : res.type('json').send(out);
  }
  const buf = await runPython('export_report.py', ['attendance', '--db', DB_FILE, '--month', month, '--format', format, '--today', localDate()], true);
  sendFile(res, buf, format, `attendance-${month}.${format}`);
}));

app.get('/api/employees/export.xlsx', requireAuth, requireRole('Admin', 'HR Staff'), wrap(async (req, res) => {
  sendFile(res, await runPython('export_report.py', ['employees', '--db', DB_FILE], true), 'xlsx', 'employees.xlsx');
}));

// Printable leave request form (employee: own requests only; HR/Admin: any)
app.get('/api/leave/:id/pdf', requireAuth, wrap(async (req, res) => {
  const lr = db.prepare('SELECT id, employee_id FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!lr || (!isStaff(req.session.user) && lr.employee_id !== req.session.user.employeeId)) return res.status(404).json({ error: 'Request not found.' });
  sendFile(res, await runPython('export_report.py', ['leave-form', '--db', DB_FILE, '--id', String(lr.id)], true), 'pdf', `leave-request-${lr.id}.pdf`);
}));

// ---------- Dashboard stats ----------
app.get('/api/dashboard', requireAuth, (req, res) => {
  const u = req.session.user;
  if (isStaff(u)) {
    res.json({
      employees: db.prepare('SELECT COUNT(*) c FROM users WHERE is_active = 1').get().c,
      pending: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='Pending'").get().c,
      onLeaveToday: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='Approved' AND date('now','localtime') BETWEEN start_date AND end_date").get().c,
      smsToday: db.prepare("SELECT COUNT(*) c FROM sms_log WHERE date(created_at) = date('now')").get().c,
      presentToday: db.prepare("SELECT COUNT(*) c FROM attendance WHERE work_date = ?").get(localDate()).c,
      lateToday: db.prepare("SELECT COUNT(*) c FROM attendance WHERE work_date = ? AND status = 'Late'").get(localDate()).c,
    });
  } else {
    const mine = db.prepare('SELECT status, COUNT(*) c FROM leave_requests WHERE employee_id = ? GROUP BY status').all(u.employeeId);
    res.json({ mine: Object.fromEntries(mine.map(m => [m.status, m.c])) });
  }
});

app.get('/api/audit', requireAuth, requireRole('Admin'), (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`).all());
});

const PORT = process.env.PORT || 3000;
holidays.ensureYears();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HRIS running at http://localhost:${PORT}  (SMS provider: ${sms.PROVIDER})`);
  // Show the address a phone on the same Wi-Fi can open
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) console.log(`On your phone (same Wi-Fi): http://${n.address}:${PORT}`);
});
