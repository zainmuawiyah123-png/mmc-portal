'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {calculateCriticalPath}=require('../src/lib/mmc-ai/schedule-engine');
test('CPM identifies critical path and float from dependencies',()=>{
 const result=calculateCriticalPath([
  {id:'A',duration_days:5,predecessors:[]},
  {id:'B',duration_days:3,predecessors:['A']},
  {id:'C',duration_days:2,predecessors:['A']},
  {id:'D',duration_days:4,predecessors:['B','C']}
 ]);
 assert.equal(result.projectDuration,12);
 assert.deepEqual(result.tasks.filter(t=>t.critical).map(t=>t.id),['A','B','D']);
 assert.equal(result.tasks.find(t=>t.id==='C').totalFloat,1);
});
test('CPM rejects circular and unknown dependencies',()=>{
 assert.throws(()=>calculateCriticalPath([{id:'A',duration_days:1,predecessors:['B']},{id:'B',duration_days:1,predecessors:['A']}]),/cycle/);
 assert.throws(()=>calculateCriticalPath([{id:'A',duration_days:1,predecessors:['missing']}]),/Unknown predecessor/);
});
