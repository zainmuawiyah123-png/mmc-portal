'use strict';
// Read-only live smoke checks. This script never writes to MMC or to source systems.
const { parseJonepsRows, parseJonepsDetail, LIST_URL: JONEPS_URL } = require('../src/lib/joneps-sync');
const { parseDetail: parseAPCDetail, LIST_URL: APC_URL } = require('../src/lib/apc-sync');
const { normalizeWorldBankNotice } = require('../src/lib/opportunity-sync');
const { normalizeUNGMNotice } = require('../src/lib/ungm-sync');
const { fetchPublicPage: fetchBahrainPage, parseBahrainRows, extractPaginationUrls: extractBahrainPages, LIST_URL: BAHRAIN_URL } = require('../src/lib/bahrain-sync');

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
  const candidates = rows.filter(x => x.sourceUrl && x.sourceUrl !== JONEPS_URL).slice(0, 5);
  const details = await Promise.all(candidates.map(async candidate => {
    const detailHtml = await (await get(candidate.sourceUrl)).text();
    return parseJonepsDetail(detailHtml, candidate.sourceUrl);
  }));
  if (!details.length) throw new Error('listing parsed but no detail links were available to verify');
  return { ok: true, listingRows: rows.length, detailsChecked: details.length, parsedDetails: details.filter(Boolean).length, publicDocuments: details.reduce((n, detail) => n + detail.docs.length, 0) };
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
async function checkBahrain() {
  const first = await fetchBahrainPage();
  const urls = extractBahrainPages(first, BAHRAIN_URL, 3);
  const pages = [first];
  for (const url of urls.slice(1)) {
    await new Promise(resolve => setTimeout(resolve, 350));
    pages.push(await fetchBahrainPage(url));
  }
  const rows = pages.flatMap(html => parseBahrainRows(html));
  const unique = new Map(rows.map(row => [row.id, row]));
  if (!unique.size) throw new Error('public listing loaded but no verifiable Bahrain tender rows were parsed');
  return { ok: true, pagesChecked: pages.length, listingRows: rows.length, uniqueTenderNumbers: unique.size };
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
    run('Bahrain Tender Board', checkBahrain),
    run('World Bank', checkWorldBank)
  ]);
  if (process.env.UNGM_ACCESS_TOKEN) {
    results.push(await run('UNGM', async () => {
      const url = new URL('https://www.ungm.org/API/Notices');
      url.searchParams.set('$top', '20');
      url.searchParams.set('$orderby', 'DatePublished desc');
      const payload = await (await fetch(url, { headers: { authorization: 'Bearer ' + process.env.UNGM_ACCESS_TOKEN, accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(18000), redirect: 'manual' })).json();
      if (!Array.isArray(payload.value)) throw new Error('authorized endpoint did not return a notice collection');
      const notices = payload.value.map(normalizeUNGMNotice).filter(Boolean);
      return { ok: true, received: payload.value.length, finalizedNotices: notices.length };
    }));
  } else {
    console.log(JSON.stringify({ source: 'UNGM', ok: false, skipped: true, error: 'UNGM_ACCESS_TOKEN is not configured in this workflow' }));
  }
  const passed = results.filter(Boolean).length;
  console.log('LIVE_SOURCE_SMOKE_SUMMARY ' + JSON.stringify({ passed, checked: results.length, status: passed === results.length ? 'success' : 'partial_failure' }));
  if (!passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
