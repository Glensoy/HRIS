require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const sms = require('./sms');

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
  // inclusive count of weekdays
  let d = new Date(start), e = new Date(end), n = 0;
  while (d <= e) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
  return n;
}

const EMP_SELECT = `
  SELECT e.*, u.username, u.is_active, r.name AS role, d.name AS department
  FROM employees e
  JOIN users u ON u.id = e.user_id
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = e.department_id`;

// ---------- Auth ----------
app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body;
  const u = db.prepare(`SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE username = ?`).get(username || '');
  if (!u || !u.is_active || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password.' });
  const emp = db.prepare('SELECT id, first_name, last_name FROM employees WHERE user_id = ?').get(u.id);
  req.session.user = { id: u.id, username: u.username, role: u.role, employeeId: emp?.id, name: emp ? `${emp.first_name} ${emp.last_name}` : u.username };
  audit(u.id, 'login');
  res.json(req.session.user);
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
  const { email, mobile, sms_opt_in } = req.body;
  db.prepare('UPDATE employees SET email = ?, mobile = ?, sms_opt_in = ? WHERE id = ?')
    .run(email || null, mobile || null, sms_opt_in ? 1 : 0, req.session.user.employeeId);
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
  if (days < 1) return res.status(400).json({ error: 'Selected dates contain no working days.' });

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
  const smsResult = await sms.notifyEmployee(lr.employee_id, msg, 'leave_status');
  res.json({ ok: true, sms: smsResult });
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

  let sent = 0, failed = 0;
  if (send_sms || is_urgent) {
    const targets = db.prepare(`SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id
      WHERE u.is_active = 1 AND e.sms_opt_in = 1 AND e.mobile IS NOT NULL AND (? IS NULL OR e.department_id = ?)`).all(deptId, deptId);
    const text = `${is_urgent ? 'URGENT ' : ''}HRIS Announcement: ${title} - ${body}`.slice(0, 450);
    // sequential to respect free-tier rate limits
    for (const t of targets) {
      const out = await sms.notifyEmployee(t.id, text, 'announcement');
      out.ok ? sent++ : failed++;
    }
  }
  res.json({ id: r.lastInsertRowid, sms: { sent, failed } });
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

// ---------- Dashboard stats ----------
app.get('/api/dashboard', requireAuth, (req, res) => {
  const u = req.session.user;
  if (isStaff(u)) {
    res.json({
      employees: db.prepare('SELECT COUNT(*) c FROM users WHERE is_active = 1').get().c,
      pending: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='Pending'").get().c,
      onLeaveToday: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='Approved' AND date('now','localtime') BETWEEN start_date AND end_date").get().c,
      smsToday: db.prepare("SELECT COUNT(*) c FROM sms_log WHERE date(created_at) = date('now')").get().c,
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HRIS running at http://localhost:${PORT}  (SMS provider: ${sms.PROVIDER})`);
  // Show the address a phone on the same Wi-Fi can open
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) console.log(`On your phone (same Wi-Fi): http://${n.address}:${PORT}`);
});
