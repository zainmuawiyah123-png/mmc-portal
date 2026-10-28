'use strict';
/**
 * إعداد سريع لحساب المدير + حسابات تجريبية.
 * الاستخدام:
 *   node scripts/setup-admin.js
 * أو مع قيم مخصصة:
 *   ADMIN_EMAIL=admin@mmc.local ADMIN_PASSWORD=Admin@2026Secure node scripts/setup-admin.js
 */
const { migrate } = require('../src/migrate');
const config = require('../src/config');
const { getDB, uid } = require('../src/db');
const { hashPassword } = require('../src/lib/auth');

const accounts = [
  {
    email: process.env.ADMIN_EMAIL || 'admin@mmc.local',
    password: process.env.ADMIN_PASSWORD || 'Admin@2026Secure',
    name: process.env.ADMIN_NAME || 'مدير النظام',
    role: 'admin',
    company: 'MMC'
  },
  {
    email: process.env.BUYER_EMAIL || 'buyer@mmc.local',
    password: process.env.BUYER_PASSWORD || 'Buyer@2026Secure',
    name: 'لجنة المشتريات',
    role: 'buyer',
    company: 'دائرة المشتريات'
  },
  {
    email: process.env.CONTRACTOR_EMAIL || 'contractor@mmc.local',
    password: process.env.CONTRACTOR_PASSWORD || 'Contractor@2026Secure',
    name: 'مكتب المقاولات',
    role: 'contractor',
    company: 'شركة المقاولات'
  }
];

async function ensureUser({ email, password, name, role, company }) {
  const db = getDB();
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing) {
    console.log('  • موجود مسبقاً: ' + email + ' (' + existing.role + ')');
    return existing.id;
  }
  const hash = await hashPassword(password);
  const id = uid('usr_');
  db.prepare(`INSERT INTO users (id, email, password_hash, name, company, role, plan_key)
              VALUES (?,?,?,?,?,?, 'free')`).run(id, email, hash, name, company, role);
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_key, status, source)
              VALUES (?,?, 'free', 'active', 'trial')`).run(uid('sub_'), id);
  console.log('  ✓ تم الإنشاء: ' + email + ' / ' + role);
  return id;
}

async function main() {
  migrate(config.DB_PATH);
  console.log('');
  console.log('=== إعداد حسابات البوابات ===');
  for (const a of accounts) {
    await ensureUser(a);
  }
  console.log('');
  console.log('بيانات الدخول:');
  console.log('─────────────────────────────────────────────');
  for (const a of accounts) {
    console.log('  ' + String(a.role).padEnd(12) + ': ' + a.email + '  /  ' + a.password);
  }
  console.log('─────────────────────────────────────────────');
  console.log('  تسجيل الدخول: /portal/pt-9f3c7a1e5b2d/login.html');
  console.log('  بوابة الإدارة: /admin/index.html');
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
