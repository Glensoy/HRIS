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

const badge = (s) => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;
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
  employees: { label: 'Employees', staff: true, render: renderEmployees },
  announcements: { label: 'Announcements', render: renderAnnouncements },
  smslog: { label: 'SMS Log', staff: true, render: renderSmsLog },
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
  page = p;
  document.querySelector('.sidebar').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); window.scrollTo(0, 0);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.p === p));
  guard(PAGES[p].render)();
}
const main = () => $('#main');

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api('/api/login', 'POST', { username: f.get('username'), password: f.get('password') }); $('#login-error').textContent = ''; e.target.reset(); boot(); }
  catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', 'POST'); boot(); });

// ---------- Dashboard ----------
async function renderDashboard() {
  const [d, ann] = await Promise.all([api('/api/dashboard'), api('/api/announcements')]);
  let stats;
  if (isStaff()) {
    stats = [['Active employees', d.employees], ['Pending leave requests', d.pending], ['On leave today', d.onLeaveToday], ['SMS sent today', d.smsToday]];
  } else {
    stats = [['Pending', d.mine.Pending || 0], ['Approved', d.mine.Approved || 0], ['Rejected', d.mine.Rejected || 0]];
  }
  main().innerHTML = `
    <div class="page-head"><h2>Welcome, ${esc(me.name.split(' ')[0])}</h2>
      <span class="muted small">SMS provider: <b>${esc(lookups.smsProvider)}</b>${lookups.smsProvider === 'sandbox' ? ' (messages are logged, not sent)' : ''}</span></div>
    <div class="grid stats">${stats.map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
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
        ? `<button class="btn small ok" data-review="${r.id}" data-d="Approved">Approve</button><button class="btn small bad" data-review="${r.id}" data-d="Rejected">Reject</button>`
        : `<button class="btn small" data-cancel="${r.id}">Cancel</button>`) : ''}</td></tr>`).join('')}
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
    <button class="btn ${decision === 'Approved' ? 'ok' : 'bad'}">${decision === 'Approved' ? 'Approve' : 'Reject'} &amp; notify by SMS</button></div></form>`);
  $('#rf').onsubmit = guard(async e => {
    e.preventDefault();
    const r = await api(`/api/leave/${id}/review`, 'POST', { decision, remarks: new FormData(e.target).get('remarks') });
    closeModal(); toast(r.sms?.ok ? 'Decision saved and SMS dispatched.' : `Decision saved. SMS not sent: ${r.sms?.error || 'n/a'}`, !r.sms?.ok); renderApprovals();
  });
}

// ---------- Employees (staff) ----------
async function renderEmployees() {
  const rows = await api('/api/employees');
  main().innerHTML = `<div class="page-head"><h2>Employees</h2><button class="btn primary" id="add-emp">+ Add employee</button></div>
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
    <div class="full"><label class="check"><input type="checkbox" name="send_sms"> Also send as SMS</label>
    <label class="check"><input type="checkbox" name="is_urgent"> Mark as urgent (always sends SMS)</label></div>
    <div class="form-actions full"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button class="btn primary">Publish</button></div></form>`);
  $('#af').onsubmit = guard(async e => {
    e.preventDefault();
    const fd = new FormData(e.target), body = Object.fromEntries(fd);
    body.send_sms = fd.has('send_sms'); body.is_urgent = fd.has('is_urgent');
    const r = await api('/api/announcements', 'POST', body);
    closeModal(); toast(r.sms.sent || r.sms.failed ? `Published. SMS: ${r.sms.sent} sent, ${r.sms.failed} failed.` : 'Published.'); renderAnnouncements();
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
        <div><button class="btn primary">Save contact details</button></div>
      </form></div>
    <div class="card"><h3>Change password</h3><form id="pw" class="grid">
      <label>Current password<input type="password" name="current" required></label>
      <label>New password (min. 6)<input type="password" name="next" minlength="6" required></label>
      <div><button class="btn">Update password</button></div></form></div>
  </div>`;
  $('#pf').onsubmit = guard(async e => {
    e.preventDefault(); const fd = new FormData(e.target), b = Object.fromEntries(fd); b.sms_opt_in = fd.has('sms_opt_in');
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
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (heads[i] !== undefined) td.dataset.label = heads[i]; }));
  });
}
new MutationObserver(labelTables).observe($('#main'), { childList: true, subtree: true });
if ('serviceWorker' in navigator) { /* reserved for offline support */ }
