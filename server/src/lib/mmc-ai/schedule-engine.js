'use strict';
/** Deterministic CPM calculation in working-day units; no calendar/holiday inference. */
function calculateCriticalPath(tasks){
 const byId=new Map(tasks.map(t=>[t.id,{...t,pred:Array.isArray(t.predecessors)?t.predecessors:JSON.parse(t.predecessors_json||'[]')}]));
 if(byId.size!==tasks.length)throw new Error('Duplicate schedule task ID.');
 for(const t of byId.values())for(const p of t.pred){if(!byId.has(p))throw new Error('Unknown predecessor '+p+' for task '+t.id+'.');if(p===t.id)throw new Error('A task cannot depend on itself.');}
 const indegree=new Map(),successors=new Map();
 for(const t of byId.values()){indegree.set(t.id,t.pred.length);successors.set(t.id,[]);}
 for(const t of byId.values())for(const p of t.pred)successors.get(p).push(t.id);
 const ready=[...byId.values()].filter(t=>indegree.get(t.id)===0).map(t=>t.id),order=[];
 while(ready.length){const id=ready.shift();order.push(id);for(const next of successors.get(id)){indegree.set(next,indegree.get(next)-1);if(indegree.get(next)===0)ready.push(next);}}
 if(order.length!==tasks.length)throw new Error('Schedule dependency cycle detected.');
 const values=new Map();
 for(const id of order){const t=byId.get(id),es=t.pred.reduce((m,p)=>Math.max(m,values.get(p).ef),0),duration=Number(t.duration_days);if(!Number.isInteger(duration)||duration<0)throw new Error('Invalid duration for task '+id+'.');values.set(id,{es,ef:es+duration,duration});}
 const projectDuration=Math.max(0,...[...values.values()].map(x=>x.ef));
 for(const id of [...order].reverse()){const t=byId.get(id),v=values.get(id),next=successors.get(id);const lf=next.length?Math.min(...next.map(n=>values.get(n).ls)):projectDuration;v.lf=lf;v.ls=lf-v.duration;v.totalFloat=v.ls-v.es;v.critical=v.totalFloat===0;}
 return {projectDuration,criticalTaskCount:[...values.values()].filter(x=>x.critical).length,tasks:order.map(id=>({id,...values.get(id)}))};
}
module.exports={calculateCriticalPath};
