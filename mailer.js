const nodemailer = require('nodemailer');

function verificationMessage(purpose, url) {
  const signup = purpose === 'signup';
  const subject = signup ? 'Verify your Pepper TCG email' : 'Confirm your Pepper TCG sign in';
  const action = signup ? 'Verify email' : 'Confirm sign in';
  const explanation = signup
    ? 'Open this link to verify your email and activate your account:'
    : 'A sign in with your email address and password was requested. Open this link to finish signing in:';
  return {
    subject,
    text: `${explanation}\n\n${url}\n\nIf you did not request this, you can ignore this email. The link expires soon.`,
    html: `<p>${explanation}</p><p><a href="${url}">${action}</a></p><p>If you did not request this, you can ignore this email. The link expires soon.</p>`
  };
}

function createResendMailer(env, request) {
  const from = env.RESEND_FROM || 'Pepper TCG <onboarding@resend.dev>';
  const testEmail = (env.RESEND_TEST_EMAIL || '').trim().toLowerCase();
  const usingTestSender = /@resend\.dev\b/i.test(from);
  if (usingTestSender && !testEmail) return null;
  const canSendTo = (to) => !usingTestSender || to.toLowerCase() === testEmail;

  return {
    canSendTo,
    async sendVerification({ to, purpose, url }) {
      if (!canSendTo(to)) {
        throw Object.assign(new Error('The Resend test sender can only email the Resend account address.'), { code: 'RESEND_TEST_RECIPIENT_ONLY' });
      }
      const response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], ...verificationMessage(purpose, url) }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        throw Object.assign(new Error('Resend did not accept the email.'), { code: `RESEND_HTTP_${response.status}` });
      }
      const result = await response.json();
      if (!result.id) throw Object.assign(new Error('Resend did not provide a message ID.'), { code: 'RESEND_NO_MESSAGE_ID' });
    }
  };
}

function createMailer(env = process.env, request = fetch) {
  if (env.RESEND_API_KEY) return createResendMailer(env, request);
  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const pass = env.SMTP_HOST === 'smtp.gmail.com'
    ? env.SMTP_PASS?.replace(/\s/g, '')
    : env.SMTP_PASS;
  const from = env.MAIL_FROM || user;
  if (!host || !user || !pass || !from) return null;

  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port.');
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true
  });

  return {
    verify: () => transport.verify(),
    async sendVerification({ to, purpose, url }) {
      await transport.sendMail({ from, to, ...verificationMessage(purpose, url) });
    }
  };
}

module.exports = { createMailer };
