'use strict';
/**
 * IFC STEP pre-inspector. Reports entity inventory and declared SI units.
 * It deliberately does not calculate geometry, quantities, or clashes.
 */
const SPATIAL=new Set(['IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY','IFCSPACE']);
const ELEMENTS=new Set(['IFCWALL','IFCWALLSTANDARDCASE','IFCSLAB','IFCBEAM','IFCCOLUMN','IFCDOOR','IFCWINDOW','IFCROOF','IFCSTAIR','IFCFOOTING','IFCMEMBER','IFCPLATE','IFCCURTAINWALL','IFCPILE','IFCRAILING','IFCDISTRIBUTIONELEMENT']);
function parseIfc(text){
 const source=String(text||'');if(source.length>100*1024*1024)throw new Error('IFC file exceeds inspection limit.');
 if(!/^\s*ISO-10303-21;/i.test(source)||! /END-ISO-10303-21;\s*$/i.test(source.trim()))throw new Error('Invalid IFC STEP envelope.');
 const counts=Object.create(null),spatial=[],elements=[];let records=0,quoted=false,depth=0,start=-1;
 for(let i=0;i<source.length;i++){
  const ch=source[i];
  if(ch==="'"){if(quoted&&source[i+1]==="'"){i++;continue;}quoted=!quoted;continue;}
  if(quoted)continue;
  if(ch==='(')depth++;else if(ch===')')depth=Math.max(0,depth-1);
  else if(ch===';'&&depth===0){
   const record=source.slice(start<0?0:start,i+1).trim();start=i+1;
   const match=record.match(/^#\d+\s*=\s*(IFC[A-Z0-9_]+)\s*\(/i);
   if(!match)continue;
   const type=match[1].toUpperCase();records++;counts[type]=(counts[type]||0)+1;
   if(SPATIAL.has(type)||ELEMENTS.has(type)){
    const args=record.slice(record.indexOf('(')+1);
    const label=(args.match(/^\s*(?:\$|\*|'((?:[^']|'')*)')/ )||[])[1]||'';
    const item={type,entityId:(record.match(/^#(\d+)/)||[])[1],name:label.replace(/''/g,"'")};
    if(SPATIAL.has(type))spatial.push(item);else elements.push(item);
   }
  }
 }
 if(quoted||depth!==0)throw new Error('IFC STEP has an unterminated string or entity argument list.');
 const lengthUnits=[];const unitPattern=/IFCSIUNIT\s*\(\s*[^,]*,\s*\.LENGTHUNIT\.\s*,\s*(\.[A-Z]+\.)?\s*,\s*\.METRE\.\s*\)/gi;let um;
 while((um=unitPattern.exec(source)))lengthUnits.push(um[1]||'NONE');
 const unitScale=lengthUnits.includes('.MILLI.')?'mm':lengthUnits.includes('.CENTI.')?'cm':lengthUnits.length?'m':'unknown';
 return {schema:(source.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i)||[])[1]||'unknown').toUpperCase(),records,entityTypeCount:Object.keys(counts).length,entityCounts:Object.fromEntries(Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,40)),spatialStructure:spatial.slice(0,250),buildingElements:elements.slice(0,500),buildingElementCount:elements.length,lengthUnit:unitScale,declaredLengthUnits:lengthUnits,geometryEntityCount:(counts.IFCCARTESIANPOINT||0)+(counts.IFCPOLYLINE||0)+(counts.IFCEXTRUDEDAREASOLID||0)+(counts.IFCFACETEDBREP||0)+(counts.IFCMAPPEDITEM||0),notice:'Pre-inspection only: no geometric reconstruction, quantity takeoff, or clash detection has been performed.'};
}
module.exports={parseIfc};
