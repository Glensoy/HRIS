// Email module: SMTP via Nodemailer, or sandbox (default: nothing is sent, everything is logged).
const nodemailer = require('nodemailer');
const db = require('./db');

const PROVIDER = (process.env.EMAIL_PROVIDER || 'sandbox').toLowerCase();
const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'hris@localhost';

let transporter;
function getTransport() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',        // true for port 465
      ignoreTLS: process.env.SMTP_IGNORE_TLS === 'true', // only for local test servers
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  }
  return transporter;
}

const logStmt = db.prepare(`INSERT INTO email_log
  (employee_id, recipient, subject, body, provider, status, response, trigger_type) VALUES (?,?,?,?,?,?,?,?)`);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Send one email and record it in email_log. Never throws. */
async function sendEmail({ employeeId = null, to, subject, text, trigger = 'test' }) {
  if (!validEmail(to)) {
    logStmt.run(employeeId, String(to || ''), subject, text, PROVIDER, 'failed', 'Invalid email address', trigger);
    return { ok: false, error: 'Invalid email address' };
  }
  try {
    if (PROVIDER === 'smtp') {
      const info = await getTransport().sendMail({
        from: FROM, to, subject, text,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h3 style="color:#1f5eff">HRIS</h3><p>${esc(text).replace(/\n/g, '<br>')}</p><hr><p style="color:#888;font-size:12px">Automated message from the HR Information System.</p></div>`,
      });
      logStmt.run(employeeId, to, subject, text, 'smtp', 'sent', String(info.response || info.messageId).slice(0, 500), trigger);
    } else {
      logStmt.run(employeeId, to, subject, text, 'sandbox', 'sandbox', 'Sandbox mode: email not actually sent', trigger);
      console.log(`[Email sandbox] -> ${to}: ${subject}`);
    }
    return { ok: true };
  } catch (err) {
    logStmt.run(employeeId, to, subject, text, PROVIDER, 'failed', String(err.message).slice(0, 500), trigger);
    console.error('[Email error]', err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyEmployee(employeeId, subject, text, trigger) {
  const emp = db.prepare('SELECT id, email, email_opt_in FROM employees WHERE id = ?').get(employeeId);
  if (!emp || !emp.email_opt_in || !emp.email) return { ok: false, error: 'No email / opted out' };
  return sendEmail({ employeeId: emp.id, to: emp.email, subject, text, trigger });
}

module.exports = { sendEmail, notifyEmployee, PROVIDER };
