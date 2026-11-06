'use strict';
/**
 * ربط الفوترة الوطنية الأردنية (JoFotara — دائرة ضريبة الدخل والمبيعات) لفواتير اشتراكات MMC.
 *
 * العقد المؤكد من الدليل الفني المنشور: POST إلى JOFOTARA_URL برأسَي Client-Id وSecret-Key
 * وجسم JSON فيه مفتاح واحد invoice = ملف UBL 2.1 XML بترميز Base64.
 *
 * تحذير صريح: ملف XML هنا مسودة أولى مبنية على UBL 2.1 وما نُشر عن ملف الأردن (رمز نوع الفاتورة بثلاثة أرقام،
 * ICV متسلسل، تسلسل مصدر الدخل، فئات الضريبة S/O/Z). لم يُتحقق منها أمام بيئة ISTD التجريبية، وقد ترفضها المنصة
 * عند أول تجربة. يعالج النظام ذلك: يحفظ رد المنصة كاملاً ليُصحَّح الملف بدقة، ولا يتعطل اعتماد الدفع أبداً بسبب فشل الإرسال.
 */
const crypto = require('crypto');
const config = require('../config');
const { getDB } = require('../db');
const O = require('./org');

const MAX_ATTEMPTS = 5;
const NS = 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const r3 = (n) => Math.round(n * 1000) / 1000;
const f3 = (n) => r3(n).toFixed(3);

const enabled = () => config.EINVOICE.enabled;
function missingConfig() {
  const c = config.EINVOICE, m = [];
  if (!c.clientId) m.push('JOFOTARA_CLIENT_ID');
  if (!c.secretKey) m.push('JOFOTARA_SECRET_KEY');
  if (!c.sellerTin || c.sellerTin.length < 8 || c.sellerTin.length > 12 || /^(\d)\1+$/.test(c.sellerTin)) m.push('EINVOICE_SELLER_TIN (8–12 رقماً)');
  if (!c.sellerName) m.push('EINVOICE_SELLER_NAME');
  return m;
}

/** يحوّل مبلغ الفاتورة إلى دينار ثم يفصل الضريبة (الأسعار شاملة الضريبة افتراضياً — قرار يؤكده المحاسب) */
function amounts(inv) {
  const c = config.EINVOICE, rate = c.vatRate / 100;
  const usd = inv.currency === 'USD' ? inv.amount : inv.amount / (O.PEG[inv.currency] || 1);
  const gross = inv.currency === 'JOD' ? inv.amount : O.convertUsd(usd, 'JOD');
  let net, tax;
  if (c.pricesIncludeTax) { net = r3(gross / (1 + rate)); tax = r3(gross - net); } else { net = r3(gross); tax = r3(net * rate); }
  return { net, tax, total: r3(net + tax), rate: c.vatRate };
}

function buildInvoiceXml(ctx) {
  const c = config.EINVOICE, a = ctx.amounts;
  const cur = 'JOD';
  const buyerId = ctx.buyer.taxNumber ? `<cac:PartyIdentification><cbc:ID schemeID="TN">${esc(ctx.buyer.taxNumber)}</cbc:ID></cac:PartyIdentification>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice ${NS}>
<cbc:ID>${esc(ctx.invoiceNumber)}</cbc:ID>
<cbc:UUID>${esc(ctx.uuid)}</cbc:UUID>
<cbc:IssueDate>${esc(ctx.issueDate)}</cbc:IssueDate>
<cbc:InvoiceTypeCode name="${esc(c.typeName)}">388</cbc:InvoiceTypeCode>
<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
<cbc:TaxCurrencyCode>${cur}</cbc:TaxCurrencyCode>
<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${esc(ctx.icv)}</cbc:UUID></cac:AdditionalDocumentReference>
<cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>${esc(c.sellerTin)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${esc(c.sellerName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party>${buyerId}<cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${esc(ctx.buyer.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
${c.incomeSource ? `<cac:SellerSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${esc(c.incomeSource)}</cbc:ID></cac:PartyIdentification></cac:Party></cac:SellerSupplierParty>` : ''}
<cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${f3(a.tax)}</cbc:TaxAmount></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${cur}">${f3(a.net)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${cur}">${f3(a.net)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${cur}">${f3(a.total)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="${cur}">${f3(a.total)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">1.000</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="${cur}">${f3(a.net)}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${f3(a.tax)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="${cur}">${f3(a.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${cur}">${f3(a.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${a.rate > 0 ? 'S' : 'O'}</cbc:ID><cbc:Percent>${a.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:Item><cbc:Name>${esc(ctx.itemName)}</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="${cur}">${f3(a.net)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`;
}

function loadContext(invoiceId, sub) {
  const db = getDB();
  const inv = db.prepare(`SELECT i.*, u.name user_name, u.company user_company, p.name_ar plan_name FROM invoices i JOIN users u ON u.id=i.user_id LEFT JOIN plans p ON p.key=i.plan_key WHERE i.id=?`).get(invoiceId);
  if (!inv) return null;
  const issue = new Date((inv.paid_at || inv.created_at) * 1000);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(issue);
  return { invoiceNumber: inv.invoice_number, uuid: sub.uuid, icv: sub.icv, issueDate: ymd,
    buyer: { name: inv.user_company || inv.user_name, taxNumber: inv.buyer_tax_number || '' },
    itemName: 'اشتراك منصة MMC — ' + (inv.plan_name || inv.plan_key) + (inv.billing_cycle === 'annual' ? ' (سنوي)' : ' (شهري)'),
    amounts: amounts(inv) };
}

/** ينشئ سجل الإرسال (ICV متسلسل) مرة واحدة لكل فاتورة */
function ensureSubmission(invoiceId) {
  const db = getDB();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM einvoice_submissions WHERE invoice_id=?').get(invoiceId);
    if (cur) return cur;
    const icv = (db.prepare('SELECT COALESCE(MAX(icv),0)+1 n FROM einvoice_submissions').get().n);
    db.prepare('INSERT INTO einvoice_submissions (invoice_id,icv,uuid) VALUES (?,?,?)').run(invoiceId, icv, crypto.randomUUID());
    return db.prepare('SELECT * FROM einvoice_submissions WHERE invoice_id=?').get(invoiceId);
  }).immediate();
}

async function send(xml) {
  const c = config.EINVOICE, ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(c.url, { method: 'POST', signal: ctl.signal,
      headers: { 'Client-Id': c.clientId, 'Secret-Key': c.secretKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }) });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, ok: res.ok, text: text.slice(0, 4000), body };
  } finally { clearTimeout(timer); }
}

/** يرسل فاتورة واحدة. لا يرمي أخطاء: يسجّل النتيجة في einvoice_submissions. */
async function submit(invoiceId) {
  const db = getDB();
  try {
    const miss = missingConfig();
    const sub = ensureSubmission(invoiceId);
    if (sub.status === 'accepted') return sub;
    if (miss.length) { db.prepare("UPDATE einvoice_submissions SET status='error', error=?, updated_at=unixepoch() WHERE invoice_id=?").run('إعدادات ناقصة: ' + miss.join('، '), invoiceId); return null; }
    const ctx = loadContext(invoiceId, sub);
    if (!ctx) return null;
    db.prepare('UPDATE einvoice_submissions SET attempts=attempts+1, updated_at=unixepoch() WHERE invoice_id=?').run(invoiceId);
    let r;
    try { r = await send(buildInvoiceXml(ctx)); }
    catch (e) { db.prepare("UPDATE einvoice_submissions SET status='error', error=?, updated_at=unixepoch() WHERE invoice_id=?").run('تعذر الاتصال: ' + String(e.message || e).slice(0, 200), invoiceId); return null; }
    const b = r.body || {};
    if (r.ok) db.prepare("UPDATE einvoice_submissions SET status='accepted', http_status=?, response=?, einv_number=?, qr=?, error=NULL, submitted_at=unixepoch(), updated_at=unixepoch() WHERE invoice_id=?").run(r.status, r.text, b.EINV_NUM || null, b.EINV_QR || null, invoiceId);
    else db.prepare('UPDATE einvoice_submissions SET status=?, http_status=?, response=?, error=?, updated_at=unixepoch() WHERE invoice_id=?').run(r.status >= 500 ? 'error' : 'rejected', r.status, r.text, ('رد المنصة ' + r.status + ': ' + r.text).slice(0, 500), invoiceId);
    return db.prepare('SELECT * FROM einvoice_submissions WHERE invoice_id=?').get(invoiceId);
  } catch (e) { console.error('[jofotara]', e.message); return null; }
}

/** عند اعتماد الدفع: يسجّل ويرسل في الخلفية دون انتظار */
function enqueue(invoiceId) {
  if (!enabled()) return;
  try { ensureSubmission(invoiceId); setImmediate(() => submit(invoiceId)); } catch (e) { console.error('[jofotara] enqueue:', e.message); }
}

/** يعيد محاولة الأخطاء المؤقتة (اتصال/5xx) فقط؛ الرفض 4xx يحتاج مراجعة بشرية */
async function processPending(limit = 20) {
  if (!enabled()) return { skipped: true };
  const rows = getDB().prepare(`SELECT invoice_id FROM einvoice_submissions WHERE status IN ('pending','error') AND attempts<? ORDER BY updated_at LIMIT ?`).all(MAX_ATTEMPTS, limit);
  let done = 0;
  for (const r of rows) { const s = await submit(r.invoice_id); if (s && s.status === 'accepted') done++; }
  return { tried: rows.length, accepted: done };
}

/** إعادة يدوية من المدير (بعد تصحيح الإعدادات أو بيانات المشتري) */
async function retry(invoiceId) {
  getDB().prepare("UPDATE einvoice_submissions SET status='pending', attempts=0, error=NULL WHERE invoice_id=? AND status!='accepted'").run(invoiceId);
  return submit(invoiceId);
}
function previewXml(invoiceId) {
  const sub = getDB().prepare('SELECT * FROM einvoice_submissions WHERE invoice_id=?').get(invoiceId) || { uuid: '00000000-0000-0000-0000-000000000000', icv: 0 };
  const ctx = loadContext(invoiceId, sub);
  return ctx ? buildInvoiceXml(ctx) : null;
}

module.exports = { enabled, missingConfig, amounts, buildInvoiceXml, submit, enqueue, processPending, retry, previewXml };
