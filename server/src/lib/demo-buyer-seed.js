'use strict';

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
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || password.length < 16) {
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
  console.log('[demo] isolated procurement buyer ready:', email, 'organization:', membership.org_name);
  return { enabled: true, email, organization: membership.org_name };
}

module.exports = { seedDemoBuyer };
