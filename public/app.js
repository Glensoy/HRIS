// ---------- tiny helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function openModal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

const badge = (s) => `<span class="badge b-${esc(String(s).replace(/\s+/g, "-"))}">${esc(s)}</span>`;
const fmtDate = (d) => d ? new Date(d.length <= 10 ? d + 'T00:00:00' : d.replace(' ', 'T') + 'Z').toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtDT = (d) => d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString('en-PH') : '';
const opts = (arr, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') +
  arr.map(o => `<option value="${o.id}" ${String(o.id) === String(sel) ? 'selected' : ''}>${esc(o.name)}</option>`).join('');

// ---------- state ----------
let me = null, lookups = null, page = 'dashboard';
const isStaff = () => me && (me.role === 'Admin' || me.role === 'HR Staff');

const PAGES = {
  dashboard: { label: 'Dashboard', render: renderDashboard },
  leave: { label: 'My Leave', render: renderMyLeave },
  approvals: { label: 'Leave Approvals', staff: true, render: renderApprovals },
  myattendance: { label: 'My Attendance', render: renderMyAttendance },
  attendance: { label: 'Attendance', staff: true, render: renderAttendanceAdmin },
  shifts: { label: 'Shifts & Schedule', staff: true, render: renderShifts },
  payroll: { label: 'Payroll Updates', render: renderPayroll },
  reports: { label: 'Reports', staff: true, render: renderReports },
  employees: { label: 'Employees', staff: true, render: renderEmployees },
  announcements: { label: 'Announcements', render: renderAnnouncements },
  smslog: { label: 'SMS Log', staff: true, render: renderSmsLog },
  emaillog: { label: 'Email Log', staff: true, render: renderEmailLog },
  holidays: { label: 'Holidays', render: renderHolidays },
  audit: { label: 'Audit Log', admin: true, render: renderAudit },
  profile: { label: 'My Profile', render: renderProfile },
};

// ---------- boot / auth ----------
async function boot() {
  me = await api('/api/me');
  if (!me) { $('#login-view').hidden = false; $('#app-view').hidden = true; return; }
  lookups = await api('/api/lookups');
  $('#login-view').hidden = true; $('#app-view').hidden = false;
  $('#who-name').textContent = me.name; $('#who-role').textContent = me.role;
  $('#nav').innerHTML = Object.entries(PAGES)
    .filter(([, p]) => (!p.staff || isStaff()) && (!p.admin || me.role === 'Admin'))
    .map(([k, p]) => `<button data-p="${k}">${p.label}</button>`).join('');
  go('dashboard');
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { go(b.dataset.p); setMenu(false); } });
function setMenu(open) {
  $('#nav').classList.toggle('open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').addEventListener('click', () => setMenu(!$('#nav').classList.contains('open')));

// Mobile: label every table cell with its column header so rows can display as cards
function labelTables() {
  document.querySelectorAll('table.t').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(h => h.textContent.trim());
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
      // keep multi-line cells (e.g. name + email) together as one block in card layout
      if (!td.classList.contains('actions') && td.childNodes.length > 1 && !td.querySelector(':scope > .cv')) {
        const w = document.createElement('span'); w.className = 'cv';
        while (td.firstChild) w.appendChild(td.firstChild);
        td.appendChild(w);
      }
    }));
  });
}
new MutationObserver(labelTables).observe(document.getElementById('main'), { childList: true, subtree: true });
function go(p) {
  page = p; clearInterval(clockTimer);
  document.querySelector('.sidebar').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); window.scrollTo(0, 0);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.p === p));
  guard(PAGES[p].render)();
}
const main = () => $('#main');

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/login', 'POST', { username: f.get('username'), password: f.get('password') });
    $('#login-error').textContent = '';
    if (r.otpRequired) return showOtp(r);
    e.target.reset(); boot();
  } catch (err) { $('#login-error').textContent = err.message; }
});

// ---------- SMS code (OTP) step ----------
function showOtp(r) {
  $('#login-form').hidden = true; $('#otp-form').hidden = false;
  $('#otp-info').textContent = `We sent a 6-digit code by SMS to ${r.mobile}. It expires in ${Math.round(r.expiresInSeconds / 60)} minutes.`;
  $('#otp-dev').innerHTML = r.devCode ? `Sandbox mode: no real SMS is sent, so your code is <b>${esc(r.devCode)}</b>.` : '';
  $('#otp-error').textContent = ''; const i = $('#otp-form input'); i.value = ''; i.focus();
}
function backToLogin() { $('#otp-form').hidden = true; $('#login-form').hidden = false; $('#login-form').reset(); }
$('#otp-back').onclick = backToLogin;
$('#otp-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/login/verify', 'POST', { code: new FormData(e.target).get('code') }); backToLogin(); boot(); }
  catch (err) { $('#otp-error').textContent = err.message; }
});
$('#otp-resend').onclick = async () => {
  try { showOtp(await api('/api/login/resend', 'POST')); } catch (err) { $('#otp-error').textContent = err.message; }
};
$('#logout').addEventListener('click', async () => { await api('/api/logout', 'POST'); boot(); });

// ---------- Dashboard ----------
async function renderDashboard() {
  const [d, ann, pay] = await Promise.all([api('/api/dashboard'), api('/api/announcements'), api('/api/payroll')]);
  let stats;
  if (isStaff()) {
    stats = [['Active employees', d.employees], ['Pending leave requests', d.pending], ['On leave today', d.onLeaveToday], ['Present today', d.presentToday], ['Late today', d.lateToday], ['SMS sent today', d.smsToday]];
  } else {
    stats = [['Pending', d.mine.Pending || 0], ['Approved', d.mine.Approved || 0], ['Rejected', d.mine.Rejected || 0]];
  }
  main().innerHTML = `
    <div class="page-head"><h2>Welcome, ${esc(me.name.split(' ')[0])}</h2>
      <span class="muted small">SMS provider: <b>${esc(lookups.smsProvider)}</b>${lookups.smsProvider === 'sandbox' ? ' (logged, not sent)' : ''} &middot; Email: <b>${esc(lookups.emailProvider)}</b></span></div>
    <div class="grid stats">${stats.map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
    ${pay[0] ? `<div class="card" style="margin-bottom:14px"><h3>Payroll update</h3><b>${esc(pay[0].period_label)}</b> ${badge(pay[0].status)}${pay[0].pay_date ? ' <span class="muted small">Pay date ' + fmtDate(pay[0].pay_date) + '</span>' : ''}${pay[0].note ? '<p>' + esc(pay[0].note) + '</p>' : ''}</div>` : ''}
    <div class="card"><h3>Latest announcements</h3>${annList(ann.slice(0, 3), false) || '<p class="muted">Nothing posted yet.</p>'}</div>`;
}

// ---------- Leave (employee) ----------
async function renderMyLeave() {
  const [bal, list] = await Promise.all([api('/api/leave/balances'), api('/api/leave?mine=1')]);
  main().innerHTML = `
    <div class="page-head"><h2>My Leave</h2><button class="btn primary" id="file-leave">+ File leave request</button></div>
    <div class="grid two">
      <div class="card"><h3>Balances (${new Date().getFullYear()})</h3>
        ${bal.map(b => `<div class="bal"><div style="display:flex;justify-content:space-between"><span>${esc(b.name)}</span>
          <span class="muted small">${b.allowed - b.used - b.pending} of ${b.allowed} left</span></div>
          <div class="bar"><i class="used" style="width:${b.used / b.allowed * 100}%"></i><i class="pend" style="width:${b.pending / b.allowed * 100}%"></i></div></div>`).join('')}
        <p class="muted small">Blue = used · Amber = pending approval</p></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>My requests</h3>${leaveTable(list, false)}</div>`;
  $('#file-leave').onclick = fileLeaveModal;
  main().querySelectorAll('[data-cancel]').forEach(b => b.onclick = guard(async () => {
    if (!confirm('Cancel this request?')) return;
    await api(`/api/leave/${b.dataset.cancel}/cancel`, 'POST'); toast('Request cancelled.'); renderMyLeave();
  }));
}
function leaveTable(rows, review) {
  if (!rows.length) return '<p class="muted">No requests.</p>';
  return `<div class="table-wrap"><table class="t"><thead><tr>${review ? '<th>Employee</th>' : ''}<th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr>${review ? `<td>${esc(r.employee_name)}<div class="muted small">${esc(r.department || '')}</div></td>` : ''}
      <td>${esc(r.leave_type)}</td><td>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</td><td>${r.days}</td>
      <td>${esc(r.reason || '')}${r.review_remarks ? `<div class="muted small">HR: ${esc(r.review_remarks)}</div>` : ''}</td>
      <td>${badge(r.status)}</td>
      <td class="actions">${r.status === 'Pending' ? (review
        ? (r.employee_id === me.employeeId
          ? '<span class="muted small">Your own request &ndash; another reviewer must decide</span>'
          : `<button class="btn small ok" data-review="${r.id}" data-d="Approved">Approve</button><button class="btn small bad" data-review="${r.id}" data-d="Rejected">Reject</button>`)
        : `<button class="btn small" data-cancel="${r.id}">Cancel</button>`) : ''}<a class="btn small" href="/api/leave/${r.id}/pdf" target="_blank" rel="noopener">PDF</a></td></tr>`).join('')}
    </tbody></table></div>`;
}
function fileLeaveModal() {
  const today = new Date().toISOString().slice(0, 10);
  openModal('File leave request', `<form id="lf" class="form-grid">
    <label class="full">Leave type<select name="leave_type_id" required>${opts(lookups.leaveTypes)}</select></label>
    <label>Start date<input type="date" name="start_date" min="${today}" required></label>
    <label>End date<input type="date" name="end_date" min="${today}" required></label>
    <label class="full">Reason<textarea name="reason" rows="3"></textarea></label>
    <p class="muted small full">Weekends are not counted. You will receive an SMS when HR approves or rejects the request.</p>
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Close</button><button class="btn primary">Submit</button></div></form>`);
  $('#lf').onsubmit = guard(async e => {
    e.preventDefault();
    const r = await api('/api/leave', 'POST', Object.fromEntries(new FormData(e.target)));
    closeModal(); toast(`Request filed (${r.days} working day/s).`); renderMyLeave();
  });
}

// ---------- Approvals (staff) ----------
async function renderApprovals() {
  const rows = await api('/api/leave');
  const pending = rows.filter(r => r.status === 'Pending'), done = rows.filter(r => r.status !== 'Pending');
  main().innerHTML = `<div class="page-head"><h2>Leave Approvals</h2></div>
    <div class="card"><h3>Pending (${pending.length})</h3>${leaveTable(pending, true)}</div>
    <div class="card" style="margin-top:14px"><h3>History</h3>${leaveTable(done, true)}</div>`;
  main().querySelectorAll('[data-review]').forEach(b => b.onclick = () => reviewModal(b.dataset.review, b.dataset.d));
}
function reviewModal(id, decision) {
  openModal(`${decision === 'Approved' ? 'Approve' : 'Reject'} request`, `<form id="rf">
    <label>Remarks (included in the SMS, optional)<textarea name="remarks" rows="3"></textarea></label>
    <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">Cancel</button>
    <button class="btn ${decision === 'Approved' ? 'ok' : 'bad'}">${decision === 'Approved' ? 'Approve' : 'Reject'} &amp; notify</button></div></form>`);
  $('#rf').onsubmit = guard(async e => {
    e.preventDefault();
    const r = await api(`/api/leave/${id}/review`, 'POST', { decision, remarks: new FormData(e.target).get('remarks') });
    const ch = [r.sms?.ok && 'SMS', r.email?.ok && 'email'].filter(Boolean);
    closeModal(); toast(ch.length ? `Decision saved. Employee notified by ${ch.join(' and ')}.` : `Decision saved. No notification sent (${r.sms?.error || r.email?.error || 'n/a'}).`, !ch.length); renderApprovals();
  });
}

// ---------- Employees (staff) ----------
async function renderEmployees() {
  const rows = await api('/api/employees');
  main().innerHTML = `<div class="page-head"><h2>Employees</h2><div class="actions"><a class="btn" href="/api/employees/export.xlsx">Export Excel</a><button class="btn primary" id="add-emp">+ Add employee</button></div></div>
    <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>No.</th><th>Name</th><th>Department</th><th>Position</th><th>Mobile</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map(e => `<tr><td>${esc(e.employee_no)}</td><td>${esc(e.first_name)} ${esc(e.last_name)}<div class="muted small">${esc(e.email || '')}</div></td>
      <td>${esc(e.department || '')}</td><td>${esc(e.position || '')}</td><td>${esc(e.mobile || '')}</td><td>${esc(e.role)}</td>
      <td>${e.is_active ? '<span class="badge b-Approved">Active</span>' : '<span class="badge b-Cancelled">Inactive</span>'}</td>
      <td class="actions"><button class="btn small" data-edit="${e.id}">Edit</button>${me.role === 'Admin' && e.user_id !== me.id ? `<button class="btn small bad" data-del="${e.id}">Delete</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#add-emp').onclick = () => empModal();
  main().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => empModal(rows.find(r => r.id == b.dataset.edit)));
  main().querySelectorAll('[data-del]').forEach(b => b.onclick = guard(async () => {
    if (!confirm('Permanently delete this employee and all their records?')) return;
    await api(`/api/employees/${b.dataset.del}`, 'DELETE'); toast('Employee deleted.'); renderEmployees();
  }));
}
function empModal(e) {
  const isNew = !e, admin = me.role === 'Admin';
  const roles = admin ? lookups.roles : lookups.roles.filter(r => r.name !== 'Admin');
  openModal(isNew ? 'Add employee' : 'Edit employee', `<form id="ef" class="form-grid">
    ${isNew ? `<label>Employee no.<input name="employee_no" placeholder="EMP-0005" required></label><label>Username<input name="username" required></label>
      <label>Temporary password<input name="password" type="password" minlength="6" required></label>` : ''}
    <label>First name<input name="first_name" value="${esc(e?.first_name)}" required></label>
    <label>Last name<input name="last_name" value="${esc(e?.last_name)}" required></label>
    <label>Email<input name="email" type="email" value="${esc(e?.email)}"></label>
    <label>Mobile (SMS)<input name="mobile" value="${esc(e?.mobile)}" placeholder="09171234567"></label>
    <label>Department<select name="department_id">${opts(lookups.departments, e?.department_id, '— none —')}</select></label>
    <label>Position<input name="position" value="${esc(e?.position)}"></label>
    <label>Date hired<input type="date" name="date_hired" value="${esc(e?.date_hired)}"></label>
    ${(isNew || admin) ? `<label>Role<select name="role_id">${opts(roles, e ? lookups.roles.find(r => r.name === e.role)?.id : 3)}</select></label>` : ''}
    ${(!isNew && admin) ? `<label>Reset password<input name="password" type="password" minlength="6" placeholder="leave blank to keep"></label>
      <label class="check"><input type="checkbox" name="is_active" ${e.is_active ? 'checked' : ''}> Account active</label>` : ''}
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Save</button></div></form>`);
  $('#ef').onsubmit = guard(async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target), body = Object.fromEntries(fd);
    if (!isNew && admin) body.is_active = fd.has('is_active');
    if (!body.password) delete body.password;
    await api(isNew ? '/api/employees' : `/api/employees/${e.id}`, isNew ? 'POST' : 'PUT', body);
    closeModal(); toast('Saved.'); renderEmployees();
  });
}

// ---------- Announcements ----------
function annList(rows, canDelete) {
  return rows.map(a => `<div class="ann ${a.is_urgent ? 'urgent' : ''}">
    <h3>${a.is_urgent ? '<span class="badge b-urgent">URGENT</span> ' : ''}${esc(a.title)}</h3>
    <div class="muted small">${fmtDT(a.created_at)} · ${esc(a.author)} · ${esc(a.department || 'Company-wide')}</div>
    <p>${esc(a.body).replace(/\n/g, '<br>')}</p>
    ${canDelete ? `<button class="btn small" data-delann="${a.id}">Delete</button>` : ''}</div>`).join('');
}
async function renderAnnouncements() {
  const rows = await api('/api/announcements');
  main().innerHTML = `<div class="page-head"><h2>Announcements</h2>${isStaff() ? '<button class="btn primary" id="new-ann">+ New announcement</button>' : ''}</div>
    <div class="card">${annList(rows, isStaff()) || '<p class="muted">No announcements.</p>'}</div>`;
  if (isStaff()) {
    $('#new-ann').onclick = annModal;
    main().querySelectorAll('[data-delann]').forEach(b => b.onclick = guard(async () => {
      if (!confirm('Delete this announcement?')) return; await api(`/api/announcements/${b.dataset.delann}`, 'DELETE'); renderAnnouncements();
    }));
  }
}
function annModal() {
  openModal('New announcement', `<form id="af" class="form-grid">
    <label class="full">Title<input name="title" required></label>
    <label class="full">Message<textarea name="body" rows="4" required></textarea></label>
    <label>Audience<select name="department_id">${opts(lookups.departments, '', 'Company-wide')}</select></label>
    <div class="full"><label class="check"><input type="checkbox" name="send_sms"> Also send by SMS and email</label>
    <label class="check"><input type="checkbox" name="is_urgent"> Mark as urgent (always sends SMS and email)</label></div>
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Publish</button></div></form>`);
  $('#af').onsubmit = guard(async e => {
    e.preventDefault();
    const fd = new FormData(e.target), body = Object.fromEntries(fd);
    body.send_sms = fd.has('send_sms'); body.is_urgent = fd.has('is_urgent');
    const r = await api('/api/announcements', 'POST', body);
    closeModal(); toast(r.sms.sent || r.sms.failed || r.email.sent || r.email.failed ? `Published. SMS: ${r.sms.sent} sent, ${r.sms.failed} failed. Email: ${r.email.sent} sent, ${r.email.failed} failed.` : 'Published.'); renderAnnouncements();
  });
}

// ---------- SMS log ----------
async function renderSmsLog() {
  const rows = await api('/api/sms-log');
  main().innerHTML = `<div class="page-head"><h2>SMS Log</h2>${me.role === 'Admin' ? '<button class="btn" id="sms-test">Send test SMS</button>' : ''}</div>
    <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>To</th><th>Message</th><th>Trigger</th><th>Provider</th><th>Status</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.employee_name || '')}<div class="muted small">${esc(r.recipient)}</div></td>
      <td>${esc(r.message)}${r.status === 'failed' ? `<div class="small" style="color:var(--bad)">${esc(r.response)}</div>` : ''}</td>
      <td>${esc(r.trigger_type)}</td><td>${esc(r.provider)}</td><td>${badge(r.status)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No messages yet.</td></tr>'}
    </tbody></table></div></div>`;
  if (me.role === 'Admin') $('#sms-test').onclick = () => {
    openModal('Send test SMS', `<form id="tf" class="form-grid"><label>Mobile number<input name="mobile" placeholder="09171234567" required></label>
      <label class="full">Message<input name="message" value="HRIS test message."></label>
      <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Send</button></div></form>`);
    $('#tf').onsubmit = guard(async e => {
      e.preventDefault(); const r = await api('/api/sms-test', 'POST', Object.fromEntries(new FormData(e.target)));
      closeModal(); toast(r.ok ? 'Test SMS processed.' : `Failed: ${r.error}`, !r.ok); renderSmsLog();
    });
  };
}

// ---------- Audit ----------
async function renderAudit() {
  const rows = await api('/api/audit');
  main().innerHTML = `<div class="page-head"><h2>Audit Log</h2></div><div class="card"><div class="table-wrap"><table class="t">
    <thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.username || '')}</td><td>${esc(r.action)}</td><td>${esc(r.detail || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------- Profile ----------
async function renderProfile() {
  const p = await api('/api/profile');
  main().innerHTML = `<div class="page-head"><h2>My Profile</h2></div>
  <div class="grid two">
    <div class="card"><h3>${esc(p.first_name)} ${esc(p.last_name)}</h3>
      <p class="muted">${esc(p.employee_no)} · ${esc(p.role)}<br>${esc(p.department || 'No department')} · ${esc(p.position || '')}<br>Hired ${fmtDate(p.date_hired) || '—'}</p>
      <form id="pf" class="grid">
        <label>Email<input name="email" type="email" value="${esc(p.email)}"></label>
        <label>Mobile number (for SMS alerts)<input name="mobile" value="${esc(p.mobile)}" placeholder="09171234567"></label>
        <label class="check"><input type="checkbox" name="sms_opt_in" ${p.sms_opt_in ? 'checked' : ''}> Receive SMS notifications</label>
        <label class="check"><input type="checkbox" name="email_opt_in" ${p.email_opt_in ? 'checked' : ''}> Receive email notifications</label>
        <div><button class="btn primary">Save contact details</button></div>
      </form></div>
    <div class="card"><h3>Change password</h3><form id="pw" class="grid">
      <label>Current password<input type="password" name="current" required></label>
      <label>New password (min. 6)<input type="password" name="next" minlength="6" required></label>
      <div><button class="btn">Update password</button></div></form></div>
    <div class="card"><h3>Login security</h3>${otpCard(p)}</div>
  </div>`;
  const tg = $('#otp-toggle');
  if (tg) tg.onchange = async () => {
    try { await api('/api/profile/otp', 'PUT', { enabled: tg.checked }); toast(tg.checked ? 'SMS code at login is ON.' : 'SMS code at login is OFF.'); }
    catch (err) { tg.checked = !tg.checked; toast(err.message, true); }
  };
  $('#pf').onsubmit = guard(async e => {
    e.preventDefault(); const fd = new FormData(e.target), b = Object.fromEntries(fd); b.sms_opt_in = fd.has('sms_opt_in'); b.email_opt_in = fd.has('email_opt_in');
    await api('/api/profile', 'PUT', b); toast('Profile updated.');
  });
  $('#pw').onsubmit = guard(async e => {
    e.preventDefault(); await api('/api/change-password', 'POST', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Password changed.');
  });
}

boot();

// ---------- mobile: menu toggle + table cards ----------
$('#menu-btn').addEventListener('click', () => {
  const open = $('.sidebar').classList.toggle('open');
  $('#menu-btn').setAttribute('aria-expanded', open);
});
function labelTables() {
  document.querySelectorAll('table.t').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (heads[i] === undefined) return;
      td.dataset.label = heads[i];
      // group multi-part cells (name + sub-line) into one block so the mobile card layout keeps them together
      if (!td.classList.contains('actions') && td.childNodes.length > 1 && !td.querySelector(':scope > .cv')) {
        const span = document.createElement('span'); span.className = 'cv';
        while (td.firstChild) span.appendChild(td.firstChild);
        td.appendChild(span);
      }
    }));
  });
}
new MutationObserver(labelTables).observe($('#main'), { childList: true, subtree: true });
if ('serviceWorker' in navigator) { /* reserved for offline support */ }

// =====================================================================
// Attendance, Shifts, Payroll updates, Reports (Python)
// =====================================================================
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const dayLocal = (d = new Date()) => `${ymLocal(d)}-${String(d.getDate()).padStart(2, '0')}`;
const hoursBetween = (a, b) => {
  if (!a || !b) return '';
  const m = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  let diff = m(b) - m(a); if (diff < 0) diff += 1440;
  return (diff / 60).toFixed(1);
};
const dayNames = (csv) => csv.split(',').map(n => DAYS[+n]).join(' ');
let clockTimer = null, attMonth = ymLocal();

// ---------- My Attendance (clock in / out) ----------
async function renderMyAttendance() {
  const [t, rows] = await Promise.all([api('/api/attendance/today'), api('/api/attendance/mine?month=' + attMonth)]);
  const canIn = !t.record && !t.open && !t.onLeave, canOut = !!t.open;
  let msg = '';
  if (t.onLeave) msg = 'You are on approved leave today.';
  else if (t.open) msg = `Clocked in at <b>${esc(t.open.time_in)}</b>${t.open.status === 'Late' ? ' (late)' : ''}. Don\'t forget to clock out.`;
  else if (t.record && t.record.time_out) msg = `Done for today: ${esc(t.record.time_in)} to ${esc(t.record.time_out)}.`;
  main().innerHTML = `
    <div class="page-head"><h2>My Attendance</h2></div>
    <div class="card clock-card">
      <div id="clock" class="clock"></div>
      <div class="muted">${new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
      <p>${t.shift ? `Shift: <b>${esc(t.shift.name)}</b> ${esc(t.shift.start_time)}&ndash;${esc(t.shift.end_time)} &middot; ${dayNames(t.shift.work_days)}` : '<span class="muted">No shift assigned yet.</span>'}</p>
      ${t.holiday ? `<p><span class="badge b-Holiday">Holiday: ${esc(t.holiday)}</span> <span class="muted small">Clocking in is still allowed (holiday work).</span></p>` : ''}
      <p>${msg}</p>
      <div class="actions" style="justify-content:center">
        <button class="btn ok" id="clock-in" ${canIn ? '' : 'disabled'}>Clock in</button>
        <button class="btn bad" id="clock-out" ${canOut ? '' : 'disabled'}>Clock out</button>
      </div>
      <p class="muted small">Times are recorded by the server when you press the button.</p>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="page-head"><h3 style="margin:0">My records</h3>
        <input type="month" id="att-month" value="${attMonth}" style="max-width:180px"></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Time in</th><th>Time out</th><th>Hours</th><th>Status</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${fmtDate(r.work_date)}</td><td>${esc(r.time_in || '')}</td><td>${esc(r.time_out || '')}</td><td>${hoursBetween(r.time_in, r.time_out)}</td><td>${badge(r.status)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No records for this month.</p>'}
    </div>`;
  const tick = () => { const el = $('#clock'); if (el) el.textContent = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick(); clearInterval(clockTimer); clockTimer = setInterval(tick, 1000);
  $('#clock-in').onclick = guard(async () => { const r = await api('/api/attendance/clock-in', 'POST'); toast(`Clocked in at ${r.time_in}${r.status === 'Late' ? ' (late)' : ''}.`); renderMyAttendance(); });
  $('#clock-out').onclick = guard(async () => { const r = await api('/api/attendance/clock-out', 'POST'); toast(`Clocked out at ${r.time_out}.`); renderMyAttendance(); });
  $('#att-month').onchange = (e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { attMonth = e.target.value; guard(renderMyAttendance)(); } };
}

// ---------- Attendance (HR / Admin) ----------
let attDate = dayLocal();
async function renderAttendanceAdmin() {
  const d = await api('/api/attendance?date=' + attDate);
  const count = (s) => d.rows.filter(r => r.status === s).length;
  main().innerHTML = `
    <div class="page-head"><h2>Attendance${d.holiday ? ` <span class="badge b-Holiday">${esc(d.holiday)}</span>` : ''}</h2><input type="date" id="att-date" value="${d.date}" style="max-width:190px"></div>
    <div class="grid stats">
      ${[['Present', count('Present')], ['Late', count('Late')], ['On leave', count('On Leave')], ['Absent', count('Absent')]]
        .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}
    </div>
    <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Employee</th><th>Shift</th><th>Time in</th><th>Time out</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody>
    ${d.rows.map(r => `<tr><td>${esc(r.name)}<div class="muted small">${esc(r.department || '')}</div></td>
      <td>${esc(r.shift || '—')}${r.start_time ? `<div class="muted small">${esc(r.start_time)}&ndash;${esc(r.end_time)}</div>` : ''}</td>
      <td>${esc(r.time_in || '')}</td><td>${esc(r.time_out || '')}</td><td>${hoursBetween(r.time_in, r.time_out)}</td><td>${badge(r.status)}</td>
      <td class="actions"><button class="btn small" data-fix="${r.employee_id}">${r.time_in ? 'Edit' : 'Add'}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#att-date').onchange = (e) => { if (e.target.value) { attDate = e.target.value; guard(renderAttendanceAdmin)(); } };
  main().querySelectorAll('[data-fix]').forEach(b => b.onclick = () => attModal(d.rows.find(r => r.employee_id == b.dataset.fix), d.date));
}
function attModal(r, date) {
  openModal(`${r.time_in ? 'Edit' : 'Add'} attendance`, `<form id="atf" class="form-grid">
    <p class="full muted">${esc(r.name)} &middot; ${fmtDate(date)}</p>
    <label>Time in<input type="time" name="time_in" value="${esc(r.time_in || '')}" required></label>
    <label>Time out<input type="time" name="time_out" value="${esc(r.time_out || '')}"></label>
    <label class="full">Remarks (reason for correction)<input name="remarks" value="${esc(r.remarks || '')}"></label>
    <p class="muted small full">Late/on-time status is recalculated from the employee's shift. Corrections are saved in the Audit Log.</p>
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Save</button></div></form>`);
  $('#atf').onsubmit = guard(async e => {
    e.preventDefault();
    await api('/api/attendance', 'PUT', { employee_id: r.employee_id, work_date: date, ...Object.fromEntries(new FormData(e.target)) });
    closeModal(); toast('Attendance saved.'); renderAttendanceAdmin();
  });
}

// ---------- Shifts & schedule ----------
async function renderShifts() {
  const [shifts, sched] = await Promise.all([api('/api/shifts'), api('/api/schedule')]);
  main().innerHTML = `
    <div class="page-head"><h2>Shifts &amp; Schedule</h2><button class="btn primary" id="new-shift">+ New shift</button></div>
    <div class="card"><h3>Shifts</h3><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Hours</th><th>Work days</th><th>Grace</th><th>Assigned</th><th></th></tr></thead><tbody>
    ${shifts.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.start_time)}&ndash;${esc(s.end_time)}</td><td>${dayNames(s.work_days)}</td><td>${s.grace_minutes} min</td><td>${s.assigned}</td>
      <td class="actions"><button class="btn small" data-es="${s.id}">Edit</button><button class="btn small bad" data-ds="${s.id}">Delete</button></td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card" style="margin-top:14px"><h3>Employee schedule</h3><div class="table-wrap"><table class="t"><thead><tr><th>Employee</th><th>Department</th><th>Shift</th></tr></thead><tbody>
    ${sched.map(e => `<tr><td>${esc(e.name)}<div class="muted small">${esc(e.employee_no)}</div></td><td>${esc(e.department || '')}</td>
      <td><select data-assign="${e.id}">${opts(shifts, e.shift_id, '— none —')}</select></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#new-shift').onclick = () => shiftModal();
  main().querySelectorAll('[data-es]').forEach(b => b.onclick = () => shiftModal(shifts.find(s => s.id == b.dataset.es)));
  main().querySelectorAll('[data-ds]').forEach(b => b.onclick = guard(async () => {
    if (!confirm('Delete this shift?')) return; await api(`/api/shifts/${b.dataset.ds}`, 'DELETE'); toast('Shift deleted.'); renderShifts();
  }));
  main().querySelectorAll('[data-assign]').forEach(sel => sel.onchange = guard(async () => {
    if (!sel.value) return;
    await api(`/api/schedule/${sel.dataset.assign}`, 'PUT', { shift_id: sel.value }); toast('Schedule updated.'); renderShifts();
  }));
}
function shiftModal(s) {
  const days = s ? s.work_days.split(',').map(Number) : [1, 2, 3, 4, 5];
  openModal(s ? 'Edit shift' : 'New shift', `<form id="sf" class="form-grid">
    <label class="full">Shift name<input name="name" value="${esc(s?.name)}" required></label>
    <label>Start time<input type="time" name="start_time" value="${esc(s?.start_time || '08:00')}" required></label>
    <label>End time<input type="time" name="end_time" value="${esc(s?.end_time || '17:00')}" required></label>
    <label>Grace period (minutes)<input type="number" name="grace_minutes" min="0" max="120" value="${s ? s.grace_minutes : 10}"></label>
    <div class="full"><div class="muted small" style="margin-bottom:6px">Work days</div>
      <div class="actions">${DAYS.map((n, i) => `<label class="check"><input type="checkbox" name="d${i}" ${days.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}</div></div>
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Save</button></div></form>`);
  $('#sf').onsubmit = guard(async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), start_time: fd.get('start_time'), end_time: fd.get('end_time'), grace_minutes: fd.get('grace_minutes'),
      work_days: DAYS.map((_, i) => i).filter(i => fd.has('d' + i)) };
    await api(s ? `/api/shifts/${s.id}` : '/api/shifts', s ? 'PUT' : 'POST', body);
    closeModal(); toast('Shift saved.'); renderShifts();
  });
}

// ---------- Payroll processing updates ----------
async function renderPayroll() {
  const rows = await api('/api/payroll');
  main().innerHTML = `
    <div class="page-head"><h2>Payroll Updates</h2>${isStaff() ? '<button class="btn primary" id="new-pay">+ Post update</button>' : ''}</div>
    <p class="muted small">Status notices only. This system does not compute or pay salaries.</p>
    <div class="card">${rows.map(p => `<div class="ann ${p.status === 'Delayed' ? 'urgent' : ''}">
      <h3>${esc(p.period_label)} ${badge(p.status)}</h3>
      <div class="muted small">${p.pay_date ? 'Pay date: ' + fmtDate(p.pay_date) + ' &middot; ' : ''}${fmtDT(p.created_at)} &middot; ${esc(p.author)}</div>
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}
      ${isStaff() ? `<button class="btn small" data-delp="${p.id}">Delete</button>` : ''}</div>`).join('') || '<p class="muted">No payroll updates yet.</p>'}</div>`;
  if (isStaff()) {
    $('#new-pay').onclick = payModal;
    main().querySelectorAll('[data-delp]').forEach(b => b.onclick = guard(async () => {
      if (!confirm('Delete this update?')) return; await api(`/api/payroll/${b.dataset.delp}`, 'DELETE'); renderPayroll();
    }));
  }
}
function payModal() {
  openModal('Post payroll update', `<form id="pyf" class="form-grid">
    <label class="full">Pay period<input name="period_label" placeholder="Nov 1-15, 2026" required></label>
    <label>Status<select name="status"><option>Processing</option><option>Released</option><option>Delayed</option></select></label>
    <label>Pay date<input type="date" name="pay_date"></label>
    <label class="full">Note (optional)<textarea name="note" rows="2"></textarea></label>
    <label class="check full"><input type="checkbox" name="send_sms" checked> Send by SMS and email to all employees</label>
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Post</button></div></form>`);
  $('#pyf').onsubmit = guard(async e => {
    e.preventDefault();
    const fd = new FormData(e.target), body = Object.fromEntries(fd); body.send_sms = fd.has('send_sms');
    const r = await api('/api/payroll', 'POST', body);
    closeModal(); toast(body.send_sms ? `Posted. SMS: ${r.sms.sent} sent, ${r.sms.failed} failed. Email: ${r.email.sent} sent, ${r.email.failed} failed.` : 'Posted.'); renderPayroll();
  });
}

// ---------- Reports (generated by Python) ----------
let repMonth = ymLocal();
async function renderReports() {
  main().innerHTML = `<div class="page-head"><h2>Attendance Report</h2></div>
    <div class="card"><div class="form-grid" style="align-items:end">
      <label>Month<input type="month" id="rep-month" value="${repMonth}" placeholder="YYYY-MM"></label>
      <div class="actions"><button class="btn primary" id="rep-run">Generate</button><a class="btn" id="rep-xlsx" href="#">Excel</a><a class="btn" id="rep-pdf" href="#">PDF</a><a class="btn" id="rep-csv" href="#">CSV</a></div></div>
      <p class="muted small">Calculated by Python (<code>reports/attendance_report.py</code>); the Excel and PDF files are built by <code>reports/export_report.py</code> (openpyxl and reportlab). Holidays are not counted as scheduled days.</p></div>
    <div id="rep-out" style="margin-top:14px"></div>`;
  const run = guard(async () => {
    const m = $('#rep-month').value; if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('Choose a month (YYYY-MM).');
    repMonth = m; repLinks(m);
    $('#rep-out').innerHTML = '<p class="muted">Running report…</p>';
    const r = await api('/api/reports/attendance?month=' + m);
    const t = r.totals;
    $('#rep-out').innerHTML = `
      <div class="grid stats">${[['Employees', t.employees], ['Present days', t.present], ['Late', t.late], ['Absent days', t.absent], ['Avg. attendance', t.average_rate === null ? '—' : t.average_rate + '%']]
        .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
      <div class="card"><p class="muted small">Counted through ${fmtDate(r.through)}.</p><div class="table-wrap"><table class="t"><thead><tr><th>Employee</th><th>Shift</th><th>Sched.</th><th>Present</th><th>Late</th><th>Absent</th><th>Leave</th><th>Late min.</th><th>Hours</th><th>Rate</th></tr></thead><tbody>
      ${r.rows.map(x => `<tr><td>${esc(x.name)}<div class="muted small">${esc(x.department)}</div></td><td>${esc(x.shift)}</td><td>${x.scheduled_days}</td><td>${x.present}</td><td>${x.late}</td><td>${x.absent}</td><td>${x.on_leave}</td><td>${x.late_minutes}</td><td>${x.hours_worked}</td><td>${x.attendance_rate === null ? '—' : x.attendance_rate + '%'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  });
  $('#rep-run').onclick = run; repLinks(repMonth); run();
}

function otpCard(p) {
  const m = lookups.otpMode;
  if (m === 'all') return '<p>An SMS code is required at login for <b>all accounts</b> (set by the administrator).</p>';
  if (m === 'staff' && (me.role === 'Admin' || me.role === 'HR Staff')) return '<p>An SMS code is required at login for <b>Admin and HR Staff</b> accounts.</p>';
  if (m === 'off') return '<p class="muted">SMS login codes are turned off by the administrator.</p>';
  return `<label class="check"><input type="checkbox" id="otp-toggle" ${p.otp_enabled ? 'checked' : ''}> Ask for an SMS code when I log in</label>
    <p class="muted small">A 6-digit code is texted to your mobile number each time you sign in. Save a valid mobile number above first.</p>`;
}

const repLinks = (m) => ['csv', 'xlsx', 'pdf'].forEach(f => { $('#rep-' + f).href = `/api/reports/attendance?month=${m}&format=${f}`; });

// ---------- Holidays (external API) ----------
let holYear = new Date().getFullYear();
async function renderHolidays() {
  const d = await api('/api/holidays?year=' + holYear);
  const src = { api: 'Holiday API', fallback: 'Built-in list', manual: 'Company' };
  main().innerHTML = `
    <div class="page-head"><h2>Holidays</h2><div class="actions">
      <input type="number" id="hol-year" value="${d.year}" min="2000" max="2100" style="width:110px">
      ${isStaff() ? '<button class="btn" id="hol-sync">Sync from API</button><button class="btn primary" id="hol-add">+ Add holiday</button>' : ''}</div></div>
    <p class="muted small">Public holidays are loaded from the Nager.Date web API (country ${esc(d.country)}). Weekends and holidays are not counted as leave days and are not marked absent.</p>
    <div class="card">${d.rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Source</th><th></th></tr></thead><tbody>
      ${d.rows.map(h => `<tr><td>${fmtDate(h.date)}</td><td>${new Date(h.date + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'long' })}</td><td>${esc(h.name)}</td><td>${src[h.source] || esc(h.source)}</td>
        <td class="actions">${isStaff() ? `<button class="btn small bad" data-delh="${h.id}">Delete</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No holidays for this year yet.</p>'}</div>`;
  $('#hol-year').onchange = (e) => { const y = +e.target.value; if (y >= 2000 && y <= 2100) { holYear = y; guard(renderHolidays)(); } };
  if (!isStaff()) return;
  $('#hol-sync').onclick = guard(async () => {
    const r = await api('/api/holidays/sync', 'POST', { year: holYear });
    toast(r.warning || `Synced ${r.count} holidays from the API.`, !!r.warning); renderHolidays();
  });
  $('#hol-add').onclick = () => {
    openModal('Add company holiday', `<form id="hf" class="form-grid">
      <label>Date<input type="date" name="date" required></label><label>Name<input name="name" required></label>
      <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Save</button></div></form>`);
    $('#hf').onsubmit = guard(async e => { e.preventDefault(); await api('/api/holidays', 'POST', Object.fromEntries(new FormData(e.target))); closeModal(); toast('Holiday saved.'); renderHolidays(); });
  };
  main().querySelectorAll('[data-delh]').forEach(b => b.onclick = guard(async () => {
    if (!confirm('Delete this holiday?')) return; await api(`/api/holidays/${b.dataset.delh}`, 'DELETE'); renderHolidays();
  }));
}

// ---------- Email log ----------
async function renderEmailLog() {
  const rows = await api('/api/email-log');
  main().innerHTML = `<div class="page-head"><h2>Email Log</h2>${me.role === 'Admin' ? '<button class="btn" id="mail-test">Send test email</button>' : ''}</div>
    <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Trigger</th><th>Provider</th><th>Status</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.employee_name || '')}<div class="muted small">${esc(r.recipient)}</div></td>
      <td>${esc(r.subject)}${r.status === 'failed' ? `<div class="small" style="color:var(--bad)">${esc(r.response)}</div>` : ''}</td>
      <td>${esc(r.trigger_type)}</td><td>${esc(r.provider)}</td><td>${badge(r.status)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No emails yet.</td></tr>'}
    </tbody></table></div></div>`;
  if (me.role === 'Admin') $('#mail-test').onclick = () => {
    openModal('Send test email', `<form id="mf" class="form-grid"><label class="full">To<input name="to" type="email" required></label>
      <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Send</button></div></form>`);
    $('#mf').onsubmit = guard(async e => {
      e.preventDefault(); const r = await api('/api/email-test', 'POST', Object.fromEntries(new FormData(e.target)));
      closeModal(); toast(r.ok ? 'Test email processed.' : `Failed: ${r.error}`, !r.ok); renderEmailLog();
    });
  };
}
