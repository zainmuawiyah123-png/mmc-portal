'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const htmlPath = path.join(__dirname, '../../webpages/technical-proposal-kit_v5/project-finance/index.html');
const source = fs.readFileSync(htmlPath, 'utf8').replace(/<script\s+src="[^"]+"><\/script>/i, '');
const bootstrap = '<script>\n' +
'window.__apiCalls=[];window.__role="buyer";window.__orgRole="manager";\n' +
'window.API={\n' +
' me:()=>Promise.resolve({user:{email:"browser-test@example.test",role:window.__role}}),\n' +
' logout:()=>Promise.resolve(),\n' +
' request:(method,url,body)=>{window.__apiCalls.push({method,url,body});\n' +
' if(method==="GET"&&url==="/org")return Promise.resolve({myRole:window.__orgRole});\n' +
' if(method==="GET"&&url==="/project-finance/awards")return Promise.resolve({awards:[]});\n' +
' if(method==="GET"&&url==="/project-finance/purchase-orders")return Promise.resolve({purchaseOrders:window.__role==="contractor"?[{id:"po-1",po_number:"PO-1",currency:"JOD",total_amount:100,status:"issued",items:[{id:"poi-1",description:"Civil works",quantity:10,unit_price:10}]}]:[]});\n' +
' if(method==="GET"&&url==="/project-finance/invoices")return Promise.resolve({invoices:[]});\n' +
' return Promise.resolve({ok:true,invoice:{id:"invoice-1"}});\n' +
' }};\n</script>';
const pageHtml = source.replace('<script>\n(function(){', bootstrap + '\n<script>\n(function(){');

test('project finance browser role visibility, contractor invoice selection and mobile layout', async (t) => {
  const browser = await chromium.launch({headless:true});
  t.after(async () => browser.close());

  async function open(role, orgRole, width=1280) {
    const page = await browser.newPage({viewport:{width,height:900}});
    await page.addInitScript(({role,orgRole}) => { window.__role=role; window.__orgRole=orgRole; }, {role,orgRole});
    await page.setContent(pageHtml, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('identity')?.textContent.includes('الدور'));
    return page;
  }

  const manager = await open('buyer','manager');
  assert.equal(await manager.locator('#buyerTools').evaluate(e=>!e.classList.contains('hide')), true);
  assert.equal(await manager.locator('#ownerTools').evaluate(e=>e.classList.contains('hide')), true);
  assert.equal(await manager.locator('#financeTools').evaluate(e=>e.classList.contains('hide')), true);
  await manager.locator('#poAward').fill('award-1');
  await manager.locator('#poNumber').fill('PO-BROWSER-1');
  await manager.locator('#poDesc').fill('Civil works');
  await manager.locator('#poQty').fill('2');
  await manager.locator('#poPrice').fill('50');
  await manager.locator('#makePO').click();
  await manager.waitForFunction(() => window.__apiCalls.some(x=>x.method==='POST'&&x.url.includes('/project-finance/awards/award-1/purchase-orders')));
  await manager.close();

  const owner = await open('buyer','requester');
  assert.equal(await owner.locator('#buyerTools').evaluate(e=>e.classList.contains('hide')), true);
  assert.equal(await owner.locator('#ownerTools').evaluate(e=>!e.classList.contains('hide')), true);
  await owner.close();

  const finance = await open('buyer','finance');
  assert.equal(await finance.locator('#buyerTools').evaluate(e=>e.classList.contains('hide')), true);
  assert.equal(await finance.locator('#financeTools').evaluate(e=>!e.classList.contains('hide')), true);
  await finance.close();

  const contractor = await open('contractor',null,390);
  await contractor.waitForFunction(() => document.querySelector('#invoicePO option[value="po-1"]'));
  assert.equal(await contractor.locator('#contractorTools').evaluate(e=>!e.classList.contains('hide')), true);
  await contractor.locator('#invoicePO').selectOption('po-1');
  await contractor.locator('#invoiceItem').selectOption('poi-1');
  assert.equal(await contractor.locator('#invoicePrice').inputValue(),'10');
  await contractor.locator('#invoiceNo').fill('INV-BROWSER-1');
  await contractor.locator('#invoiceQty').fill('1');
  await contractor.locator('#makeInvoice').click();
  await contractor.waitForFunction(() => window.__apiCalls.some(x=>x.method==='POST'&&x.url.includes('/project-finance/purchase-orders/po-1/invoices')));
  const invoiceCall=await contractor.evaluate(()=>window.__apiCalls.find(x=>x.method==='POST'&&x.url.includes('/project-finance/purchase-orders/po-1/invoices')));
  assert.equal(invoiceCall.body.items[0].poItemId,'poi-1');
  const dimensions=await contractor.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
  assert.ok(dimensions.scrollWidth<=dimensions.width,'mobile horizontal overflow: '+JSON.stringify(dimensions));
  await contractor.close();
});
