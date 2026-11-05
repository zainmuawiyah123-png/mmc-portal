'use strict';
// Read-only live smoke checks. This script never writes to MMC or to source systems.
const { parseJonepsRows, parseJonepsDetail, LIST_URL: JONEPS_URL } = require('../src/lib/joneps-sync');
const { parseDetail: parseAPCDetail, LIST_URL: APC_URL } = require('../src/lib/apc-sync');
const { normalizeWorldBankNotice } = require('../src/lib/opportunity-sync');

const UA = 'MMC-Tender-Directory-Live-Smoke/1.0 (read-only public-source check)';
async function get(url, accept = 'text/html') {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept },
    signal: AbortSignal.timeout(18000),
    redirect: 'manual'
  });
  if (response.status >= 300 && response.status < 400) throw new Error('redirect refused for source validation (HTTP ' + response.status + ')');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response;
}
async function checkJONEPS() {
  const html = await (await get(JONEPS_URL)).text();
  const rows = parseJonepsRows(html);
  if (!rows.length) throw new Error('public listing loaded but no recognizable tender rows');
  let detail = null;
  const candidate = rows.find(x => x.sourceUrl && x.sourceUrl !== JONEPS_URL);
  if (candidate) {
    const detailHtml = await (await get(candidate.sourceUrl)).text();
    detail = parseJonepsDetail(detailHtml, candidate.sourceUrl);
  }
  return { ok: true, listingRows: rows.length, detailParsed: !!detail, publicDocuments: detail ? detail.docs.length : null };
}
async function checkAPC() {
  const html = await (await get(APC_URL)).text();
  const ids = [...new Set([...html.matchAll(/(?:TendersDetails\?PID=|TendersDetails%3fPID%3d)(\d+)/gi)].map(x => x[1]))];
  if (!ids.length) throw new Error('public listing loaded but no recognizable tender detail links');
  const detailUrl = 'https://www.arabpotash.com/En/TendersDetails?PID=' + encodeURIComponent(ids[0]);
  const detailHtml = await (await get(detailUrl)).text();
  const detail = parseAPCDetail(detailHtml, ids[0]);
  return { ok: true, listingLinks: ids.length, detailTitleFound: !!detail.title, publicDocuments: detail.docs.length };
}
async function checkWorldBank() {
  const url = new URL('https://search.worldbank.org/api/v2/procnotices');
  url.searchParams.set('format', 'json');
  url.searchParams.set('rows', '10');
  url.searchParams.set('os', '0');
  url.searchParams.set('srt', 'noticedate desc,id asc');
  const payload = await (await get(url, 'application/json')).json();
  const source = payload.procnotices || payload.notices || payload;
  const rows = Array.isArray(source) ? source : Object.values(source).filter(x => x && typeof x === 'object');
  const normalized = rows.map(normalizeWorldBankNotice).filter(Boolean);
  if (!normalized.length) throw new Error('API responded but no notices could be normalized');
  return { ok: true, apiRows: rows.length, normalizedNotices: normalized.length };
}
async function run(name, fn) {
  try { const result = await fn(); console.log(JSON.stringify({ source: name, ...result })); return true; }
  catch (error) { console.log(JSON.stringify({ source: name, ok: false, error: String(error.message || error).slice(0, 500) })); return false; }
}
(async () => {
  const results = await Promise.all([
    run('JONEPS', checkJONEPS),
    run('Arab Potash Company', checkAPC),
    run('World Bank', checkWorldBank)
  ]);
  if (process.env.UNGM_ACCESS_TOKEN) {
    results.push(await run('UNGM', async () => {
      const url = new URL('https://www.ungm.org/Public/Notice');
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + process.env.UNGM_ACCESS_TOKEN, accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(18000), redirect: 'manual' });
      if (!response.ok) throw new Error('UNGM token/source check returned HTTP ' + response.status);
      return { ok: true, authorizedEndpointReached: true };
    }));
  } else {
    console.log(JSON.stringify({ source: 'UNGM', ok: false, skipped: true, error: 'UNGM_ACCESS_TOKEN is not configured in this workflow' }));
  }
  const passed = results.filter(Boolean).length;
  console.log('LIVE_SOURCE_SMOKE_SUMMARY ' + JSON.stringify({ passed, checked: results.length, status: passed === results.length ? 'success' : 'partial_failure' }));
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
