'use strict';
/**
 * إنشاء أول مستخدم (أو أي مستخدم) من سطر الأوامر.
 *
 *   node src/seed.js --email=me@company.com --password=Secret123 --name="أحمد" --company="مكتب المقاولات"
 *
 * أو عبر متغيرات البيئة: SEED_EMAIL, SEED_PASSWORD, SEED_NAME, SEED_COMPANY
 */
const { migrate } = require('./migrate');
const config = require('./config');
const { getDB, uid } = require('./db');
const { hashPassword } = require('./lib/auth');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.env['SEED_' + name.toUpperCase()] || dflt;
}

async function main() {
  migrate(config.DB_PATH);
  const db = getDB();

  const email = String(arg('email', '')).trim().toLowerCase();
  const password = String(arg('password', ''));
  const name = String(arg('name', 'المستخدم الأول')).trim();
  const company = arg('company', null);
  const role = arg('role', 'contractor');
  if (!['contractor', 'buyer', 'admin'].includes(role)) throw new Error('الدور يجب أن يكون contractor أو buyer أو admin');

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('✗ حدّد بريداً صالحاً: --email=you@company.com');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('✗ كلمة المرور يجب أن تكون 8 أحرف على الأقل: --password=...');
    process.exit(1);
  }

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    console.error('✗ البريد مسجّل بالفعل: ' + email);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const id = uid('usr_');
  db.prepare(`INSERT INTO users (id, email, password_hash, name, company, role, plan_key)
              VALUES (?,?,?,?,?, ?, 'free')`).run(id, email, hash, name, company, role);
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_key, status, source)
              VALUES (?,?, 'free', 'active', 'trial')`).run(uid('sub_'), id);

  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;

  console.log('');
  console.log('✓ تم إنشاء المستخدم');
  console.log('  id      : ' + id);
  console.log('  email   : ' + email);
  console.log('  الاسم   : ' + name);
  console.log('  الدور   : ' + role);
  console.log('  الباقة  : free (عطاء واحد · 25 م.ب)');
  console.log('  التشفير : ' + stored.slice(0, 7) + '…  (bcrypt، الطول ' + stored.length + ')');
  console.log('  كلمة المرور لم تُخزَّن نصاً — تحقق من ذلك في قاعدة البيانات.');
  console.log('');
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
