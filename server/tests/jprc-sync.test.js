'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mmc-jprc-details-'));
process.env.NODE_ENV='test';
process.env.DB_PATH=path.join(TMP,'jprc.sqlite');
const {migrate}=require('../src/migrate');
const {getDB,closeDB}=require('../src/db');
const {parseJprcRows,parseJprcDetail,persistJprcDetails}=require('../src/lib/jprc-sync');
test.before(()=>{const db=migrate(process.env.DB_PATH);db.close();});
test.after(()=>{closeDB();fs.rmSync(TMP,{recursive:true,force:true});});
test('JPRC parser extracts official notice reference, title and dates',()=>{
 const html='<a href="/ar/TendersDetails/123">رقم العطاء: 12/2026 موضوع العطاء: تنفيذ أعمال مدنية تاريخ طرح العطاء: 2026/11/01 تاريخ الاغلاق: 2026/11/20 سعر النسخة: 50 دينار</a>';
 const rows=parseJprcRows(html,'2026-11-06');
 assert.equal(rows.length,1);
 assert.equal(rows[0].tenderNumber,'12/2026');
 assert.equal(rows[0].closingAt,'2026-11-20');
 assert.match(rows[0].sourceUrl,/TendersDetails\/123$/);
});
test('JPRC detail parser extracts public tender conditions and only same-host documents',()=>{
 const html='<main><p>كفالة الدخول: 5% من قيمة العرض</p><p>شهادة التصنيف المطلوبة: أشغال عامة فئة أولى</p><p>موعد الزيارة: 10/11/2026</p><p>الحصول على نسخة العطاء من دائرة المشتريات</p><a href="/files/boq.pdf">جدول الكميات</a><a href="https://evil.example/fake.pdf">وثيقة</a></main>';
 const detail=parseJprcDetail(html,'https://jopetrol.com.jo/ar/TendersDetails/123');
 assert.match(detail.bidBond,/5%/);
 assert.match(detail.qualification,/فئة أولى/);
 assert.equal(detail.docs.length,1);
 assert.match(detail.docs[0].url,/jopetrol\.com\.jo\/files\/boq\.pdf$/);
 assert.equal(detail.documentsDownloadable,true);
});
test('JPRC detail persistence stores verified detail and deduplicated public attachments',()=>{
 const db=getDB();
 db.prepare(`INSERT INTO tender_opportunities
 (id,source_key,external_id,title,authority,country,tender_number,summary,source_url,status,language)
 VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('jprc-test','jprc','12/2026','أعمال مدنية','مصفاة البترول','JO','12/2026','إعلان','https://jopetrol.com.jo/ar/TendersDetails/123','open','ar');
 const detail={id:'12/2026',detail:{bidBond:'5%',qualification:'فئة أولى',docs:[
  {label:'BOQ',url:'https://jopetrol.com.jo/files/boq.pdf'},
  {label:'Duplicate',url:'https://jopetrol.com.jo/files/boq.pdf'}
 ]}};
 assert.deepEqual(persistJprcDetails([{id:'12/2026'}],[detail]),{detailsSaved:1,documentsSaved:1});
 const saved=db.prepare('SELECT details_json FROM tender_opportunity_details WHERE opportunity_id=?').get('jprc-test');
 assert.equal(JSON.parse(saved.details_json).bidBond,'5%');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM tender_opportunity_documents WHERE opportunity_id=?').get('jprc-test').n,1);
});
