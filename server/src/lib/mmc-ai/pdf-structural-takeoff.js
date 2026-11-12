'use strict';
const ENGINE='mmc-pdf-structural-schedule-v0.1';
const positive=n=>Number.isFinite(n)&&n>0;
const round=(n,places)=>Number(n.toFixed(places));
function normalize(line){return String(line||'').normalize('NFKC').replace(/[\u00a0\u2007\u202f]/g,' ').replace(/[–—−]/g,'-').replace(/[×✕]/g,'x').replace(/\s+/g,' ').trim();}
function fail(message){throw new Error(message);}
function firstLine(pages,regex){
 for(let i=0;i<pages.length;i++){
  for(const raw of pages[i].split(/\r?\n/)){
   const line=normalize(raw);if(regex.test(line))return {page:i+1,line};
  }
 }
 return null;
}
function parseNumber(value,label){const n=Number(value);if(!positive(n))fail('Invalid or missing '+label+' in the PDF schedule.');return n;}
function dimensionVolume(count,dimensions){
 const value=count*dimensions.reduce((a,b)=>a*b,1);
 if(!Number.isFinite(value)||value<=0||value>1e9)fail('The structural dimensions produce an invalid concrete volume.');
 return value;
}
function parseStructuralScheduleText(input){
 const text=String(input||'');
 const pages=text.split('\f').map(page=>page.trim()).filter(Boolean);
 if(!pages.length||text.replace(/\s/g,'').length<80)fail('No readable PDF text was found; scanned/image-only PDFs need OCR, which is not enabled.');
 const allLines=pages.flatMap((page,i)=>page.split(/\r?\n/).map(line=>({page:i+1,line:normalize(line)})).filter(x=>x.line));
 const allText=allLines.map(x=>x.line).join('\n');
 if(!/STRUCTURAL ELEMENT SCHEDULE/i.test(allText)||!/BAR SCHEDULE/i.test(allText))fail('This PDF does not contain both a recognized structural element schedule and reinforcement bar schedule. No quantities were generated.');

 const footingLine=firstLine(pages,/F1\s*-\s*ISOLATED FOOTING/i);
 const columnLine=firstLine(pages,/C1\s*-\s*REINFORCED COLUMN/i);
 const beamLine=firstLine(pages,/B1\s*-\s*PERIMETER BEAM/i);
 const slabLine=firstLine(pages,/S1\s*-\s*RC SLAB/i);
 const beamLengthLine=firstLine(pages,/B1 CLEAR BEAM LENGTH/i);
 const beamBasisLine=firstLine(pages,/BEAM CONCRETE BELOW SLAB ONLY/i);
 if(!footingLine||!columnLine||!beamLine||!slabLine||!beamLengthLine||!beamBasisLine)fail('One or more required explicit dimensions are missing (F1, C1, B1, S1, beam clear length, or beam volume basis). No quantities were generated.');

 const fm=footingLine.line.match(/F1\s*-\s*ISOLATED FOOTING.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*M\b/i);
 const cm=columnLine.line.match(/C1\s*-\s*REINFORCED COLUMN.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*M\s*\|\s*HEIGHT\s*([\d.]+)\s*M\b/i);
 const bm=beamLine.line.match(/B1\s*-\s*PERIMETER BEAM.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*MM\b/i);
 const bl=beamLengthLine.line.match(/B1 CLEAR BEAM LENGTH\s*([\d.]+)\s*M\b/i);
 const bb=beamBasisLine.line.match(/BEAM CONCRETE BELOW SLAB ONLY\s*:\s*([\d.]+)\s*x\s*\(\s*([\d.]+)\s*-\s*([\d.]+)\s*\)\s*MM\b/i);
 const sm=slabLine.line.match(/S1\s*-\s*RC SLAB.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*M\b/i);
 if(!fm||!cm||!bm||!bl||!bb||!sm)fail('The labeled dimensions were found but could not be parsed unambiguously. No quantities were generated.');

 const footingCount=parseNumber(fm[1],'footing count'),footingDims=fm.slice(2,5).map((n,i)=>parseNumber(n,'footing dimension '+(i+1)));
 const columnCount=parseNumber(cm[1],'column count'),columnDims=cm.slice(2,5).map((n,i)=>parseNumber(n,'column dimension/height '+(i+1)));
 const beamCount=parseNumber(bm[1],'beam count'),beamWidthMm=parseNumber(bm[2],'beam width'),beamDepthMm=parseNumber(bm[3],'beam overall depth');
 const beamLength=parseNumber(bl[1],'beam clear length');
 const below=bb.slice(1,4).map((n,i)=>parseNumber(n,'beam/slab dimension '+(i+1)));
 const slabCount=parseNumber(sm[1],'slab count'),slabDims=sm.slice(2,5).map((n,i)=>parseNumber(n,'slab dimension '+(i+1)));
 if(Math.abs(beamWidthMm-below[0])>0.01||Math.abs(beamDepthMm-below[1])>0.01||Math.abs(slabDims[2]*1000-below[2])>0.01||below[1]<=below[2])fail('Beam/slab dimensions conflict; concrete volume cannot be safely determined.');

 const concrete=[
  {name:'F1 isolated footings',count:footingCount,dims:footingDims,unit:'m3',page:footingLine.page,source:footingLine.line,formula:`${footingCount} × ${footingDims.join(' × ')} m`,volume:dimensionVolume(footingCount,footingDims)},
  {name:'C1 columns',count:columnCount,dims:columnDims,unit:'m3',page:columnLine.page,source:columnLine.line,formula:`${columnCount} × ${columnDims.join(' × ')} m`,volume:dimensionVolume(columnCount,columnDims)},
  {name:'B1 perimeter beams below slab',count:beamCount,dims:[beamLength,beamWidthMm/1000,(below[1]-below[2])/1000],unit:'m3',page:beamLine.page,source:beamLine.line+'; '+beamLengthLine.line+'; '+beamBasisLine.line,formula:`${beamCount} × ${beamLength} × ${(beamWidthMm/1000).toFixed(3)} × ((${below[1]} - ${below[2]})/1000) m`,volume:dimensionVolume(beamCount,[beamLength,beamWidthMm/1000,(below[1]-below[2])/1000])},
  {name:'S1 slab',count:slabCount,dims:slabDims,unit:'m3',page:slabLine.page,source:slabLine.line,formula:`${slabCount} × ${slabDims.join(' × ')} m`,volume:dimensionVolume(slabCount,slabDims)}
 ];

 const scheduleTitle=firstLine(pages,/BAR SCHEDULE/i);
 const barRows=[];const seen=new Set();
 const barRe=/^([A-Z0-9]+-D(\d+)-[A-Z0-9-]+)\s+(.+?)\s+D(\d+)\s+(\d+)\s+([\d.]+)\s*M\s+([\d.]+)\s*M$/i;
 for(const entry of allLines){
  const m=entry.line.match(barRe);if(!m)continue;
  const mark=m[1].toUpperCase(),diameter=Number(m[2]),tableDiameter=Number(m[4]),count=Number(m[5]),cutLength=Number(m[6]),statedLength=Number(m[7]);
  if(seen.has(mark))fail('Duplicate reinforcement bar mark '+mark+' was found. No quantities were generated.');
  if(diameter!==tableDiameter||!Number.isInteger(diameter)||diameter<6||diameter>50||!Number.isInteger(count)||count<1||!positive(cutLength)||!positive(statedLength))fail('Invalid reinforcement schedule values for '+mark+'.');
  const calculatedLength=count*cutLength;
  if(Math.abs(calculatedLength-statedLength)>Math.max(0.02,count*0.001))fail('Bar schedule total length conflicts with count × cut length for '+mark+'.');
  seen.add(mark);barRows.push({mark,description:m[3],diameterMm:diameter,count,cutLength_m:cutLength,length_m:calculatedLength,statedLength_m:statedLength,page:entry.page,source:entry.line});
 }
 if(!scheduleTitle||barRows.length<1)fail('No readable reinforcement schedule rows were found. No quantities were generated.');

 const grouped=new Map();
 for(const row of barRows){
  const g=grouped.get(row.diameterMm)||{diameterMm:row.diameterMm,length_m:0,marks:[]};
  g.length_m+=row.length_m;g.marks.push(row);grouped.set(row.diameterMm,g);
 }
 const concreteTotal=concrete.reduce((s,x)=>s+x.volume,0);
 const rebarGroups=[...grouped.values()].sort((a,b)=>a.diameterMm-b.diameterMm).map(g=>{
  g.unitWeight_kg_per_m=g.diameterMm*g.diameterMm/162;
  g.mass_kg=g.length_m*g.unitWeight_kg_per_m;
  return g;
 });
 const rows=[];let entityIndex=0;
 for(const item of concrete){rows.push({entityIndex:++entityIndex,entity:'CONCRETE',layer:item.name,quantity:round(item.volume,3),unit:'m3',detail:{formula:item.formula,sourcePage:item.page,sourceExcerpt:item.source,method:'explicit schedule dimensions; net geometric volume',overlapRule:item.name.startsWith('B1')?'Beam volume is below slab only and uses clear length between column faces.':'No waste allowance; dimensions are taken from the labeled schedule.'}});}
 for(const group of rebarGroups){rows.push({entityIndex:++entityIndex,entity:'REINFORCEMENT',layer:`D${group.diameterMm} steel — net theoretical mass`,quantity:round(group.mass_kg,2),unit:'kg',detail:{diameter_mm:group.diameterMm,totalLength_m:round(group.length_m,2),unitWeight_kg_per_m:round(group.unitWeight_kg_per_m,6),formula:`${round(group.length_m,2)} m × (${group.diameterMm}² / 162 kg/m)`,marks:group.marks.map(x=>({mark:x.mark,count:x.count,cutLength_m:x.cutLength_m,length_m:round(x.length_m,2),sourcePage:x.page,sourceExcerpt:x.source})),method:'scheduled cut lengths; theoretical mass only; no laps, chairs, couplers, or waste.'}});}
 const totalRebar= rebarGroups.reduce((s,g)=>s+g.mass_kg,0);
 return {
  engine:ENGINE,status:'needs_review',
  units:{concrete:'m3',reinforcement:'kg',reinforcementLength:'m'},
  summary:{concrete_m3:round(concreteTotal,3),rebar_kg:round(totalRebar,2),rebar_length_by_diameter_m:Object.fromEntries(rebarGroups.map(g=>['D'+g.diameterMm,round(g.length_m,2)])),rebar_kg_by_diameter:Object.fromEntries(rebarGroups.map(g=>['D'+g.diameterMm,round(g.mass_kg,2)])),concrete_elements:concrete.length,bar_schedule_marks:barRows.length},
  unsupported:[],
  limitations:['Pilot parser supports only text-readable PDFs containing the explicitly labeled F1/C1/B1/S1 element schedule and bar schedule layout.','OCR is not performed; scanned/image-only PDFs are rejected without generating quantities.','Quantities are preliminary net takeoff only, pending an engineer review; no design verification or construction approval.','Rebar mass uses d²/162 kg/m; laps, anchorage beyond scheduled cut length, couplers, chairs, spacers, and waste are excluded unless separately shown.'],
  rows
 };
}
module.exports={ENGINE,parseStructuralScheduleText};
