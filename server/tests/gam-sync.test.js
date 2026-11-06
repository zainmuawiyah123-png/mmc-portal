'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseGAMRows,extractDetailUrls,LIST_URL,dateISO}=require('../src/lib/gam-sync');
const row=(cells)=>'<table><tr>'+cells.map(x=>'<td>'+x+'</td>').join('')+'</tr></table>';
test('GAM parser extracts tender details and deadlines into MMC fields',()=>{
 const html=row(['12/3/2026','تنفيذ أعمال صيانة وتأهيل طرق','كفالة 3% من قيمة العرض','25 دينار','مصنف إنشائي فئة أولى','10/3/2026','12/3/2026','15/3/2026']);
 const [item]=parseGAMRows(html,'2026-03-01','https://media.ammancity.gov.jo/AR/ListDetails/123');
 assert.ok(item);
 assert.equal(item.tenderNumber,'12/3/2026');
 assert.equal(item.details.bidBond,'كفالة 3% من قيمة العرض');
 assert.equal(item.details.documentFee,'25 دينار');
 assert.equal(item.details.qualification,'مصنف إنشائي فئة أولى');
 assert.equal(item.details.lastSaleDate,'2026-03-10');
 assert.equal(item.details.inquiryDeadline,'2026-03-12');
 assert.equal(item.details.closingDate,'2026-03-15');
 assert.equal(item.sourceUrl,LIST_URL);
 assert.equal(item.status,'open');
});
test('GAM parser deduplicates the same tender across paginated announcement pages',()=>{
 const cells=['74/1/2026','إعادة تأهيل أدراج متنوعة','13000 دينار','250','إنشاء أبنية فئة ثالثة أو رابعة','11/11/2026','17/11/2026','23/11/2026'];
 const row='<table><tr>'+cells.map(x=>'<td>'+x+'</td>').join('')+'</tr></table>';
 const rows=[...parseGAMRows(row,'2026-11-06','https://media.ammancity.gov.jo/AR/ListDetails/x/1'),...parseGAMRows(row,'2026-11-06','https://media.ammancity.gov.jo/AR/ListDetails/x/2')];
 assert.equal(rows[0].id,rows[1].id);
 assert.equal(rows[0].tenderNumber,'74/1/2026');
});
test('GAM parser safely returns no details for non-tender or incomplete rows',()=>{
 assert.deepEqual(parseGAMRows('<table><tr><td>عنوان</td><td>نص فقط</td></tr></table>','2026-03-01','https://media.ammancity.gov.jo/AR/ListDetails/1'),[]);
 assert.equal(dateISO('31/02/2026'),null);
});
test('GAM detail URL extraction only accepts official detail pages',()=>{
 const html='<a href="/AR/ListDetails/123">تفاصيل</a><a href="https://evil.example/AR/ListDetails/2">bad</a><a href="https://media.ammancity.gov.jo/AR/ListDetails/456">ok</a>';
 assert.deepEqual(extractDetailUrls(html),[
  'https://media.ammancity.gov.jo/AR/ListDetails/123',
  'https://media.ammancity.gov.jo/AR/ListDetails/456'
 ]);
});
