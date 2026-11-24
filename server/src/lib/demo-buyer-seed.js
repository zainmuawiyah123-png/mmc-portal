'use strict';

const crypto = require('crypto');

/**
 * Seeds one isolated procurement demo account.
 * This is intentionally disabled unless the preview service explicitly opts in.
 * Never enable MMC_DEMO_BUYER_ENABLED on production.
 */
async function seedDemoBuyer() {
  if (process.env.MMC_DEMO_BUYER_ENABLED !== 'true') return { enabled: false };

  const email = String(process.env.MMC_DEMO_BUYER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.MMC_DEMO_BUYER_PASSWORD || '');
  const name = String(process.env.MMC_DEMO_BUYER_NAME || 'مدير مشتريات تجريبي').trim();
  const company = String(process.env.MMC_DEMO_BUYER_COMPANY || 'MMC Demo Procurement').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 16) {
    throw new Error('Demo buyer seed requires a valid email and a password of at least 16 characters.');
  }

  const { getDB, uid } = require('../db');
  const auth = require('./auth');
  const org = require('./org');
  const db = getDB();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    const id = uid('usr_');
    const passwordHash = await auth.hashPassword(password);
    db.transaction(() => {
      db.prepare(`INSERT INTO users
        (id, email, password_hash, name, company, role, country, plan_key, account_status)
        VALUES (?, ?, ?, ?, ?, 'buyer', 'JO', 'free', 'active')`)
        .run(id, email, passwordHash, name, company);
      db.prepare(`INSERT INTO subscriptions (id, user_id, plan_key, status, source)
        VALUES (?, ?, 'free', 'active', 'system')`).run(uid('sub_'), id);
    })();
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  } else if (user.role !== 'buyer') {
    throw new Error('Configured demo email already belongs to a non-buyer account; refusing to change its role.');
  }

  const membership = org.ensureOrg(user);
  if (!membership) throw new Error('Could not create or resolve the isolated demo organization.');
  await seedDemoTeam(db, membership.org_id, user, auth);
  seedDemoRequests(db, membership.org_id, user);

  console.log('[demo] isolated procurement buyer ready:', email, 'organization:', membership.org_name);
  return { enabled: true, email, organization: membership.org_name };
}

async function seedDemoTeam(db, orgId, managerUser, auth) {
  const { uid } = require('../db');
  const members = [
    { key: 'requester', name: 'مسؤول طلب الخدمة', email: 'requester@mmc-demo.invalid', role: 'requester' },
    { key: 'projects', name: 'مدير دائرة المشاريع', email: 'projects@mmc-demo.invalid', role: 'projects' },
    { key: 'procurement', name: 'مسؤول المشتريات', email: 'procurement@mmc-demo.invalid', role: 'procurement' },
    { key: 'finance', name: 'مسؤول المالية', email: 'finance@mmc-demo.invalid', role: 'finance' }
  ];
  const ids = {};
  for (const member of members) {
    let row = db.prepare('SELECT id FROM users WHERE email = ?').get(member.email);
    if (!row) {
      const id = uid('usr_demo_');
      const randomHash = await auth.hashPassword(crypto.randomBytes(32).toString('hex'));
      db.prepare(`INSERT INTO users (id,email,password_hash,name,company,role,country,plan_key,account_status)
        VALUES (?,?,?,?,?,'buyer','JO','free','suspended')`)
        .run(id, member.email, randomHash, member.name, managerUser.company);
      row = { id };
    }
    ids[member.key] = row.id;
    db.prepare('INSERT OR IGNORE INTO org_members (org_id,user_id,role) VALUES (?,?,?)')
      .run(orgId, row.id, member.role);
  }
  return ids;
}

function seedDemoRequests(db, orgId, managerUser) {
  const requester = db.prepare("SELECT user_id FROM org_members WHERE org_id=? AND role='requester'").get(orgId);
  const projects = db.prepare("SELECT user_id FROM org_members WHERE org_id=? AND role='projects'").get(orgId);
  if (!requester || !projects) throw new Error('Demo team roles are not ready.');
  const samples = [
    { id: 'demo_req_001', title: 'تأهيل مبنى الخدمات والمرافق', titleEn: 'Services building rehabilitation', description: 'طلب تجريبي لتوضيح تسجيل الاحتياج وتحديد نطاق الأعمال الأولي.', location: 'عمّان', service: 'works', budget: 85000, currency: 'JOD', status: 'submitted', action: 'submit', from: 'draft', to: 'submitted' },
    { id: 'demo_req_002', title: 'صيانة وتأهيل شبكة تصريف الأمطار', titleEn: 'Stormwater drainage rehabilitation', description: 'طلب تجريبي قيد دراسة دائرة المشاريع وتجهيز وثائق الطرح.', location: 'الزرقاء', service: 'works', budget: 120000, currency: 'JOD', status: 'in_study', action: 'take', from: 'submitted', to: 'in_study' }
  ];
  for (const s of samples) {
    const exists = db.prepare('SELECT id FROM project_requests WHERE id=?').get(s.id);
    if (exists) continue;
    db.prepare(`INSERT INTO project_requests
      (id,org_id,requester_id,assigned_to,title,title_en,description,location,country,service_type,budget,currency,status,fidic_book,fidic_edition,submitted_at)
      VALUES (?,?,?,?,?,?,?,?,? ,? ,? ,? ,? ,'red','2017',unixepoch())`)
      .run(s.id, orgId, requester.user_id, s.status === 'in_study' ? projects.user_id : null,
        s.title, s.titleEn, s.description, s.location, 'JO', s.service, s.budget, s.currency, s.status);
    db.prepare(`INSERT INTO request_events (id,request_id,user_id,action,from_status,to_status,note)
      VALUES (?,?,?,?,?,?,?)`)
      .run('demo_evt_' + s.id, s.id, managerUser.id, s.action, s.from, s.to, 'حدث تجريبي لشرح مسار الطلب');
  }
}

module.exports = { seedDemoBuyer };
