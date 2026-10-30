const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'hris.db');

if (process.argv.includes('--reset') && fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Normalized relational schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL            -- Admin | HR Staff | Employee
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_no TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  mobile TEXT,                          -- e.g. 09171234567 or +639171234567
  department_id INTEGER REFERENCES departments(id),
  position TEXT,
  date_hired TEXT,
  sms_opt_in INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  default_days INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  days_allowed INTEGER NOT NULL,
  UNIQUE(employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Cancelled')),
  reviewed_by INTEGER REFERENCES users(id),
  review_remarks TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_urgent INTEGER NOT NULL DEFAULT 0,
  department_id INTEGER REFERENCES departments(id),  -- NULL = company-wide
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  provider TEXT NOT NULL,               -- semaphore | twilio | sandbox
  status TEXT NOT NULL,                 -- sent | failed | sandbox
  response TEXT,
  trigger_type TEXT NOT NULL,           -- leave_status | announcement | test
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  start_time TEXT NOT NULL,             -- HH:MM (24h)
  end_time TEXT NOT NULL,
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',   -- 0=Sun ... 6=Sat
  grace_minutes INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS shift_assignments (
  employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,              -- YYYY-MM-DD
  time_in TEXT,                         -- HH:MM
  time_out TEXT,
  status TEXT NOT NULL DEFAULT 'Present' CHECK (status IN ('Present','Late')),
  remarks TEXT,
  UNIQUE(employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS payroll_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label TEXT NOT NULL,           -- e.g. "Nov 1-15, 2026"
  pay_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('Processing','Released','Delayed')),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE NOT NULL,            -- YYYY-MM-DD
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' -- api | fallback | manual
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,               -- smtp | sandbox
  status TEXT NOT NULL,                 -- sent | failed | sandbox
  response TEXT,
  trigger_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- Small migrations for databases created by earlier versions ----------
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'otp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('employees', 'email_opt_in', 'INTEGER NOT NULL DEFAULT 1');

// ---------- Seed ----------
function seed() {
  const hasRoles = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
  if (hasRoles) return;

  const insRole = db.prepare('INSERT INTO roles (id, name) VALUES (?, ?)');
  insRole.run(1, 'Admin'); insRole.run(2, 'HR Staff'); insRole.run(3, 'Employee');

  const insDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
  ['Human Resources', 'Information Technology', 'Operations', 'Finance', 'Sales'].forEach(d => insDept.run(d));

  const insLT = db.prepare('INSERT INTO leave_types (name, default_days) VALUES (?, ?)');
  [['Vacation Leave', 15], ['Sick Leave', 10], ['Emergency Leave', 5], ['Maternity/Paternity Leave', 7]]
    .forEach(([n, d]) => insLT.run(n, d));

  const insUser = db.prepare('INSERT INTO users (username, password_hash, role_id) VALUES (?, ?, ?)');
  const insEmp = db.prepare(`INSERT INTO employees
    (user_id, employee_no, first_name, last_name, email, mobile, department_id, position, date_hired)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const year = new Date().getFullYear();
  const insBal = db.prepare(`INSERT INTO leave_balances (employee_id, leave_type_id, year, days_allowed)
    SELECT ?, id, ?, default_days FROM leave_types`);

  const people = [
    ['admin',  'admin123',  1, 'EMP-0001', 'System',  'Admin',    'admin@company.ph',  '09170000001', 1, 'System Administrator', '2022-01-10'],
    ['hr',     'hr123',     2, 'EMP-0002', 'Maria',   'Santos',   'maria@company.ph',  '09170000002', 1, 'HR Officer',           '2022-03-14'],
    ['juan',   'emp123',    3, 'EMP-0003', 'Juan',    'Dela Cruz','juan@company.ph',   '09170000003', 2, 'Software Developer',   '2023-06-01'],
    ['ana',    'emp123',    3, 'EMP-0004', 'Ana',     'Reyes',    'ana@company.ph',    '09170000004', 3, 'Operations Associate', '2023-08-21'],
  ];
  for (const p of people) {
    const u = insUser.run(p[0], bcrypt.hashSync(p[1], 10), p[2]);
    const e = insEmp.run(u.lastInsertRowid, p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10]);
    insBal.run(e.lastInsertRowid, year);
  }
  console.log('Seeded database with default roles, departments, leave types and demo accounts.');
}
seed();

// Extra seed (safe on an existing database): default shifts, assigned to everyone without one
function seedShifts() {
  if (!db.prepare('SELECT COUNT(*) c FROM shifts').get().c) {
    const ins = db.prepare('INSERT INTO shifts (name, start_time, end_time, work_days, grace_minutes) VALUES (?,?,?,?,?)');
    ins.run('Day Shift', '08:00', '17:00', '1,2,3,4,5', 10);
    ins.run('Mid Shift', '10:00', '19:00', '1,2,3,4,5', 10);
    ins.run('Night Shift', '22:00', '06:00', '1,2,3,4,5', 10);
  }
  db.prepare(`INSERT OR IGNORE INTO shift_assignments (employee_id, shift_id)
    SELECT e.id, (SELECT id FROM shifts ORDER BY id LIMIT 1) FROM employees e`).run();
}
seedShifts();

module.exports = db;
