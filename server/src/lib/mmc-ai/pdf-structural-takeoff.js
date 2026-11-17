'use strict';
const ENGINE='mmc-pdf-structural-schedule-v0.1';
const positive=n=>Number.isFinite(n)&&n>0,round=(n,p)=>Number(n.toFixed(p));
const norm=s=>String(s||'').normalize('NFKC').replace(/[\u00a0\u2007\u202f]/g,' ').replace(/[–—−]/g,'-').replace(/[×✕]/g,'x').replace(/\s+/g,' ').trim();
function fail(s){throw new Error(s);}
function first(pages,re){for(let i=0;i<pages.length;i++)for(const raw of pages[i].split(/\r?\n/)){const line=norm(raw);if(re.test(line))return {page:i+1,line};}return null;}
function num(s,label){const n=Number(s);if(!positive(n))fail('Invalid or missing '+label+' in the PDF schedule.');return n;}
function volume(count,dims){const v=count*dims.reduce((a,b)=>a*b,1);if(!positive(v)||v>1e9)fail('Invalid concrete volume.');return v;}
function parseStructuralScheduleText(input){
 const pages=String(input||'').split('\f').map(x=>x.trim()).filter(Boolean);
 if(!pages.length||String(input||'').replace(/\s/g,'').length<80)fail('No readable PDF text was found; scanned/image-only PDFs need OCR. No quantities generated.');
 const lines=pages.flatMap((p,i)=>p.split(/\r?\n/).map(x=>({page:i+1,line:norm(x)})).filter(x=>x.line));
 const joined=lines.map(x=>x.line).join('\n');
 if(!/STRUCTURAL ELEMENT SCHEDULE/i.test(joined)||!/BAR SCHEDULE/i.test(joined))fail('PDF is outside the supported structural schedule format. No quantities generated.');
 const f=first(pages,/F1\s*-\s*ISOLATED FOOTING/i),c=first(pages,/C1\s*-\s*REINFORCED COLUMN/i),b=first(pages,/B1\s*-\s*PERIMETER BEAM/i),s=first(pages,/S1\s*-\s*RC SLAB/i),bl=first(pages,/B1 CLEAR BEAM LENGTH/i),bb=first(pages,/BEAM CONCRETE BELOW SLAB ONLY/i);
 if(!f||!c||!b||!s||!bl||!bb)fail('Required explicit dimensions F1/C1/B1/S1 or beam basis are missing. No quantities generated.');
 const fm=f.line.match(/F1\s*-\s*ISOLATED FOOTING.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*M\b/i);
 const cm=c.line.match(/C1\s*-\s*REINFORCED COLUMN.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*M\s*\|\s*HEIGHT\s*([\d.]+)\s*M\b/i);
 const bm=b.line.match(/B1\s*-\s*PERIMETER BEAM.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*MM\b/i);
 const lm=bl.line.match(/B1 CLEAR BEAM LENGTH\s*([\d.]+)\s*M\b/i);
 const vm=bb.line.match(/BEAM CONCRETE BELOW SLAB ONLY\s*:\s*([\d.]+)\s*x\s*\(\s*([\d.]+)\s*-\s*([\d.]+)\s*\)\s*MM\b/i);
 const sm=s.line.match(/S1\s*-\s*RC SLAB.*?(\d+)\s+NO\.?\s*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*M\b/i);
 if(!fm||!cm||!bm||!lm||!vm||!sm)fail('Schedule dimensions cannot be parsed unambiguously. No quantities generated.');
 const fc=num(fm[1],'footing count'),fd=fm.slice(2).map((x,i)=>num(x,'footing dimension '+i));
 const cc=num(cm[1],'column count'),cd=cm.slice(2).map((x,i)=>num(x,'column dimension '+i));
 const bc=num(bm[1],'beam count'),bw=num(bm[2],'beam width'),bd=num(bm[3],'beam depth'),blen=num(lm[1],'beam clear length');
 const [vw,vd,vs]=vm.slice(1).map((x,i)=>num(x,'beam/slab dimension '+i));
 const sc=num(sm[1],'slab count'),sd=sm.slice(2).map((x,i)=>num(x,'slab dimension '+i));
 if(Math.abs(bw-vw)>.01||Math.abs(bd-vd)>.01||Math.abs(sd[2]*1000-vs)>.01||vd<=vs)fail('Beam/slab dimensions conflict. No quantities generated.');
 const concrete=[
  {name:'F1 isolated footings',q:volume(fc,fd),page:f.page,src:f.line,formula:fc+' × '+fd.join(' × ')+' m'},
  {name:'C1 columns',q:volume(cc,cd),page:c.page,src:c.line,formula:cc+' × '+cd.join(' × ')+' m'},
  {name:'B1 perimeter beams below slab',q:volume(bc,[blen,bw/1000,(vd-vs)/1000]),page:b.page,src:b.line+'; '+bl.line+'; '+bb.line,formula:bc+' × '+blen+' × '+(bw/1000).toFixed(3)+' × (('+vd+' - '+vs+')/1000) m'},
  {name:'S1 slab',q:volume(sc,sd),page:s.page,src:s.line,formula:sc+' × '+sd.join(' × ')+' m'}
 ];
 const barRe=/^([A-Z0-9]+-D(\d+)-[A-Z0-9-]+)\s+(.+?)\s+D(\d+)\s+(\d+)\s+([\d.]+)\s*M\s+([\d.]+)\s*M$/i,seen=new Set(),bars=[];
 for(const x of lines){const m=x.line.match(barRe);if(!m)continue;const mark=m[1].toUpperCase(),dia=Number(m[2]),dia2=Number(m[4]),count=Number(m[5]),cut=Number(m[6]),stated=Number(m[7]);
  if(seen.has(mark))fail('Duplicate reinforcement bar mark '+mark+'. No quantities generated.');
  if(dia!==dia2||!Number.isInteger(dia)||dia<6||dia>50||!Number.isInteger(count)||count<1||!positive(cut)||!positive(stated))fail('Invalid reinforcement schedule values for '+mark+'.');
  const length=count*cut;if(Math.abs(length-stated)>Math.max(.02,count*.001))fail('Bar schedule total conflicts with count × cut length for '+mark+'.');
  seen.add(mark);bars.push({mark,description:m[3],diameterMm:dia,count,cutLength_m:cut,length_m:length,page:x.page,source:x.line});
 }
 if(!first(pages,/BAR SCHEDULE/i)||!bars.length)fail('No readable reinforcement schedule rows. No quantities generated.');
 const grouped=new Map();for(const x of bars){const g=grouped.get(x.diameterMm)||{diameterMm:x.diameterMm,length_m:0,marks:[]};g.length_m+=x.length_m;g.marks.push(x);grouped.set(x.diameterMm,g);}
 const rebar=[...grouped.values()].sort((a,b)=>a.diameterMm-b.diameterMm).map(g=>({...g,unitWeight_kg_per_m:g.diameterMm*g.diameterMm/162,mass_kg:g.length_m*g.diameterMm*g.diameterMm/162}));
 const rows=[];let i=0;
 for(const x of concrete)rows.push({entityIndex:++i,entity:'CONCRETE',layer:x.name,quantity:round(x.q,3),unit:'m3',detail:{formula:x.formula,sourcePage:x.page,sourceExcerpt:x.src,method:'explicit schedule dimensions; net geometric volume',overlapRule:x.name.startsWith('B1')?'Beam volume below slab only.':'No waste allowance.'}});
 for(const g of rebar)rows.push({entityIndex:++i,entity:'REINFORCEMENT',layer:'D'+g.diameterMm+' steel — net theoretical mass',quantity:round(g.mass_kg,2),unit:'kg',detail:{diameter_mm:g.diameterMm,totalLength_m:round(g.length_m,2),unitWeight_kg_per_m:round(g.unitWeight_kg_per_m,6),formula:round(g.length_m,2)+' m × ('+g.diameterMm+'² / 162 kg/m)',marks:g.marks.map(x=>({mark:x.mark,count:x.count,cutLength_m:x.cutLength_m,length_m:round(x.length_m,2),sourcePage:x.page,sourceExcerpt:x.source})),method:'Scheduled cut lengths; theoretical mass; laps, chairs, couplers and waste excluded.'}});
 const concreteTotal=concrete.reduce((a,x)=>a+x.q,0),rebarTotal=rebar.reduce((a,x)=>a+x.mass_kg,0);
 return {engine:ENGINE,status:'needs_review',units:{concrete:'m3',reinforcement:'kg',reinforcementLength:'m'},summary:{concrete_m3:round(concreteTotal,3),rebar_kg:round(rebarTotal,2),rebar_length_by_diameter_m:Object.fromEntries(rebar.map(x=>['D'+x.diameterMm,round(x.length_m,2)])),rebar_kg_by_diameter:Object.fromEntries(rebar.map(x=>['D'+x.diameterMm,round(x.mass_kg,2)])),concrete_elements:concrete.length,bar_schedule_marks:bars.length},unsupported:[],limitations:['Supports only text-readable PDFs using the explicit F1/C1/B1/S1 and bar-schedule layout.','Scanned PDFs are rejected: OCR integration is not yet enabled in this takeoff route.','Draft net quantities require engineer review; not design approval.','Rebar mass d²/162; laps, anchorage beyond scheduled cut length, couplers, chairs and waste excluded.'],rows};
}
module.exports={ENGINE,parseStructuralScheduleText};