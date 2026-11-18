'use strict';
/** Project BOQ and estimate workspace. No tender/procurement tables are modified. */
const express=require('express');
const {getDB,uid}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const router=express.Router();
const publicRouter=express.Router();
router.use(A.requireAuth);
const EDIT=new Set(['owner','project_manager','engineer','quantity_surveyor']);
function member(projectId,userId){return getDB().prepare(`SELECT m.role,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?`).get(projectId,userId)||null;}
function access(req,edit=false){const m=member(req.params.projectId,req.user.id);if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');if(edit&&!EDIT.has(m.role))throw E.forbidden('لا تملك صلاحية تعديل جدول الكميات.');return m;}
function audit(db,req,action,itemId,detail){db.prepare(`INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)`).run(uid('aial_'),req.params.projectId,req.user.id,action,'boq_item',itemId,JSON.stringify(detail||{}));}
function clean(v,max){return String(v==null?'':v).trim().slice(0,max);}
function number(v,label){const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e12)throw E.validation(label+' يجب أن يكون رقماً موجباً صالحاً.');return n;}
function itemView(x){return {...x,line_total:Number((x.quantity*x.rate).toFixed(3))};}
router.get('/projects/:projectId/boq',wrap(async(req,res)=>{
 access(req);
 const db=getDB();
 const rows=db.prepare(`SELECT id,project_id,item_code,discipline,description,unit,quantity,rate,source_takeoff_item_id,created_by,updated_at,created_at FROM ai_boq_items WHERE project_id=? ORDER BY created_at,id`).all(req.params.projectId).map(itemView);
 // Resolve provenance only through the same project's run and document; never trust a bare source item id.
 const source=db.prepare(`SELECT i.id AS item_id,i.entity_index,i.entity_type,i.layer_name,i.quantity AS source_quantity,i.unit AS source_unit,i.detail_json,
   r.id AS run_id,r.status AS run_status,r.engine,r.document_id,r.created_at AS run_created_at,
   d.original_name AS document_name,d.file_ext
   FROM ai_takeoff_items i JOIN ai_takeoff_runs r ON r.id=i.run_id
   JOIN ai_documents d ON d.id=r.document_id
   WHERE i.id=? AND r.project_id=? AND d.project_id=?`);
 for(const row of rows){
  if(!row.source_takeoff_item_id)continue;
  const src=source.get(row.source_takeoff_item_id,req.params.projectId,req.params.projectId);
  if(!src)continue;
  let detail={};try{detail=JSON.parse(src.detail_json||'{}');}catch(_){}
  row.sourceReference={
   takeoffItemId:src.item_id,entityIndex:src.entity_index,entityType:src.entity_type,nativeCadLayer:src.layer_name,
   quantity:Number(src.source_quantity),unit:src.source_unit,runId:src.run_id,runStatus:src.run_status,
   engine:src.engine,documentId:src.document_id,documentName:src.document_name,fileExtension:src.file_ext,
   runCreatedAt:src.run_created_at,
   measurement:{method:detail.method||detail.measurementMethod||detail.measurement_method||null,
    ruleId:detail.ruleId||detail.rule_id||null,ruleVersion:detail.ruleVersion||detail.rule_version||null,
    formula:detail.formula||null,inputs:detail.inputs||null,geometry:detail.geometry||null}
  };
 }
 const total=Number(rows.reduce((s,x)=>s+x.line_total,0).toFixed(3));
 res.setHeader('Cache-Control','no-store');
 res.json({items:rows,summary:{itemCount:rows.length,total}});
}));
router.post('/projects/:projectId/boq',wrap(async(req,res)=>{
 access(req,true);
 const description=clean(req.body?.description,1000),unit=clean(req.body?.unit,24);
 if(description.length<3||!unit)throw E.validation('وصف البند ووحدته مطلوبان.');
 const quantity=number(req.body?.quantity,'الكمية'),rate=number(req.body?.rate,'سعر الوحدة');
 const code=clean(req.body?.itemCode,80)||null,sourceId=clean(req.body?.sourceTakeoffItemId,100)||null;
 const db=getDB(),id=uid('aiboq_');
 if(sourceId){
  const src=db.prepare(`SELECT i.id,i.quantity,i.unit,i.entity_type,i.layer_name,r.project_id,r.status FROM ai_takeoff_items i JOIN ai_takeoff_runs r ON r.id=i.run_id WHERE i.id=? AND r.project_id=?`).get(sourceId,req.params.projectId);
  if(!src)throw E.notFound('عنصر الحصر المصدر غير موجود في هذا المشروع.');
  if(src.status!=='approved')throw E.conflict('لا يمكن ربط بند BOQ بنتيجة حصر قبل اعتمادها من المراجع.');
  if(Math.abs(Number(src.quantity)-quantity)>Math.max(1e-9,Math.abs(Number(src.quantity))*1e-9)||src.unit!==unit)throw E.validation('كمية ووحدة بند BOQ المرتبط يجب أن تطابقا نتيجة الحصر المعتمدة.');
 }
 db.prepare(`INSERT INTO ai_boq_items(id,project_id,item_code,description,unit,quantity,rate,source_takeoff_item_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,req.params.projectId,code,description,unit,quantity,rate,sourceId,req.user.id);
 audit(db,req,'boq_item_created',id,{quantity,rate,sourceId});
 const row=db.prepare('SELECT * FROM ai_boq_items WHERE id=?').get(id);
 res.status(201).json({item:itemView(row)});
}));
router.patch('/projects/:projectId/boq/:itemId',wrap(async(req,res)=>{
 access(req,true);
 const db=getDB(),old=db.prepare('SELECT * FROM ai_boq_items WHERE id=? AND project_id=?').get(req.params.itemId,req.params.projectId);
 if(!old)throw E.notFound('بند BOQ غير موجود.');
 const description=req.body?.description===undefined?old.description:clean(req.body.description,1000);
 const unit=req.body?.unit===undefined?old.unit:clean(req.body.unit,24);
 if(description.length<3||!unit)throw E.validation('وصف البند ووحدته مطلوبان.');
 const quantity=req.body?.quantity===undefined?old.quantity:number(req.body.quantity,'الكمية');
 const rate=req.body?.rate===undefined?old.rate:number(req.body.rate,'سعر الوحدة');
 if(old.source_takeoff_item_id){
  const src=db.prepare(`SELECT i.quantity,i.unit,r.status FROM ai_takeoff_items i JOIN ai_takeoff_runs r ON r.id=i.run_id WHERE i.id=? AND r.project_id=?`).get(old.source_takeoff_item_id,req.params.projectId);
  if(!src||src.status!=='approved')throw E.conflict('مصدر الحصر المرتبط غير متاح أو لم يعد معتمداً.');
  if(Math.abs(quantity-Number(src.quantity))>Math.max(1e-9,Math.abs(Number(src.quantity))*1e-9)||unit!==src.unit)throw E.validation('لا يمكن تغيير كمية أو وحدة بند مرتبط بحصر معتمد؛ أنشئ بنداً مستقلاً للتعديل.');
 }
 const code=req.body?.itemCode===undefined?old.item_code:(clean(req.body.itemCode,80)||null);
 db.prepare('UPDATE ai_boq_items SET item_code=?,description=?,unit=?,quantity=?,rate=?,updated_at=unixepoch() WHERE id=? AND project_id=?').run(code,description,unit,quantity,rate,old.id,req.params.projectId);
 audit(db,req,'boq_item_updated',old.id,{quantity,rate});
 res.json({item:itemView(db.prepare('SELECT * FROM ai_boq_items WHERE id=?').get(old.id))});
}));
router.delete('/projects/:projectId/boq/:itemId',wrap(async(req,res)=>{
 access(req,true);
 const db=getDB(),old=db.prepare('SELECT id FROM ai_boq_items WHERE id=? AND project_id=?').get(req.params.itemId,req.params.projectId);
 if(!old)throw E.notFound('بند BOQ غير موجود.');
 db.prepare('DELETE FROM ai_boq_items WHERE id=? AND project_id=?').run(old.id,req.params.projectId);
 audit(db,req,'boq_item_deleted',old.id,{});
 res.json({ok:true,id:old.id});
}));


// Spreadsheet import: CSV and XLSX (first non-empty worksheet). Upload is parsed in memory only.
const multer=require('multer');
const zlib=require('node:zlib');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1}});
function xmlText(s){return String(s||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));}
function unzipEntries(buf){
 const out={};let eocd=-1;
 for(let i=buf.length-22;i>=Math.max(0,buf.length-65558);i--){if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
 if(eocd<0)throw E.validation('ملف XLSX غير صالح أو تالف.');
 const count=buf.readUInt16LE(eocd+10),start=buf.readUInt32LE(eocd+16);let p=start;
 for(let i=0;i<count;i++){
  if(buf.readUInt32LE(p)!==0x02014b50)throw E.validation('بنية ملف XLSX غير مدعومة.');
  const method=buf.readUInt16LE(p+10),compressed=buf.readUInt32LE(p+20),nameLen=buf.readUInt16LE(p+28),extraLen=buf.readUInt16LE(p+30),commentLen=buf.readUInt16LE(p+32),local=buf.readUInt32LE(p+42);
  const name=buf.toString('utf8',p+46,p+46+nameLen);const lhName=buf.readUInt16LE(local+26),lhExtra=buf.readUInt16LE(local+28),dataStart=local+30+lhName+lhExtra;
  const raw=buf.subarray(dataStart,dataStart+compressed);
  if(!name.endsWith('/')){if(method===0)out[name]=raw;else if(method===8)out[name]=zlib.inflateRawSync(raw);else throw E.validation('طريقة ضغط XLSX غير مدعومة.');}
  p+=46+nameLen+extraLen+commentLen;
 }
 return out;
}
function parseXlsx(buf){
 const files=unzipEntries(buf),get=n=>files[n]?.toString('utf8')||'';
 const shared=[...get('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>[...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>xmlText(x[1])).join(''));
 const wb=get('xl/workbook.xml'),rels=get('xl/_rels/workbook.xml.rels');
 const relation={};for(const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)){const a=m[1],id=(a.match(/\bId="([^"]+)"/)||[])[1],target=(a.match(/\bTarget="([^"]+)"/)||[])[1];if(id&&target)relation[id]=target.startsWith('/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');}
 const sheets=[...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m=>({name:(m[1].match(/\bname="([^"]+)"/)||[])[1],rid:(m[1].match(/r:id="([^"]+)"/)||[])[1]}));
 const aliases={
  description:['description','itemdescription','descriptionofitem','workdescription','descriptionofwork','shortdescription','itemdetails','workitem','scope','item','الوصف','وصفالبند','وصفالاعمال','وصفالعمل','بيان','بيانالاعمال','البيان','تفاصيلالبند','اسمالبند','البند'],
  unit:['unit','uom','unitofmeasure','unitofmeasurement','measurementunit','الوحده','الوحدة','وحدهالقياس','وحدةالقياس'],
  quantity:['quantity','qty','quantities','totalquantity','qtym3','qtym2','qtynos','quantitym3','quantitym2','الكميه','الكمية','كميه','كميهالبند','كميةالبند','العدد']
 };
 let best=null,bestScore=0;
 for(const sh of sheets){
  const path=relation[sh.rid];if(!path||!files[path])continue;
  const xml=files[path].toString('utf8'),rows=[];
  for(const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
   const cells=[];
   for(const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){
    const attrs=cm[1],body=cm[2],ref=(attrs.match(/\br="([A-Z]+)\d+"/)||[])[1]||'',type=(attrs.match(/\bt="([^"]+)"/)||[])[1],idx=ref.split('').reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;
    let val='';const v=(body.match(/<v>([\s\S]*?)<\/v>/)||[])[1];
    if(type==='s')val=shared[Number(v)]??'';
    else if(type==='inlineStr')val=[...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>xmlText(x[1])).join('');
    else val=v==null?'':xmlText(v);
    cells[idx]=val;
   }
   rows.push(cells);
  }
  if(!rows.some(row=>row.some(v=>String(v??'').trim())))continue;
  let score=0;
  for(const row of rows.slice(0,20)){
   const keys=row.map(headerKey);
   const rowScore=Object.values(aliases).filter(opts=>keys.some(k=>opts.some(a=>headerKey(a)===k))).length;
   score=Math.max(score,rowScore);
  }
  if(!best||score>bestScore){best={sheet:sh.name||'Sheet',rows};bestScore=score;}
  if(score===3)return best;
 }
 if(best)return best;
 throw E.validation('لم يتم العثور على ورقة تحتوي بيانات في ملف XLSX.');
}
function parseCsv(text){
 const first=(text.split(/\r?\n/,1)[0]||''),delim=[',',';','\t'].sort((a,b)=>first.split(b).length-first.split(a).length)[0],rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'&&quoted&&text[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=!quoted;else if(ch===delim&&!quoted){row.push(cell);cell='';}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}else cell+=ch;}
 row.push(cell);if(row.some(v=>v.trim()))rows.push(row);return rows;
}
function headerKey(v){
 return String(v||'').normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[^\p{L}\p{N}]/gu,'');
}
function inferDiscipline(description){
 const d=String(description||'').toLowerCase();
 if(/excavat|backfill|earthwork|earth work|soil|filling|cart away|disposal|حفر|ردم|تراب/.test(d))return 'Earthworks';
 if(/formwork|shuttering|shutter|soffit|form work|نجاره|قوالب/.test(d))return 'Formwork';
 if(/plaster|rendering|render coat|لياسه|قصاره|محاره/.test(d))return 'Plastering';
 if(/masonry|blockwork|brickwork|block wall|brick wall|مباني|طوب|بلوك/.test(d))return 'Masonry';
 if(/\bdoor\b|doors|joinery|ابواب|باب/.test(d))return 'Doors & Joinery';
 if(/\bwindow\b|windows|glazing|نوافذ|شبابيك/.test(d))return 'Windows & Glazing';
 if(/railing|balustrade|handrail|metalwork|steelwork|canopy|درابزين|حديد/.test(d))return 'Metalwork';
 if(/roof covering|roofing|waterproof|membrane|عزل|تسقيف/.test(d))return 'Roofing';
 if(/concrete|\bpcc\b|\brcc\b|footing|column|beam|\bslab\b|stair|blinding|خرسانه|خرسانة|قواعد|اعمده|أعمدة|كمرات|بلاطه|بلاطة/.test(d))return 'Concrete & Structural';
 return null;
}
function normalizeSpreadsheet(rows){
 if(!rows.length)throw E.validation('الملف لا يحتوي صفوفاً.');
 const aliases={
  code:['itemno','itemnumber','itemcode','code','رقمالبند','رقمالفقرة','الكود','رقمالعنصر'],
  description:['description','itemdescription','descriptionofitem','workdescription','descriptionofwork','shortdescription','itemdetails','workitem','scope','item','الوصف','وصفالبند','وصفالاعمال','وصفالعمل','بيان','بيانالاعمال','البيان','تفاصيلالبند','اسم البند','اسمالبند','البند'],
  unit:['unit','uom','unitofmeasure','unitofmeasurement','measurementunit','الوحده','الوحدة','وحدهالقياس','وحدةالقياس'],
  quantity:['quantity','qty','quantities','totalquantity','qtym3','qtym2','qtynos','quantitym3','quantitym2','الكميه','الكمية','كميه','كميهالبند','كميةالبند','العدد'],
  rate:['rate','unitrate','price','unitprice','سعرالوحده','سعرالوحدة','السعر','سعر'],
  discipline:['discipline','trade','section','التخصص','القسم','البندالرئيسي']
 };
 // Header rows are not always the first row: BOQs often start with a project title or blank lines.
 let headerIndex=-1,headers=[],idx={};
 const scan=Math.min(rows.length,20);
 for(let r=0;r<scan;r++){
  const candidate=(rows[r]||[]).map(headerKey),found={};
  for(const [key,opts] of Object.entries(aliases))found[key]=candidate.findIndex(h=>opts.some(a=>headerKey(a)===h));
  const score=['description','unit','quantity'].filter(k=>found[k]>=0).length;
  if(score>['description','unit','quantity'].filter(k=>idx[k]>=0).length){headerIndex=r;headers=candidate;idx=found;}
  if(score===3)break;
 }
 if(headerIndex<0||['description','unit','quantity'].some(k=>idx[k]<0))
  throw E.validation('لم أتعرف على أعمدة الوصف والوحدة والكمية. استخدم Description, Unit, Quantity أو: وصف البند، الوحدة، الكمية. تأكد أن عناوين الأعمدة موجودة في أول 20 صفاً.');
 const items=[],errors=[];let ignoredRows=0;
 for(let i=headerIndex+1;i<rows.length;i++){const row=rows[i]||[],get=k=>idx[k]>=0?String(row[idx[k]]??'').trim():'';if(!row.some(v=>String(v??'').trim()))continue;
  const description=get('description'),unit=get('unit'),quantityRaw=get('quantity'),q=Number(quantityRaw.replace(/,/g,'')),rateRaw=get('rate'),rate=rateRaw===''?0:Number(rateRaw.replace(/,/g,''));
  // Descriptive section headings have no measurement fields; ignore them rather than flagging them as malformed items.
  if(description.length>=3&&!unit&&!quantityRaw){ignoredRows++;continue;}
  const err=[];if(description.length<3)err.push('وصف البند مفقود أو قصير');if(!unit)err.push('الوحدة مفقودة');if(!get('quantity')||!Number.isFinite(q)||q<0)err.push('الكمية غير صالحة');if(rateRaw!==''&&(!Number.isFinite(rate)||rate<0))err.push('سعر الوحدة غير صالح');
  if(err.length)errors.push({row:i+1,errors:err});
  else items.push({itemCode:get('code')||null,description,unit,quantity:q,rate,discipline:get('discipline')||inferDiscipline(description),sourceRow:i+1});
 }
 if(!items.length)throw E.validation('لم يتم استخراج أي بنود صالحة من الملف.');
 if(items.length>3000)throw E.validation('الملف يتجاوز الحد المسموح وهو 3,000 بند لكل عملية استيراد.');
 return {items,errors,ignoredRows,headers:rows[headerIndex].map(x=>String(x||'')),headerRow:headerIndex+1,totalRows:rows.length-headerIndex-1};
}
function readBoqUpload(file){
 const name=String(file.originalname||'').toLowerCase(),mime=String(file.mimetype||'');
 if(name.endsWith('.csv')||mime.includes('csv'))return {sheet:'CSV',...normalizeSpreadsheet(parseCsv(file.buffer.toString('utf8').replace(/^\uFEFF/,'')))};
 if(name.endsWith('.xlsx')||mime.includes('spreadsheetml')){const parsed=parseXlsx(file.buffer);return {sheet:parsed.sheet,...normalizeSpreadsheet(parsed.rows)};}
 throw E.validation('الصيغ المدعومة حالياً: XLSX وCSV فقط.');
}
router.post('/projects/:projectId/boq/import-preview',upload.single('file'),wrap(async(req,res)=>{
 access(req,true);if(!req.file)throw E.validation('اختر ملف Excel أو CSV أولاً.');
 const parsed=readBoqUpload(req.file);
 res.setHeader('Cache-Control','no-store');
 res.json({filename:req.file.originalname,sheet:parsed.sheet,headers:parsed.headers,totalRows:parsed.totalRows,validCount:parsed.items.length,errorCount:parsed.errors.length,ignoredRows:parsed.ignoredRows,errors:parsed.errors,items:parsed.items,pricedCount:parsed.items.filter(x=>x.rate>0).length,unpricedCount:parsed.items.filter(x=>x.rate===0).length});
}));
router.post('/projects/:projectId/boq/import',wrap(async(req,res)=>{
 access(req,true);const items=req.body?.items;
 if(!Array.isArray(items)||!items.length||items.length>3000)throw E.validation('قائمة الاستيراد غير صالحة أو تتجاوز 3,000 بند في العملية الواحدة.');
 const seen=new Set(),cleaned=items.map((x,i)=>{
  const description=clean(x.description,1000),unit=clean(x.unit,24),quantity=number(x.quantity,'الكمية'),rate=number(x.rate??0,'سعر الوحدة'),itemCode=clean(x.itemCode,80)||null;
  if(description.length<3||!unit)throw E.validation('يوجد بند بلا وصف أو وحدة في الصف '+(x.sourceRow||i+1)+'.');
  const key=itemCode?itemCode.toLowerCase():null;if(key&&seen.has(key))throw E.validation('رقم البند مكرر داخل الملف: '+itemCode);if(key)seen.add(key);
  return {description,unit,quantity,rate,itemCode,sourceRow:Number(x.sourceRow)||i+1,discipline:clean(x.discipline,80)||null};
 });
 const db=getDB(),insert=db.prepare('INSERT INTO ai_boq_items(id,project_id,item_code,discipline,description,unit,quantity,rate,source_takeoff_item_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const auditInsert=db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)');
 const transaction=db.transaction(()=>{for(const x of cleaned){const id=uid('aiboq_');insert.run(id,req.params.projectId,x.itemCode,x.discipline,x.description,x.unit,x.quantity,x.rate,null,req.user.id);auditInsert.run(uid('aial_'),req.params.projectId,req.user.id,'boq_item_imported','boq_item',id,JSON.stringify({sourceRow:x.sourceRow,discipline:x.discipline,rateProvided:x.rate>0}));}});
 transaction();
 const total=Number(cleaned.reduce((s,x)=>s+x.quantity*x.rate,0).toFixed(3));
 res.status(201).json({ok:true,imported:cleaned.length,priced:cleaned.filter(x=>x.rate>0).length,unpriced:cleaned.filter(x=>x.rate===0).length,total});
}));

// Public, isolated BOQ sandbox: parses a spreadsheet in memory without login or project access.
// Nothing is persisted; this endpoint cannot read or modify private project records.
publicRouter.post('/public-boq-preview',upload.single('file'),wrap(async(req,res)=>{
 if(!req.file)throw E.validation('اختر ملف XLSX أو CSV أولاً.');
 const parsed=readBoqUpload(req.file);
 const priced=parsed.items.filter(x=>x.rate>0),unpriced=parsed.items.filter(x=>x.rate===0);
 const knownTotal=Number(parsed.items.reduce((s,x)=>s+x.quantity*x.rate,0).toFixed(3));
 const disciplines=Object.entries(parsed.items.reduce((a,x)=>{const k=x.discipline||'غير مصنف';a[k]=(a[k]||0)+1;return a;},{})).map(([discipline,count])=>({discipline,count}));
 res.setHeader('Cache-Control','no-store');
 res.json({mode:'public_preview_only',persisted:false,filename:req.file.originalname,sheet:parsed.sheet,totalRows:parsed.totalRows,items:parsed.items,errors:parsed.errors,summary:{itemCount:parsed.items.length,pricedCount:priced.length,unpricedCount:unpriced.length,knownPricedTotal:knownTotal,ignoredRows:parsed.ignoredRows,disciplineBreakdown:disciplines},scheduleCandidates:parsed.items.map((x,i)=>({sequence:i+1,code:x.itemCode,activity:x.description,discipline:x.discipline||null,quantity:x.quantity,unit:x.unit,durationDays:null,status:'requires_productivity_resources_and_logic'})),riskSignals:[...(unpriced.length?[{type:'missing_unit_rates',count:unpriced.length,severity:'commercial_input_required'}]:[]),...(parsed.items.some(x=>!x.discipline)?[{type:'unclassified_discipline',count:parsed.items.filter(x=>!x.discipline).length,severity:'classification_required'}]:[]),...(parsed.errors.length?[{type:'invalid_rows',count:parsed.errors.length,severity:'data_quality'}]:[])]});
}));


module.exports={router,publicRouter};
