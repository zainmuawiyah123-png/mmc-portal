'use strict';
/**
 * طابور بريد إلكتروني بسيط: كل رسالة تُسجَّل في email_outbox ثم تُرسل في الخلفية.
 * الفشل لا يُعطّل أي عملية تجارية؛ تُعاد المحاولة حتى 5 مرات من المجدول.
 * بلا MAIL_HOST: الحالة skipped (لا إرسال، ويبقى سجل بما كان سيُرسل).
 */
const config = require('../config');
const { getDB, uid } = require('../db');

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
let transport = null;

function enabled() { return !!(config.MAIL.resendApiKey || config.MAIL.host); }

/** إرسال عبر HTTPS API؛ لا يعتمد على منافذ SMTP المحظورة في Render Free. */
async function sendViaResend(message, apiKey = config.MAIL.resendApiKey, fetchImpl = globalThis.fetch) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('HTTPS fetch is unavailable');
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15000)
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    const reason = clean(payload.message || payload.name || ('HTTP ' + response.status), 240);
    throw new Error('Resend API rejected the message: ' + reason);
  }
  return payload;
}
function getTransport() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = config.MAIL.host === 'json'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: config.MAIL.host, port: config.MAIL.port, secure: config.MAIL.secure,
        auth: config.MAIL.user ? { user: config.MAIL.user, pass: config.MAIL.pass } : undefined
      });
  return transport;
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, n);

/** يضيف رسالة للطابور ويحاول إرسالها فوراً دون انتظار. لا يرمي أخطاء أبداً. */
function notify(to, subject, text) {
  try {
    const addr = clean(to, 254);
    if (!EMAIL_RE.test(addr)) return null;
    const id = uid('mail_');
    getDB().prepare(`INSERT INTO email_outbox (id,to_email,subject,body,status) VALUES (?,?,?,?,?)`)
      .run(id, addr, clean(subject, 200), String(text || '').slice(0, 8000), enabled() ? 'pending' : 'skipped');
    if (enabled()) setImmediate(() => sendOne(id).catch(() => {}));
    return id;
  } catch (e) { console.error('[mail] تعذر تسجيل الرسالة:', e.message); return null; }
}

/** Adds a message and waits for the first SMTP attempt (used for security codes). */
async function notifyNow(to, subject, text) {
  const addr = clean(to, 254);
  if (!EMAIL_RE.test(addr) || !enabled()) return { id: null, sent: false };
  const id = uid('mail_');
  getDB().prepare(`INSERT INTO email_outbox (id,to_email,subject,body,status) VALUES (?,?,?,?,?)`)
    .run(id, addr, clean(subject, 200), String(text || '').slice(0, 8000), 'pending');
  return { id, sent: await sendOne(id) };
}

async function sendOne(id) {
  const db = getDB();
  const row = db.prepare("SELECT * FROM email_outbox WHERE id=? AND status IN ('pending','failed') AND attempts<5").get(id);
  if (!row) return false;
  db.prepare('UPDATE email_outbox SET attempts=attempts+1 WHERE id=?').run(id);
  try {
    const message = { from: config.MAIL.from || config.MAIL.user || 'no-reply@localhost', to: [row.to_email], subject: row.subject, text: row.body };
    if (config.MAIL.resendApiKey) await sendViaResend(message);
    else await getTransport().sendMail({ ...message, to: row.to_email });
    db.prepare("UPDATE email_outbox SET status='sent', sent_at=unixepoch(), error=NULL WHERE id=?").run(id);
    return true;
  } catch (e) {
    db.prepare("UPDATE email_outbox SET status='failed', error=? WHERE id=?").run(String(e.message || e).slice(0, 300), id);
    console.error(config.MAIL.resendApiKey ? '[mail] HTTPS email send failed:' : '[mail] SMTP send failed:', JSON.stringify({ code: e.code || null, command: e.command || null, responseCode: e.responseCode || null, message: String(e.message || e).slice(0, 300) }));
    return false;
  }
}

/** يعيد محاولة الرسائل المعلّقة/الفاشلة (يُستدعى من المجدول) */
async function flush(limit = 25) {
  if (!enabled()) return { sent: 0, skipped: true };
  const ids = getDB().prepare("SELECT id FROM email_outbox WHERE status IN ('pending','failed') AND attempts<5 ORDER BY created_at LIMIT ?").all(limit);
  let sent = 0;
  for (const r of ids) if (await sendOne(r.id)) sent++;
  return { sent, tried: ids.length };
}

const link = (path) => (config.MAIL.publicUrl ? config.MAIL.publicUrl + path : '');
const userEmail = (userId) => (getDB().prepare('SELECT email FROM users WHERE id=?').get(userId) || {}).email;
/** إشعار لمستخدم بمعرّفه */
function notifyUser(userId, subject, text) { const e = userEmail(userId); return e ? notify(e, subject, text) : null; }

module.exports = { notify, notifyNow, notifyUser, flush, sendOne, enabled, link, EMAIL_RE, sendViaResend };
