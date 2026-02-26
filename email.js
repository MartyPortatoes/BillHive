/**
 * BillFlow email dispatch module
 * Supports: Mailgun, SendGrid, Resend, SMTP (nodemailer)
 *
 * Config shape (stored encrypted in DB under key 'emailConfig'):
 * {
 *   provider: 'mailgun' | 'sendgrid' | 'resend' | 'smtp',
 *   fromName:  string,
 *   fromEmail: string,
 *
 *   // Mailgun
 *   mailgunApiKey:  string,
 *   mailgunDomain:  string,
 *   mailgunRegion:  'us' | 'eu',
 *
 *   // SendGrid
 *   sendgridApiKey: string,
 *
 *   // Resend
 *   resendApiKey:   string,
 *
 *   // SMTP
 *   smtpHost:    string,
 *   smtpPort:    number,
 *   smtpSecure:  boolean,
 *   smtpUser:    string,
 *   smtpPass:    string,
 * }
 */

const nodemailer = require('nodemailer');

// ── Helpers ───────────────────────────────────────────────────────────────────
async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text;
}

async function postForm(url, headers, formData) {
  // Mailgun uses form-encoded
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(formData).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text;
}

// ── Provider dispatch ─────────────────────────────────────────────────────────
async function sendViaMailgun(cfg, to, subject, html, text) {
  const region = cfg.mailgunRegion === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
  const url = `https://${region}/v3/${cfg.mailgunDomain}/messages`;
  const auth = 'Basic ' + Buffer.from('api:' + cfg.mailgunApiKey).toString('base64');
  await postForm(url, { Authorization: auth }, {
    from: `${cfg.fromName} <${cfg.fromEmail}>`,
    to,
    subject,
    html,
    text,
  });
}

async function sendViaSendGrid(cfg, to, subject, html, text) {
  await post('https://api.sendgrid.com/v3/mail/send',
    { Authorization: 'Bearer ' + cfg.sendgridApiKey },
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: cfg.fromEmail, name: cfg.fromName },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html',  value: html },
      ],
    }
  );
}

async function sendViaResend(cfg, to, subject, html, text) {
  await post('https://api.resend.com/emails',
    { Authorization: 'Bearer ' + cfg.resendApiKey },
    {
      from: `${cfg.fromName} <${cfg.fromEmail}>`,
      to: [to],
      subject,
      html,
      text,
    }
  );
}

async function sendViaSmtp(cfg, to, subject, html, text) {
  const transporter = nodemailer.createTransport({
    host:   cfg.smtpHost,
    port:   parseInt(cfg.smtpPort) || 587,
    secure: cfg.smtpSecure === true || cfg.smtpPort == 465,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass,
    },
    tls: { rejectUnauthorized: false }, // allow self-signed for self-hosted
  });
  await transporter.sendMail({
    from:    `"${cfg.fromName}" <${cfg.fromEmail}>`,
    to,
    subject,
    text,
    html,
  });
}

// ── Public send function ──────────────────────────────────────────────────────
/**
 * @param {object} cfg     — email provider config from DB
 * @param {string} to      — recipient email address
 * @param {string} subject
 * @param {string} html    — HTML email body
 * @param {string} text    — plain text fallback
 */
async function sendEmail(cfg, to, subject, html, text) {
  if (!cfg || !cfg.provider) throw new Error('No email provider configured');
  if (!cfg.fromEmail)        throw new Error('No sender email configured');
  if (!to)                   throw new Error('No recipient email address');

  switch (cfg.provider) {
    case 'mailgun':  return sendViaMailgun(cfg, to, subject, html, text);
    case 'sendgrid': return sendViaSendGrid(cfg, to, subject, html, text);
    case 'resend':   return sendViaResend(cfg, to, subject, html, text);
    case 'smtp':     return sendViaSmtp(cfg, to, subject, html, text);
    default: throw new Error(`Unknown provider: ${cfg.provider}`);
  }
}

// ── Config masking (never send API keys to frontend) ─────────────────────────
function maskConfig(cfg) {
  if (!cfg) return null;
  const masked = { ...cfg };
  const secretFields = ['mailgunApiKey','sendgridApiKey','resendApiKey','smtpPass'];
  secretFields.forEach(f => {
    if (masked[f]) masked[f] = masked[f].slice(0, 4) + '••••••••••••';
  });
  return masked;
}

module.exports = { sendEmail, maskConfig };
