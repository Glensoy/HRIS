// One call, two channels: SMS and email.
const sms = require('./sms');
const email = require('./email');

async function notify(employeeId, { subject, message, trigger }) {
  const smsResult = await sms.notifyEmployee(employeeId, message, trigger);
  const emailResult = await email.notifyEmployee(employeeId, subject, message, trigger);
  return { sms: smsResult, email: emailResult };
}

module.exports = { notify };
