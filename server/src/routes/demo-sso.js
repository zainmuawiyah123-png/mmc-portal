'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { getDB, uid } = require('../db');
const A = require('../lib/auth');
const { consumeDemoTicket, ALLOWED_EMAIL } = require('../lib/demo-sso');
const { E, wrap } = require('../lib/errors');

const router = express.Router();

router.post('/exchange', wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  const ticket = String(req.body?.ticket || '');
  if (!ticket || ticket.length > 4096) throw E.unauthorized('Invalid demo access ticket');
  const db = getDB();
  let identity;
  try {
    identity = db.transaction(() => {
      const claims = consumeDemoTicket({
        db, token: ticket, audience: 'mmc-ai-staging', secret: config.DEMO_SSO_SECRET
      });
      const userId = 'demo_' + crypto.createHash('sha256').update(ALLOWED_EMAIL).digest('hex').slice(0, 24);
      const existing = db.prepare('SELECT id,email FROM users WHERE lower(email)=lower(?)').get(ALLOWED_EMAIL);
      if (existing && existing.id !== userId) throw new Error('Demo email is already bound to a non-demo identity');
      if (!existing) {
        const unusablePassword = '!demo-sso-only:' + crypto.randomBytes(48).toString('hex');
        db.prepare(`INSERT INTO users(id,email,password_hash,name,company,plan_key,role,account_status)
          VALUES(?,?,?,?,?,'free','contractor','active')`)
          .run(userId, ALLOWED_EMAIL, unusablePassword, 'MMC Demo Presenter', 'MMC DEMO');
      }
      const projectId = 'demo_presenter_workspace';
      db.prepare(`INSERT INTO ai_projects(id,name,description,country,currency,created_by,status)
        VALUES(?,?,?,?,?,?,'active') ON CONFLICT(id) DO NOTHING`)
        .run(projectId, 'MMC Demo Workspace', 'DEMO ONLY — isolated presentation project', 'JO', 'JOD', userId);
      const project = db.prepare('SELECT created_by FROM ai_projects WHERE id=?').get(projectId);
      if (!project || project.created_by !== userId) throw new Error('Demo workspace identity conflict');
      db.prepare(`INSERT INTO ai_project_members(project_id,user_id,role)
        VALUES(?,?,'owner') ON CONFLICT(project_id,user_id) DO NOTHING`).run(projectId, userId);
      db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json)
        VALUES(?,?,?,'demo_sso_login','session',NULL,?)`)
        .run(uid('aial_'), projectId, userId, JSON.stringify({ email: ALLOWED_EMAIL, sourceUserId: claims.sourceUserId }));
      return { user: db.prepare('SELECT * FROM users WHERE id=?').get(userId), projectId };
    })();
  } catch (err) {
    return res.status(401).json({ error: { code: 'DEMO_SSO_INVALID', message: 'Demo access ticket is invalid or already used.' } });
  }
  A.setSessionCookie(res, A.signToken(identity.user));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, projectId: identity.projectId, redirect: '/mmc-ai/' });
}));

module.exports = router;
