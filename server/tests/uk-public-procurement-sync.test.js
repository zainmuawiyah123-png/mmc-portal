'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOcdsRelease, unpackPackages } = require('../src/lib/uk-public-procurement-sync');

test('unpacks OCDS release packages and records', () => {
  const releases = unpackPackages({packages:[{releases:[{id:'R1'}]}]});
  // The API may return a top-level release package or an array of packages.
  assert.deepEqual(unpackPackages([{releases:[{id:'R2'}]}]), [{id:'R2'}]);
  assert.deepEqual(unpackPackages({releases:[{id:'R3'}]}), [{id:'R3'}]);
  assert.equal(releases.length, 0, 'unknown wrappers are ignored rather than guessed');
});

test('normalizes a UK OCDS contract notice with stable OCID and official source', () => {
  const row = normalizeOcdsRelease({
    ocid:'ocds-abc-123', id:'1234-2026', date:'2026-11-01T10:00:00Z',
    buyer:{name:'Example Council'},
    tender:{
      id:'REF-001', title:'Road resurfacing works',
      description:'Resurfacing and drainage improvements',
      tenderPeriod:{endDate:'2099-12-31T12:00:00Z'},
      items:[{classification:{id:'45233200',description:'Surface work for roads'}}]
    }
  },'findatender');
  assert.ok(row);
  assert.equal(row.id,'ocds-abc-123');
  assert.equal(row.country,'GB');
  assert.equal(row.authority,'Example Council');
  assert.equal(row.tenderNumber,'REF-001');
  assert.equal(row.status,'open');
  assert.match(row.sourceUrl,/find-tender\.service\.gov\.uk/);
  assert.match(row.summary,/45233200/);
});

test('rejects incomplete or non-tender OCDS releases', () => {
  assert.equal(normalizeOcdsRelease({id:'x',buyer:{name:'Buyer'}},'pcs'),null);
  assert.equal(normalizeOcdsRelease({tender:{title:'No stable id'}},'pcs'),null);
});

test('normalizes Scottish notices to the short source key used by the contractor feed', () => {
  const row = normalizeOcdsRelease({
    ocid:'ocds-r6ebe6-0000517932', id:'notice-1',
    buyer:{name:'Scottish Authority'},
    tender:{title:'Bridge repair',tenderPeriod:{endDate:'2099-05-01'},items:[]}
  },'pcs');
  assert.equal(row.country,'GB');
  assert.match(row.sourceUrl,/publiccontractsscotland\.gov\.uk/);
});
