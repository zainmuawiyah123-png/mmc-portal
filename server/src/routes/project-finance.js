'use strict';
/**
 * Project award / PO / invoice / payment workflow.
 * Completely separate from MMC subscription billing.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const S = require('../lib/storage');
const { getDB, uid } = require('../db');
const { E, wrap } = require('../lib/errors');
const A = require('../lib/auth');
const O = require('../lib/org');

const router = express.Router();
router.use(A.requireAuth);
const db = () => getDB();
const clip = (v, n = 2000) => String(v == null ? '' : v).trim().slice(0, n);
const amount = (v, field) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) !== n * 100) throw E.validation('قيمة غير صحيحة: ' + field);
  return Math.round(n * 100) / 100;
};
function member(req) {
  if (req.user.role !== 'buyer') throw E.forbidden('هذا الإجراء متاح لأعضاء الجهة المشترية فقط.');
  const m = O.ensureOrg(req.user);
  if (!m) throw E.forbidden();
  return m;
}
function requireOrg(req, roles) {
  const m = member(req);
  if (!roles.includes(m.role)) throw E.forbidden('ليس لديك صلاحية هذا الإجراء.');
  return m;
}
function event(data) {
  db().prepare(`INSERT INTO project_audit_events
    (id,org_id,tender_id,award_id,po_id,invoice_id,payment_id,actor_user_id,actor_role,action,from_status,to_status,detail_json,ip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uid('pae_'), data.orgId, data.tenderId || null, data.awardId || null,
    data.poId || null, data.invoiceId || null, data.paymentId || null,
    data.userId || null, data.role || null, data.action,
    data.from || null, data.to || null, data.detail ? JSON.stringify(data.detail).slice(0, 4000) : null,
    data.ip || null
  );
}
function awardForOrg(id, orgId) {
  const a = db().prepare('SELECT * FROM project_awards WHERE id=? AND org_id=?').get(id, orgId);
  if (!a) throw E.notFound('الترسية غير موجودة.');
  return a;
}
function poForOrg(id, orgId) {
  const p = db().prepare('SELECT p.*, a.contractor_user_id, a.tender_id, a.awarded_amount FROM purchase_orders p JOIN project_awards a ON a.id=p.award_id WHERE p.id=? AND p.org_id=?').get(id, orgId);
  if (!p) throw E.notFound('أمر الشراء غير موجود.');
  return p;
}
const FINANCE_READ_ROLES = ['manager', 'procurement', 'requester', 'finance'];
function invoiceFor(req, id) {
  const row = db().prepare(`SELECT i.*, p.status po_status, p.total_amount po_total, p.requires_owner_confirmation, a.contractor_user_id, a.tender_id
    FROM project_invoices i JOIN purchase_orders p ON p.id=i.po_id
    JOIN project_awards a ON a.id=i.award_id WHERE i.id=?`).get(id);
  if (!row) throw E.notFound('الفاتورة غير موجودة.');
  if (req.user.role === 'contractor') {
    if (row.contractor_user_id !== req.user.id) throw E.notFound('الفاتورة غير موجودة.');
  } else {
    const m = member(req);
    if (!FINANCE_READ_ROLES.includes(m.role) || m.org_id !== row.org_id) throw E.notFound('الفاتورة غير موجودة.');
  }
  return row;
}
function insertItems(table, parentColumn, parentId, items) {
  if (!Array.isArray(items) || !items.length || items.length > 300) throw E.validation('أدخل بنوداً صحيحة.');
  const ins = db().prepare(`INSERT INTO ${table} (id,${parentColumn},${table === 'purchase_order_items' ? 'line_no,' : ''}description,quantity,unit_price,line_total${table === 'purchase_order_items' ? ',unit' : ',po_item_id'}) VALUES (${table === 'purchase_order_items' ? '?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?'})`);
  let total = 0;
  items.forEach((x, i) => {
    const q = amount(x.quantity, 'quantity');
    const price = Number(x.unitPrice);
    if (!Number.isFinite(price) || price < 0 || Math.round(price * 100) !== price * 100) throw E.validation('سعر بند غير صحيح.');
    const line = Math.round(q * price * 100) / 100;
    total += line;
    if (table === 'purchase_order_items') ins.run(uid('poi_'), parentId, i + 1, clip(x.description, 1000), q, price, line, clip(x.unit, 40) || null);
    else ins.run(uid('pii_'), parentId, clip(x.description, 1000), q, price, line, x.poItemId || null);
  });
  return Math.round(total * 100) / 100;
}

/* Register an award only against a submitted, technically qualified and financially opened bid. */
router.post('/awards', wrap(async (req, res) => {
  const m = requireOrg(req, ['manager', 'procurement']);
  const b = req.body || {};
  const tender = db().prepare('SELECT * FROM tenders WHERE id=? AND org_id=?').get(clip(b.tenderId, 100), m.org_id);
  if (!tender) throw E.notFound('العطاء غير موجود ضمن جهتك.');
  if (tender.procurement_status !== 'published' && tender.procurement_status !== 'closed') throw E.conflict('العطاء غير مؤهل للترسية.');
  const submission = db().prepare(`SELECT s.*, u.role contractor_role FROM bid_submissions s
    JOIN users u ON u.id=s.contractor_id WHERE s.id=? AND s.tender_id=?`).get(clip(b.submissionId, 100), tender.id);
  if (!submission || submission.contractor_role !== 'contractor' || submission.status !== 'evaluated' || !submission.technical_passed || !submission.financial_unlocked || !(Number(submission.financial_amount) > 0)) throw E.validation('العرض المحدد غير مؤهل للترسية.');
  if (db().prepare('SELECT 1 FROM project_awards WHERE tender_id=? AND status=\'approved\'').get(tender.id)) throw E.conflict('سبق تسجيل ترسية معتمدة لهذا العطاء.');
  const value = amount(b.awardedAmount, 'awardedAmount');
  const currency = clip(b.currency, 3).toUpperCase() || submission.financial_currency;
  if (currency !== submission.financial_currency || value > Number(submission.financial_amount)) throw E.validation('قيمة الترسية وعملتها يجب أن تتوافقا مع العرض المالي الفائز.');
  const id = uid('awd_');
  db().transaction(() => {
    db().prepare(`INSERT INTO project_awards
      (id,tender_id,org_id,contractor_user_id,award_reference,contract_reference,currency,awarded_amount,awarded_by,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, tender.id, m.org_id, submission.contractor_id,
      clip(b.awardReference, 100) || id, clip(b.contractReference, 100) || null,
      currency, value, req.user.id, clip(b.notes, 2000) || null);
    event({ orgId:m.org_id,tenderId:tender.id,awardId:id,userId:req.user.id,role:m.role,action:'award_registered',to:'approved',detail:{submissionId:submission.id,awardedAmount:value},ip:req.ip });
  })();
  res.status(201).json({ award: db().prepare('SELECT * FROM project_awards WHERE id=?').get(id) });
}));

router.get('/awards', wrap(async (req, res) => {
  if (req.user.role === 'contractor') {
    const rows = db().prepare(`SELECT a.*, t.name tender_name FROM project_awards a JOIN tenders t ON t.id=a.tender_id WHERE a.contractor_user_id=? ORDER BY a.awarded_at DESC`).all(req.user.id);
    return res.json({ awards: rows });
  }
  const m = requireOrg(req, FINANCE_READ_ROLES);
  res.json({ awards: db().prepare(`SELECT a.*,t.name tender_name FROM project_awards a JOIN tenders t ON t.id=a.tender_id WHERE a.org_id=? ORDER BY a.awarded_at DESC`).all(m.org_id) });
}));

router.post('/awards/:id/purchase-orders', wrap(async (req, res) => {
  const m = requireOrg(req, ['manager', 'procurement']);
  const a = awardForOrg(req.params.id, m.org_id);
  const b = req.body || {};
  const poNumber = clip(b.poNumber, 80);
  if (!poNumber) throw E.validation('رقم أمر الشراء مطلوب.');
  const id = uid('po_');
  const items = Array.isArray(b.items) ? b.items : [];
  const total = items.reduce((s,x) => s + Math.round(amount(x.quantity,'quantity') * Number(x.unitPrice) * 100) / 100, 0);
  const rounded = Math.round(total * 100) / 100;
  if (!items.length || !Number.isFinite(rounded) || rounded <= 0) throw E.validation('أدخل بنود أمر شراء صحيحة.');
  db().transaction(() => {
    const committed = db().prepare("SELECT COALESCE(SUM(total_amount),0) n FROM purchase_orders WHERE award_id=? AND status NOT IN ('cancelled','void')").get(a.id).n;
    if (committed + rounded > Number(a.awarded_amount) + 0.0001) throw E.validation('إجمالي أوامر الشراء لا يجوز أن يتجاوز قيمة الترسية المتبقية.');
    const poCurrency = clip(b.currency,3).toUpperCase() || a.currency;
  if (poCurrency !== a.currency) throw E.validation('عملة أمر الشراء يجب أن تطابق عملة الترسية.');
  db().prepare("INSERT INTO purchase_orders (id,award_id,org_id,po_number,currency,total_amount,status,payment_terms,delivery_start,delivery_end,created_by,requires_owner_confirmation) VALUES (?,?,?,?,?,?,'pending_approval',?,?,?,?,?)").run(id,a.id,m.org_id,poNumber,poCurrency,rounded,clip(b.paymentTerms,1000)||null,clip(b.deliveryStart,30)||null,clip(b.deliveryEnd,30)||null,req.user.id,b.requiresOwnerConfirmation === false ? 0 : 1);
    const insertedTotal = insertItems('purchase_order_items','po_id',id,items);
    if (insertedTotal !== rounded) throw E.validation('إجمالي بنود أمر الشراء غير متطابق مع القيمة المحسوبة.');
    event({orgId:m.org_id,tenderId:a.tender_id,awardId:a.id,poId:id,userId:req.user.id,role:m.role,action:'po_submitted_for_approval',to:'pending_approval',detail:{total:rounded},ip:req.ip});
  }).immediate();
  res.status(201).json({ purchaseOrder: db().prepare('SELECT * FROM purchase_orders WHERE id=?').get(id) });
}));

router.post('/purchase-orders/:id/approve', wrap(async (req,res)=>{
  const m=requireOrg(req,['manager']);
  const p=poForOrg(req.params.id,m.org_id);
  if(p.status!=='pending_approval') throw E.conflict('أمر الشراء ليس بانتظار الاعتماد.');
  db().transaction(()=>{
    db().prepare("UPDATE purchase_orders SET status='approved',approved_by=?,approved_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(req.user.id,p.id);
    event({orgId:m.org_id,tenderId:p.tender_id,awardId:p.award_id,poId:p.id,userId:req.user.id,role:m.role,action:'po_approved',from:p.status,to:'approved',ip:req.ip});
  })();
  res.json({ok:true,status:'approved'});
}));
router.post('/purchase-orders/:id/issue', wrap(async(req,res)=>{
  const m=requireOrg(req,['manager','procurement']);
  const p=poForOrg(req.params.id,m.org_id);
  if(p.status!=='approved') throw E.conflict('لا يمكن إرسال أمر شراء غير معتمد.');
  db().transaction(()=>{
    db().prepare("UPDATE purchase_orders SET status='issued',issued_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(p.id);
    event({orgId:m.org_id,tenderId:p.tender_id,awardId:p.award_id,poId:p.id,userId:req.user.id,role:m.role,action:'po_issued',from:p.status,to:'issued',ip:req.ip});
  })();
  res.json({ok:true,status:'issued'});
}));
router.get('/purchase-orders',wrap(async(req,res)=>{
  if(req.user.role==='contractor') return res.json({purchaseOrders:db().prepare("SELECT p.*,a.tender_id FROM purchase_orders p JOIN project_awards a ON a.id=p.award_id WHERE a.contractor_user_id=? AND p.status='issued' ORDER BY p.created_at DESC").all(req.user.id)});
  const m=requireOrg(req,FINANCE_READ_ROLES);
  res.json({purchaseOrders:db().prepare('SELECT * FROM purchase_orders WHERE org_id=? ORDER BY created_at DESC').all(m.org_id)});
}));

router.post('/purchase-orders/:id/invoices',wrap(async(req,res)=>{
  if(req.user.role!=='contractor') throw E.forbidden('رفع فواتير المشروع متاح للمقاول الفائز فقط.');
  const p=db().prepare("SELECT p.*,a.contractor_user_id,a.tender_id,a.awarded_amount FROM purchase_orders p JOIN project_awards a ON a.id=p.award_id WHERE p.id=? AND a.contractor_user_id=?").get(req.params.id,req.user.id);
  if(!p||p.status!=='issued') throw E.notFound('أمر الشراء غير متاح.');
  const b=req.body||{};
  if (!clip(b.invoiceNumber,80)) throw E.validation('رقم الفاتورة مطلوب.');
  const items=Array.isArray(b.items)?b.items:[];
  const total=Math.round(items.reduce((s,x)=>s+Math.round(Number(x.quantity)*Number(x.unitPrice)*100)/100,0)*100)/100;
  if(!items.length||!Number.isFinite(total)||total<=0) throw E.validation('أدخل بنود الفاتورة بصورة صحيحة.');
  const type=['materials','progress','final'].includes(b.invoiceType)?b.invoiceType:null;
  if(!type) throw E.validation('حدد نوع الفاتورة.');
  const id=uid('pin_');
  // Serialize invoice submissions and perform the remaining-PO check in the
  // same IMMEDIATE transaction as the insert, so concurrent requests cannot
  // both consume the same remaining balance.
  db().transaction(()=>{
    const current=db().prepare("SELECT total_amount,status FROM purchase_orders WHERE id=? AND status='issued'").get(p.id);
    if(!current) throw E.conflict('أمر الشراء لم يعد متاحاً لإصدار فاتورة.');
    const invoiced=db().prepare("SELECT COALESCE(SUM(gross_amount),0) n FROM project_invoices WHERE po_id=? AND status NOT IN ('void','rejected')").get(p.id).n;
    if(invoiced+total>Number(current.total_amount)+0.0001) throw E.conflict('قيمة الفواتير تتجاوز الرصيد المتبقي من أمر الشراء.');
    db().prepare(`INSERT INTO project_invoices (id,po_id,award_id,org_id,contractor_user_id,invoice_number,invoice_type,currency,gross_amount,contractor_note)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,p.id,p.award_id,p.org_id,req.user.id,clip(b.invoiceNumber,80),type,p.currency,total,clip(b.note,2000)||null);
    const insertedTotal = insertItems('project_invoice_items','invoice_id',id,items);
    if (insertedTotal !== total) throw E.validation('إجمالي بنود الفاتورة غير متطابق مع القيمة المحسوبة.');
    event({orgId:p.org_id,tenderId:p.tender_id,awardId:p.award_id,poId:p.id,invoiceId:id,userId:req.user.id,role:'contractor',action:'invoice_submitted',to:'submitted',detail:{grossAmount:total,type},ip:req.ip});
  }).immediate();
  res.status(201).json({invoice:db().prepare('SELECT * FROM project_invoices WHERE id=?').get(id)});
}));


/* Contractor may revise and resubmit an invoice returned by procurement/owner. */
router.post('/invoices/:id/resubmit',wrap(async(req,res)=>{
  if(req.user.role!=='contractor') throw E.forbidden('إعادة تقديم الفاتورة متاحة للمقاول فقط.');
  const i=invoiceFor(req,req.params.id);
  if(i.status!=='returned') throw E.conflict('يمكن إعادة تقديم الفاتورة بعد إعادتها فقط.');
  const b=req.body||{};
  const invoiceNumber=clip(b.invoiceNumber,80)||i.invoice_number;
  const type=['materials','progress','final'].includes(b.invoiceType)?b.invoiceType:i.invoice_type;
  const items=Array.isArray(b.items)?b.items:[];
  if(!items.length) throw E.validation('أدخل بنود الفاتورة المعدلة.');
  const total=Math.round(items.reduce((sum,x)=>sum+Math.round(amount(x.quantity,'quantity')*Number(x.unitPrice)*100)/100,0)*100)/100;
  if(!Number.isFinite(total)||total<=0) throw E.validation('قيمة الفاتورة المعدلة غير صحيحة.');
  // Recheck invoice state and aggregate under a write-reserving transaction.
  // This serializes resubmissions against both new invoices and other resubmissions.
  db().transaction(()=>{
    const current=db().prepare("SELECT i.status,i.po_id,p.total_amount FROM project_invoices i JOIN purchase_orders p ON p.id=i.po_id WHERE i.id=? AND i.contractor_user_id=?").get(i.id,req.user.id);
    if(!current || current.status!=='returned') throw E.conflict('لم تعد الفاتورة بانتظار إعادة التقديم.');
    const other=db().prepare("SELECT COALESCE(SUM(gross_amount),0) n FROM project_invoices WHERE po_id=? AND id<>? AND status NOT IN ('void','rejected')").get(current.po_id,i.id).n;
    if(other+total>Number(current.total_amount)+0.0001) throw E.conflict('إجمالي الفواتير يتجاوز قيمة أمر الشراء.');
    db().prepare("DELETE FROM project_invoice_items WHERE invoice_id=?").run(i.id);
    const inserted=insertItems('project_invoice_items','invoice_id',i.id,items);
    if(inserted!==total) throw E.validation('إجمالي بنود الفاتورة غير متطابق.');
    db().prepare("UPDATE project_invoices SET invoice_number=?,invoice_type=?,gross_amount=?,contractor_note=?,status='submitted',submitted_at=unixepoch(),updated_at=unixepoch() WHERE id=?")
      .run(invoiceNumber,type,total,clip(b.note,2000)||null,i.id);
    event({orgId:i.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,userId:req.user.id,role:'contractor',action:'invoice_resubmitted',from:i.status,to:'submitted',detail:{grossAmount:total},ip:req.ip});
  }).immediate();
  res.json({ok:true,status:'submitted',invoice:db().prepare('SELECT * FROM project_invoices WHERE id=?').get(i.id)});
}));

router.get('/invoices',wrap(async(req,res)=>{
  if(req.user.role==='contractor') return res.json({invoices:db().prepare('SELECT * FROM project_invoices WHERE contractor_user_id=? ORDER BY submitted_at DESC').all(req.user.id)});
  const m=requireOrg(req,FINANCE_READ_ROLES);
  res.json({invoices:db().prepare('SELECT * FROM project_invoices WHERE org_id=? ORDER BY submitted_at DESC').all(m.org_id)});
}));
router.get('/invoices/:id',wrap(async(req,res)=>{
  const i=invoiceFor(req,req.params.id);
  const rows=db().prepare('SELECT * FROM project_invoice_items WHERE invoice_id=?').all(i.id);
  const reviews=db().prepare('SELECT reviewer_role,decision,note,created_at FROM project_invoice_reviews WHERE invoice_id=? ORDER BY created_at').all(i.id);
  const payments=db().prepare('SELECT amount,currency,payment_reference,payment_date,created_at FROM project_payments WHERE invoice_id=? ORDER BY payment_date').all(i.id);
  const paid=payments.reduce((s,p)=>s+Number(p.amount),0);
  res.json({invoice:i,items:rows,reviews,payments,paid,remaining:Math.max(0,Number(i.gross_amount)-Number(i.retention_amount)-paid)});
}));

function review(req, invoice, role, decision, note) {
  const id=uid('rev_');
  db().prepare('INSERT INTO project_invoice_reviews (id,invoice_id,reviewer_user_id,reviewer_role,decision,note) VALUES (?,?,?,?,?,?)').run(id,invoice.id,req.user.id,role,decision,note||null);
}
router.post('/invoices/:id/procurement-review',wrap(async(req,res)=>{
  const m=requireOrg(req,['manager','procurement']); const i=invoiceFor(req,req.params.id);
  if(!['submitted','returned'].includes(i.status)) throw E.conflict('الفاتورة ليست بانتظار مراجعة المشتريات.');
  const decision=req.body?.decision;
  if(!['accepted','returned','rejected'].includes(decision)) throw E.validation('قرار المراجعة غير صحيح.');
  const note=clip(req.body?.note,2000); if(decision!=='accepted'&&!note) throw E.validation('سبب الإعادة أو الرفض إلزامي.');
  const next=decision==='accepted'?(i.requires_owner_confirmation?'owner_confirmation':'finance_queue'):decision==='returned'?'returned':'rejected';
  db().transaction(()=>{review(req,i,m.role,decision,note);db().prepare('UPDATE project_invoices SET status=?,updated_at=unixepoch() WHERE id=?').run(next,i.id);event({orgId:m.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,userId:req.user.id,role:m.role,action:'procurement_'+decision,from:i.status,to:next,detail:{note},ip:req.ip});})();
  res.json({ok:true,status:next});
}));
router.post('/invoices/:id/owner-confirmation',wrap(async(req,res)=>{
  const m=requireOrg(req,['manager','requester']); const i=invoiceFor(req,req.params.id);
  if(i.status!=='owner_confirmation') throw E.conflict('الفاتورة ليست بانتظار تأكيد المالك.');
  const decision=req.body?.decision; if(!['confirmed','returned'].includes(decision)) throw E.validation('قرار التأكيد غير صحيح.');
  const note=clip(req.body?.note,2000); if(decision==='returned'&&!note) throw E.validation('سبب الإعادة إلزامي.');
  const next=decision==='confirmed'?'finance_queue':'returned';
  db().transaction(()=>{review(req,i,m.role,decision,note);db().prepare('UPDATE project_invoices SET status=?,updated_at=unixepoch() WHERE id=?').run(next,i.id);event({orgId:m.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,userId:req.user.id,role:m.role,action:'owner_'+decision,from:i.status,to:next,detail:{note},ip:req.ip});})();
  res.json({ok:true,status:next});
}));
router.post('/invoices/:id/forward-to-finance',wrap(async(req,res)=>{
  const m=requireOrg(req,['manager','procurement','requester']);const i=invoiceFor(req,req.params.id);
  if(i.status!=='finance_queue') throw E.conflict('لا يمكن الإحالة قبل اكتمال التدقيق المطلوب.');
  db().transaction(()=>{review(req,i,m.role,'forwarded',clip(req.body?.note,1000));db().prepare("UPDATE project_invoices SET status='finance_review',updated_at=unixepoch() WHERE id=?").run(i.id);event({orgId:m.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,userId:req.user.id,role:m.role,action:'forwarded_to_finance',from:i.status,to:'finance_review',ip:req.ip});})();
  res.json({ok:true,status:'finance_review'});
}));
router.post('/invoices/:id/finance-approval',wrap(async(req,res)=>{
  const m=requireOrg(req,['manager','finance']);const i=invoiceFor(req,req.params.id);
  if(i.status!=='finance_review') throw E.conflict('الفاتورة لم تستكمل مراجعة المشتريات والمالك.');
  db().transaction(()=>{review(req,i,m.role,'approved',clip(req.body?.note,1000));db().prepare("UPDATE project_invoices SET status='approved_for_payment',updated_at=unixepoch() WHERE id=?").run(i.id);event({orgId:m.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,userId:req.user.id,role:m.role,action:'finance_approved',from:i.status,to:'approved_for_payment',ip:req.ip});})();
  res.json({ok:true,status:'approved_for_payment'});
}));
router.post('/invoices/:id/payments',wrap(async(req,res)=>{
  const m=requireOrg(req,['manager','finance']);const i=invoiceFor(req,req.params.id);
  const value=amount(req.body?.amount,'payment amount');
  const ref=clip(req.body?.paymentReference,100);const date=clip(req.body?.paymentDate,20);
  if(!ref||!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw E.validation('مرجع الدفع وتاريخه مطلوبان.');
  const id=uid('pay_');
  // Check the current balance inside the same SQLite transaction as the insert.
  // This prevents two simultaneous payment requests from both spending the same balance.
  db().transaction(()=>{
    const current=db().prepare('SELECT status,gross_amount,retention_amount FROM project_invoices WHERE id=?').get(i.id);
    if(!current||!['approved_for_payment','part_paid'].includes(current.status)) throw E.conflict('لا يمكن تسجيل دفعة قبل اعتماد المالية.');
    const paid=db().prepare('SELECT COALESCE(SUM(amount),0) n FROM project_payments WHERE invoice_id=?').get(i.id).n;
    const remaining=Math.round((Number(current.gross_amount)-Number(current.retention_amount)-paid)*100)/100;
    if(value>remaining+0.0001) throw E.conflict('قيمة الدفعة تتجاوز الرصيد المستحق.');
    db().prepare('INSERT INTO project_payments (id,invoice_id,org_id,amount,currency,payment_reference,payment_date,recorded_by) VALUES (?,?,?,?,?,?,?,?)').run(id,i.id,m.org_id,value,i.currency,ref,date,req.user.id);
    const newPaid=paid+value;const next=newPaid>=Number(current.gross_amount)-Number(current.retention_amount)-0.0001?'paid':'part_paid';
    db().prepare('UPDATE project_invoices SET status=?,updated_at=unixepoch() WHERE id=?').run(next,i.id);
    event({orgId:m.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,paymentId:id,userId:req.user.id,role:m.role,action:'payment_recorded',from:current.status,to:next,detail:{amount:value,reference:ref,date},ip:req.ip});
  }).immediate();
  res.status(201).json({ok:true,payment:db().prepare('SELECT * FROM project_payments WHERE id=?').get(id)});
}));

const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_BYTES, files: 5 },
  fileFilter: (req, file, cb) => {
    try { S.assertAllowed(file.originalname, file.size || 0); cb(null, true); }
    catch (err) { cb(err); }
  }
});
router.post('/invoices/:id/documents', invoiceUpload.array('files', 5), wrap(async (req,res)=>{
  if(req.user.role!=='contractor') throw E.forbidden('إرفاق مستندات الفاتورة متاح للمقاول فقط.');
  const i=invoiceFor(req,req.params.id);
  if(!['submitted','returned'].includes(i.status)) throw E.conflict('لا يمكن تعديل مستندات فاتورة بعد بدء مراجعتها.');
  const files=req.files||[];
  if(!files.length) throw E.validation('أرفق ملفاً واحداً على الأقل.');
  const store=S.getStorage(), inserted=[];
  for(const f of files){
    const key=S.buildKey(req.user.id,i.id,S.makeStoredName(f.originalname));
    const put=await store.put(key,f.buffer,{mime:f.mimetype||'application/octet-stream',originalName:S.displayName(f.originalname)});
    const id=uid('pidoc_');
    db().prepare('INSERT INTO project_invoice_documents (id,invoice_id,storage_key,storage_driver,original_name,mime,size,checksum,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,i.id,key,store.DRIVER,S.displayName(f.originalname),f.mimetype||'application/octet-stream',f.size,put.checksum,req.user.id);
    inserted.push({id,name:S.displayName(f.originalname),size:f.size});
    event({orgId:i.org_id,tenderId:i.tender_id,awardId:i.award_id,poId:i.po_id,invoiceId:i.id,userId:req.user.id,role:'contractor',action:'invoice_document_uploaded',detail:{documentId:id,size:f.size},ip:req.ip});
  }
  res.status(201).json({documents:inserted});
}));
router.get('/invoices/:id/documents',wrap(async(req,res)=>{
  const i=invoiceFor(req,req.params.id);
  const rows=db().prepare('SELECT id,original_name name,mime,size,uploaded_at FROM project_invoice_documents WHERE invoice_id=? ORDER BY uploaded_at').all(i.id);
  res.json({documents:rows});
}));
router.get('/invoice-documents/:id/download',wrap(async(req,res)=>{
  const d=db().prepare('SELECT d.*,i.org_id,i.contractor_user_id FROM project_invoice_documents d JOIN project_invoices i ON i.id=d.invoice_id WHERE d.id=?').get(req.params.id);
  if(!d) throw E.notFound('المستند غير موجود.');
  if(req.user.role==='contractor'){
    if(d.contractor_user_id!==req.user.id) throw E.notFound('المستند غير موجود.');
  }else{
    const m=member(req);
    if(m.org_id!==d.org_id) throw E.notFound('المستند غير موجود.');
  }
  const store=d.storage_driver==='s3'?require('../lib/storage/s3'):require('../lib/storage/local');
  if(!(await store.exists(d.storage_key))) throw E.notFound('ملف المستند غير موجود في التخزين.');
  res.setHeader('Content-Type',d.mime||'application/octet-stream');
  res.setHeader('Content-Disposition','attachment; filename*=UTF-8\'\''+encodeURIComponent(d.original_name));
  res.setHeader('Cache-Control','private, no-store');
  store.stream(d.storage_key).pipe(res);
}));

module.exports=router;
