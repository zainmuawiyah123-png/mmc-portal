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

function enabled() { return !!config.MAIL.host; }
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

async function sendOne(id) {
  const db = getDB();
  const row = db.prepare("SELECT * FROM email_outbox WHERE id=? AND status IN ('pending','failed') AND attempts<5").get(id);
  if (!row) return false;
  db.prepare('UPDATE email_outbox SET attempts=attempts+1 WHERE id=?').run(id);
  try {
    await getTransport().sendMail({ from: config.MAIL.from || config.MAIL.user || 'no-reply@localhost', to: row.to_email, subject: row.subject, text: row.body });
    db.prepare("UPDATE email_outbox SET status='sent', sent_at=unixepoch(), error=NULL WHERE id=?").run(id);
    return true;
  } catch (e) {
    db.prepare("UPDATE email_outbox SET status='failed', error=? WHERE id=?").run(String(e.message || e).slice(0, 300), id);
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

module.exports = { notify, notifyUser, flush, sendOne, enabled, link, EMAIL_RE };
