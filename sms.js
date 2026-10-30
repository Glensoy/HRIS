// SMS module: Semaphore (PH) / Twilio (global) / Sandbox (default, no real sending)
const db = require('./db');

const PROVIDER = (process.env.SMS_PROVIDER || 'sandbox').toLowerCase();

// Normalize PH numbers to international format (+639XXXXXXXXX)
function normalizeNumber(num, forProvider) {
  if (!num) return null;
  let n = String(num).replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  if (n.startsWith('09')) n = '63' + n.slice(1);
  else if (n.startsWith('9') && n.length === 10) n = '63' + n;
  if (!/^\d{10,15}$/.test(n)) return null;
  return forProvider === 'twilio' ? '+' + n : n.startsWith('63') ? '0' + n.slice(2) : n; // Semaphore accepts 09XXXXXXXXX
}

async function sendViaSemaphore(to, message) {
  const body = new URLSearchParams({
    apikey: process.env.SEMAPHORE_API_KEY || '',
    number: to,
    message,
  });
  if (process.env.SEMAPHORE_SENDER_NAME) body.set('sendername', process.env.SEMAPHORE_SENDER_NAME);
  const res = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Semaphore ${res.status}: ${text}`);
  return text;
}

async function sendViaTwilio(to, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  const body = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER || '', Body: message });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${text}`);
  return text;
}

const logStmt = db.prepare(`INSERT INTO sms_log
  (employee_id, recipient, message, provider, status, response, trigger_type) VALUES (?,?,?,?,?,?,?)`);

/**
 * Send an SMS and record it in sms_log. Never throws – failures are logged.
 */
async function sendSMS({ employeeId = null, mobile, message, trigger = 'test', logMessage }) {
  const shown = logMessage || message; // what gets stored in sms_log (OTP codes are hidden)
  const to = normalizeNumber(mobile, PROVIDER);
  if (!to) {
    logStmt.run(employeeId, String(mobile || ''), shown, PROVIDER, 'failed', 'Invalid mobile number', trigger);
    return { ok: false, error: 'Invalid mobile number' };
  }
  try {
    if (PROVIDER === 'semaphore') {
      const r = await sendViaSemaphore(to, message);
      logStmt.run(employeeId, to, shown, 'semaphore', 'sent', r.slice(0, 500), trigger);
    } else if (PROVIDER === 'twilio') {
      const r = await sendViaTwilio(to, message);
      logStmt.run(employeeId, to, shown, 'twilio', 'sent', r.slice(0, 500), trigger);
    } else {
      logStmt.run(employeeId, to, shown, 'sandbox', 'sandbox', 'Sandbox mode: message not actually sent', trigger);
      console.log(`[SMS sandbox] -> ${to}: ${message}`);
    }
    return { ok: true };
  } catch (err) {
    logStmt.run(employeeId, to, shown, PROVIDER, 'failed', String(err.message).slice(0, 500), trigger);
    console.error('[SMS error]', err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyEmployee(employeeId, message, trigger) {
  const emp = db.prepare('SELECT id, mobile, sms_opt_in FROM employees WHERE id = ?').get(employeeId);
  if (!emp || !emp.sms_opt_in || !emp.mobile) return { ok: false, error: 'No mobile / opted out' };
  return sendSMS({ employeeId: emp.id, mobile: emp.mobile, message, trigger });
}

module.exports = { sendSMS, notifyEmployee, normalizeNumber, PROVIDER };
