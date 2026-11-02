'use strict';
/**
 * الجهة: الأعضاء والأدوار والدعوات.
 * الدعوة برمز سرّي يصل للعضو خارج المنصة (لا نعتمد على بريد غير موثَّق).
 */
const express = require('express');
const crypto = require('crypto');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const O = require('../lib/org');
const { audit } = require('../lib/audit');

const router = express.Router();
const buyerOnly = [A.requireAuth, A.requireRole('buyer')];
const clip = (s, n) => String(s || '').trim().slice(0, n);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hashCode = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newCode() {
  const b = crypto.randomBytes(10);
  const raw = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
  return raw.slice(0, 5) + '-' + raw.slice(5);
}

function manager(req) {
  const m = O.ensureOrg(req.user);
  if (!m || m.role !== 'manager') throw E.forbidden('هذا الإجراء لمدير الجهة فقط.');
  return m;
}
function seatInfo(m) {
  const db = getDB();
  const { plan } = A.planAndUsage(m.created_by);
  const members = db.prepare('SELECT COUNT(*) n FROM org_members WHERE org_id = ?').get(m.org_id).n;
  const pending = db.prepare("SELECT COUNT(*) n FROM org_invites WHERE org_id = ? AND status = 'pending' AND expires_at > unixepoch()").get(m.org_id).n;
  return { used: members + pending, members, pending, max: plan.maxUsers, planName: plan.nameAr, planNameEn: plan.nameEn };
}
function roleView(key) { return { key, ar: O.ORG_ROLES[key].ar, en: O.ORG_ROLES[key].en }; }

router.get('/', buyerOnly, wrap(async (req, res) => {
  const m = O.ensureOrg(req.user);
  const db = getDB();
  const members = db.prepare('SELECT u.id, u.name, u.email, mm.role, mm.joined_at FROM org_members mm JOIN users u ON u.id = mm.user_id WHERE mm.org_id = ? ORDER BY mm.joined_at').all(m.org_id)
    .map((x) => ({ id: x.id, name: x.name, email: x.email, role: x.role, joinedAt: x.joined_at, isOwner: x.id === m.created_by, me: x.id === req.user.id }));
  const invites = m.role === 'manager'
    ? db.prepare("SELECT id, label, role, created_at, expires_at FROM org_invites WHERE org_id = ? AND status = 'pending' AND expires_at > unixepoch() ORDER BY created_at DESC").all(m.org_id)
      .map((i) => ({ id: i.id, label: i.label, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at }))
    : [];
  const v = O.getVerification(req.user.id);
  res.json({
    org: { id: m.org_id, name: m.org_name, requireApproval: !!m.require_approval, verified: O.isVerifiedRow(v) },
    myRole: m.role,
    members: m.role === 'manager' ? members : members.map((x) => ({ id: x.id, name: x.name, role: x.role, me: x.me })),
    invites, seats: seatInfo(m),
    roles: Object.keys(O.ORG_ROLES).map(roleView)
  });
}));

router.patch('/', buyerOnly, wrap(async (req, res) => {
  const m = manager(req);
  const b = req.body || {};
  const db = getDB();
  if (b.name !== undefined) {
    const name = clip(b.name, 120);
    if (name.length < 3) throw E.validation('اسم الجهة قصير جداً.');
    db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, m.org_id);
  }
  if (b.requireApproval !== undefined) db.prepare('UPDATE organizations SET require_approval = ? WHERE id = ?').run(b.requireApproval ? 1 : 0, m.org_id);
  audit({ action: 'org_update', entity: 'organization', entityId: m.org_id, userId: req.user.id, ip: req.ip, detail: { name: b.name, requireApproval: b.requireApproval } });
  res.json({ ok: true });
}));

router.post('/invites', buyerOnly, wrap(async (req, res) => {
  const m = manager(req);
  const role = clip(req.body?.role, 20);
  if (!O.ORG_ROLES[role]) throw E.validation('اختر دوراً صحيحاً للعضو.');
  const seats = seatInfo(m);
  if (seats.max !== null && seats.used >= seats.max) {
    throw E.forbidden('بلغت حد المستخدمين في باقتك (' + seats.max + '). رقِّ الباقة من صفحة الاشتراك لإضافة أعضاء.');
  }
  const code = newCode();
  const id = uid('inv_');
  getDB().prepare('INSERT INTO org_invites (id, org_id, label, role, code_hash, created_by, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, m.org_id, clip(req.body?.label, 80) || null, role, hashCode(code), req.user.id, Math.floor(Date.now() / 1000) + 14 * 86400);
  audit({ action: 'org_invite', entity: 'org_invite', entityId: id, userId: req.user.id, ip: req.ip, detail: { role } });
  res.status(201).json({ code, invite: { id, role }, message: 'أرسل هذا الرمز للعضو بوسيلة آمنة. يظهر مرة واحدة فقط وصالح 14 يوماً.' });
}));

router.delete('/invites/:id', buyerOnly, wrap(async (req, res) => {
  const m = manager(req);
  const r = getDB().prepare("UPDATE org_invites SET status = 'revoked' WHERE id = ? AND org_id = ? AND status = 'pending'").run(req.params.id, m.org_id);
  if (!r.changes) throw E.notFound('الدعوة غير موجودة.');
  res.json({ ok: true });
}));

router.patch('/members/:userId', buyerOnly, wrap(async (req, res) => {
  const m = manager(req);
  const role = clip(req.body?.role, 20);
  if (!O.ORG_ROLES[role]) throw E.validation('اختر دوراً صحيحاً.');
  const db = getDB();
  const t = db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(m.org_id, req.params.userId);
  if (!t) throw E.notFound('العضو غير موجود.');
  if (t.user_id === m.created_by && role !== 'manager') throw E.conflict('صاحب الاشتراك يبقى مديراً للجهة.');
  db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?').run(role, m.org_id, t.user_id);
  audit({ action: 'org_member_role', entity: 'org_member', entityId: t.user_id, userId: req.user.id, ip: req.ip, detail: { role } });
  res.json({ ok: true });
}));

router.delete('/members/:userId', buyerOnly, wrap(async (req, res) => {
  const m = manager(req);
  const db = getDB();
  const t = db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(m.org_id, req.params.userId);
  if (!t) throw E.notFound('العضو غير موجود.');
  if (t.user_id === m.created_by) throw E.conflict('لا يمكن إزالة صاحب الاشتراك.');
  db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(m.org_id, t.user_id);
  audit({ action: 'org_member_remove', entity: 'org_member', entityId: t.user_id, userId: req.user.id, ip: req.ip });
  res.json({ ok: true });
}));

/* الانضمام لجهة برمز دعوة */
router.post('/join', buyerOnly, wrap(async (req, res) => {
  const db = getDB();
  const code = clip(req.body?.code, 30);
  if (code.replace(/[^A-Za-z0-9]/g, '').length < 8) throw E.validation('أدخل رمز الدعوة كاملاً.');
  const inv = db.prepare("SELECT * FROM org_invites WHERE code_hash = ? AND status = 'pending'").get(hashCode(code));
  if (!inv || inv.expires_at <= Math.floor(Date.now() / 1000)) throw E.notFound('رمز الدعوة غير صحيح أو منتهي.');
  const mine = O.ensureOrg(req.user);
  if (mine.org_id === inv.org_id) throw E.conflict('أنت عضو في هذه الجهة بالفعل.');
  const memberCount = db.prepare('SELECT COUNT(*) n FROM org_members WHERE org_id = ?').get(mine.org_id).n;
  const reqCount = db.prepare('SELECT COUNT(*) n FROM project_requests WHERE org_id = ?').get(mine.org_id).n;
  if (memberCount > 1 || reqCount > 0) throw E.conflict('حسابك يدير جهة فيها أعضاء أو طلبات. استخدم حساباً جديداً للانضمام.');
  const target = db.prepare('SELECT * FROM organizations WHERE id = ?').get(inv.org_id);
  if (!target) throw E.notFound('الجهة غير موجودة.');
  const seats = seatInfo({ org_id: target.id, created_by: target.created_by });
  // الدعوة نفسها محسوبة ضمن المقاعد، فالتحقق على الأعضاء الفعليين فقط
  if (seats.max !== null && seats.members >= seats.max) throw E.forbidden('اكتمل عدد المستخدمين في باقة هذه الجهة.');
  db.transaction(() => {
    db.prepare('UPDATE tenders SET org_id = ? WHERE user_id = ?').run(target.id, req.user.id);
    db.prepare('UPDATE org_verifications SET org_id = NULL WHERE user_id = ? AND org_id = ?').run(req.user.id, mine.org_id);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(mine.org_id);
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').run(target.id, req.user.id, inv.role);
    db.prepare("UPDATE org_invites SET status = 'used', used_by = ? WHERE id = ?").run(req.user.id, inv.id);
  })();
  audit({ action: 'org_join', entity: 'organization', entityId: target.id, userId: req.user.id, ip: req.ip, detail: { role: inv.role } });
  res.json({ ok: true, org: { id: target.id, name: target.name }, role: inv.role, message: 'انضممت إلى ' + target.name });
}));

module.exports = router;
