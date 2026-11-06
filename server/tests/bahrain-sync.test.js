'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseBahrainRows,dateISO,extractTenderReference,LIST_URL}=require('../src/lib/bahrain-sync');
test('Bahrain parser imports reference, title, authority and dates',()=>{
 const html='<table><tr><th>No.</th><th>No./Tender Subject</th><th>Tender Type</th><th>Purchasing Authority</th><th>Published Date</th><th>Purchase Before</th><th>Closing Date</th></tr><tr><td>1</td><td><a href="/Tenders/TenderDetails/123">TRA/INTERNAL/RFP/2026/005 National Internet Safety Review Launch Event</a></td><td>Internal</td><td>Telecommunication Regulatory Authority</td><td>04, Nov,2026</td><td>22, Nov,2026</td><td>30 Nov,2026</td></tr></table>';
 const [r]=parseBahrainRows(html,'2026-11-06');assert.ok(r);assert.equal(r.id,'TRA/INTERNAL/RFP/2026/005');assert.equal(r.title,'National Internet Safety Review Launch Event');assert.equal(r.authority,'Telecommunication Regulatory Authority');assert.equal(r.country,'BH');assert.equal(r.publishedAt,'2026-11-04');assert.equal(r.details.purchaseBefore,'2026-11-22');assert.equal(r.closingAt,'2026-11-30');assert.equal(r.status,'open');assert.equal(r.sourceUrl,'https://www.tenderboard.gov.bh/Tenders/TenderDetails/123');assert.equal(LIST_URL,'https://www.tenderboard.gov.bh/Tenders/PublicTenders/');
});
test('Bahrain parser handles compact reference and Arabic dates',()=>{
 const html='<table><tr><td>1</td><td>PT/CSD/MM/2026/135توريد أنابيب البولي فينيل كلوريد</td><td>External</td><td>Central Stores Directorate - EWA</td><td>04 نوفمبر 2026</td><td>21 نوفمبر 2026</td><td>29 نوفمبر 2026</td></tr></table>';
 const [r]=parseBahrainRows(html,'2026-11-06');assert.ok(r);assert.equal(r.tenderNumber,'PT/CSD/MM/2026/135');assert.equal(r.title,'توريد أنابيب البولي فينيل كلوريد');assert.equal(r.publishedAt,'2026-11-04');assert.equal(r.closingAt,'2026-11-29');
});
test('Bahrain parser deduplicates and ignores incomplete rows',()=>{
 const row='<tr><td>1</td><td>BGE2630000115 Seat Ring, Valves</td><td>Internal</td><td>Bapco Energies</td><td>04, Nov,2026</td><td>15, Nov,2026</td><td>17 Nov,2026</td></tr>';
 assert.equal(parseBahrainRows('<table>'+row+row+'<tr><td>bad</td></tr></table>','2026-11-06').length,1);assert.deepEqual(parseBahrainRows('<html>Access denied</html>','2026-11-06'),[]);
});
test('Bahrain dates validate calendar days and month names',()=>{assert.equal(dateISO('30 Nov,2026'),'2026-11-30');assert.equal(dateISO('04 نوفمبر 2026'),'2026-11-04');assert.equal(dateISO('31/02/2026'),null);assert.equal(dateISO('not a date'),null);});
test('Bahrain reference parser rejects rows without stable IDs',()=>{assert.equal(extractTenderReference('General maintenance services'),null);});
