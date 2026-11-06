'use strict';
/**
 * ينشئ حساب المدير عند الإقلاع إن عُيّن ADMIN_EMAIL و ADMIN_PASSWORD في البيئة.
 *  - لا يعدّل حساباً موجوداً ولا يغيّر كلمة مروره أبداً.
 *  - لا يطبع كلمة المرور. إن لم تُعيَّن المتغيرات يخرج بصمت دون خطأ.
 *  - بعد أول إنشاء ناجح احذف ADMIN_PASSWORD من إعدادات البيئة.
 */
const { migrate } = require('../src/migrate');
const config = require('../src/config');
const { getDB, closeDB, uid } = require('../src/db');
const { hashPassword } = require('../src/lib/auth');

(async () => {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) { console.log('[setup-admin] ADMIN_EMAIL/ADMIN_PASSWORD غير معيّنين — تخطّي.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.warn('[setup-admin] ADMIN_EMAIL غير صالح — تخطّي.'); return; }
  if (password.length < 12) { console.warn('[setup-admin] ADMIN_PASSWORD أقصر من 12 حرفاً — تخطّي. اختر كلمة أقوى.'); return; }

  migrate(config.DB_PATH);
  const db = getDB();
  const existing = db.prepare('SELECT id, role FROM users WHERE lower(trim(email)) = ?').get(email);
  if (existing) {
    if (existing.role !== 'admin') { console.warn('[setup-admin] البريد مرتبط بحساب غير إداري — لم يُجرَ أي تغيير.'); return; }
    if (String(process.env.ADMIN_PASSWORD_RESET || '').trim().toLowerCase() !== 'true') {
      console.log('[setup-admin] حساب المدير موجود؛ لم تتغير كلمة المرور. لإعادة ضبط مقصودة استخدم ADMIN_PASSWORD_RESET=true.');
      return;
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), existing.id);
    console.log('[setup-admin] ✓ تم تحديث كلمة مرور المدير. احذف ADMIN_PASSWORD_RESET و ADMIN_PASSWORD من إعدادات البيئة الآن.');
    return;
  }

  const id = uid('usr_');
  db.prepare("INSERT INTO users (id, email, password_hash, name, company, role, plan_key) VALUES (?,?,?,?,?,'admin','free')")
    .run(id, email, await hashPassword(password), String(process.env.ADMIN_NAME || 'مدير النظام').slice(0, 120), String(process.env.ADMIN_COMPANY || 'MMC').slice(0, 120));
  db.prepare("INSERT INTO subscriptions (id, user_id, plan_key, status, source) VALUES (?,?, 'free', 'active', 'trial')").run(uid('sub_'), id);
  console.log('[setup-admin] ✓ أُنشئ حساب المدير: ' + email + ' — احذف ADMIN_PASSWORD من إعدادات البيئة الآن.');
})().catch((e) => { console.warn('[setup-admin] تعذّر: ' + e.message); }).finally(() => { try { closeDB(); } catch (_) {} });
