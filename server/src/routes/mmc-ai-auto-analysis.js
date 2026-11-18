'use strict';
/** Unified, project-scoped intelligence snapshot. Reads every existing MMC AI workstream without inventing missing data. */
const express=require('express');
const {getDB}=require('../db');
const {E,wrap}=require('../lib/errors');
const A=require('../lib/auth');
const {calculateCriticalPath}=require('../lib/mmc-ai/schedule-engine');
const router=express.Router();
router.use(A.requireAuth);
function member(pid,user){return getDB().prepare('SELECT m.role,p.name,p.country,p.currency,p.status FROM ai_project_members m JOIN ai_projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=?').get(pid,user)||null;}
function parse(v,fallback){try{return JSON.parse(v||'');}catch(_){return fallback;}}
function status(state,detail,missing=[]){return {status:state,detail,missingInputs:missing};}
router.get('/projects/:projectId/auto-analysis',wrap(async(req,res)=>{
 const pid=req.params.projectId,db=getDB(),m=member(pid,req.user.id);
 if(!m||m.status!=='active')throw E.notFound('المشروع غير موجود.');
 const boq=db.prepare('SELECT id,item_code,description,unit,quantity,rate,source_takeoff_item_id FROM ai_boq_items WHERE project_id=? ORDER BY created_at,id').all(pid);
 const tasks=db.prepare('SELECT * FROM ai_schedule_tasks WHERE project_id=? ORDER BY created_at,id').all(pid);
 const risks=db.prepare('SELECT * FROM ai_project_risks WHERE project_id=? ORDER BY probability*impact DESC,created_at DESC').all(pid);
 const events=db.prepare('SELECT * FROM ai_contract_events WHERE project_id=? ORDER BY created_at DESC').all(pid);
 const docs=db.prepare('SELECT id,original_name,file_ext,discipline,processing_status,created_at FROM ai_documents WHERE project_id=? ORDER BY created_at DESC').all(pid);
 const models=db.prepare('SELECT id,original_name,model_format,discipline,processing_status,processing_message,created_at FROM ai_bim_models WHERE project_id=? ORDER BY created_at DESC').all(pid);
 const analyses=db.prepare('SELECT a.document_id,a.analysis_type,a.result_json,a.created_at,d.original_name FROM ai_document_analyses a JOIN ai_documents d ON d.id=a.document_id AND d.project_id=a.project_id WHERE a.project_id=? ORDER BY a.created_at DESC').all(pid);
 const total=boq.reduce((s,x)=>s+Number(x.quantity)*Number(x.rate),0);
 const unpriced=boq.filter(x=>Number(x.rate)===0);
 const cpm=tasks.length?calculateCriticalPath(tasks.map(t=>({...t,predecessors:parse(t.predecessors_json,[])}))):{projectDuration:0,criticalTaskCount:0,tasks:[]};
 const disciplines=['structural','architectural','electrical','mechanical','plumbing_fire'];
 const documentCoverage=disciplines.map(d=>({discipline:d,count:docs.filter(x=>x.discipline===d).length}));
 const latestByDocument=new Map();
 for(const a of analyses){if(!latestByDocument.has(a.document_id))latestByDocument.set(a.document_id,{documentId:a.document_id,filename:a.original_name,analysisType:a.analysis_type,createdAt:a.created_at,result:parse(a.result_json,{})});}
 const drawingResults=[...latestByDocument.values()].filter(x=>/pdf_|image_/.test(x.analysisType)).map(x=>({documentId:x.documentId,filename:x.filename,analysisType:x.analysisType,status:x.result.status||'analysis_saved',pagesProcessed:x.result.pagesVectorProcessed||x.result.ocr?.pagesProcessed||null,detectedFootprintCount:x.result.detectedFootprintCount??null,bimCreated:x.result.threeDModelCreated===true||x.result.modelCreated===true,quantitiesCreated:Array.isArray(x.result.quantities)?x.result.quantities.length:0,unresolved:x.result.unresolved||[]}));
 const riskSignals=[];
 if(unpriced.length)riskSignals.push({code:'BOQ_UNPRICED_ITEMS',title:'بنود كميات دون أسعار وحدات',evidence:{count:unpriced.length,itemIds:unpriced.map(x=>x.id)},assessment:'requires_cost_review',probability:null,impact:null,score:null});
 if(!tasks.length&&boq.length)riskSignals.push({code:'SCHEDULE_NOT_BASELINED',title:'لا يوجد برنامج زمني مرتبط بجدول الكميات',evidence:{boqItemCount:boq.length},assessment:'requires_planning_review',probability:null,impact:null,score:null});
 if(!m.country)riskSignals.push({code:'PROJECT_LOCATION_MISSING',title:'موقع المشروع غير محدد',evidence:{country:null},assessment:'requires_project_data',probability:null,impact:null,score:null});
 if(!events.length)riskSignals.push({code:'CONTRACT_EVENTS_NOT_REGISTERED',title:'لا توجد أحداث أو إشعارات تعاقدية مسجلة',evidence:{contractEventCount:0},assessment:'register_completeness_check',probability:null,impact:null,score:null});
 const incompleteDisciplines=documentCoverage.filter(x=>x.count===0).map(x=>x.discipline);
 if(docs.length&&incompleteDisciplines.length)riskSignals.push({code:'DISCIPLINE_DOCUMENT_GAPS',title:'نقص مستندات بعض التخصصات',evidence:{missingDisciplines:incompleteDisciplines},assessment:'design_information_review',probability:null,impact:null,score:null});
 // Candidates are not committed as schedule tasks: BOQ quantities alone do not prove duration or logic.
 const scheduleCandidates=boq.map((item,index)=>({sourceBoqItemId:item.id,sequence:index+1,code:item.item_code||null,name:item.description,quantity:Number(item.quantity),unit:item.unit,unitRate:Number(item.rate),lineTotal:Number((Number(item.quantity)*Number(item.rate)).toFixed(3)),durationDays:null,predecessors:[],status:'candidate_requires_planning_inputs',missingInputs:['موارد/فرق التنفيذ','إنتاجية موثقة للوحدة','تقويم أيام العمل','علاقات الاعتماد']}));
 const costBreakdown={pricedItems:boq.filter(x=>Number(x.rate)>0).map(x=>({boqItemId:x.id,description:x.description,quantity:Number(x.quantity),unit:x.unit,unitRate:Number(x.rate),lineTotal:Number((Number(x.quantity)*Number(x.rate)).toFixed(3))})),unpricedItems:unpriced.map(x=>({boqItemId:x.id,description:x.description,quantity:Number(x.quantity),unit:x.unit,missingInputs:['سعر وحدة موثق','مصدر السعر','تاريخ التسعير']}))};
 const rateStatus=boq.length===0?'no_boq':unpriced.length?'partially_unpriced':'priced';
 const scheduleStatus=!tasks.length?'not_generated':'available';
 const riskStatus=!risks.length?'not_generated':'available';
 const missing=[];
 if(!boq.length)missing.push('رفع جدول الكميات أو استيراده إلى سجل BOQ.');
 if(unpriced.length)missing.push('أسعار وحدات موثقة وتاريخ تسعير ومصدر لكل بند غير مسعّر.');
 if(!tasks.length)missing.push('إنتاجيات الموارد/الفرق والتقويم والعلاقات الزمنية لإنشاء مدد وجدول أساس موثوق.');
 if(!risks.length)missing.push('بيانات الموقع والتوريد والعقد والبرنامج لتقييم المخاطر الخاصة بالمشروع.');
 if(!m.country)missing.push('تحديد دولة المشروع لتطبيق التقويم ومراجع الأسعار والمخاطر المحلية.');
 const result={
  project:{id:pid,name:m.name,country:m.country,currency:m.currency},
  generatedAt:new Date().toISOString(),
  branches:{
   documents:{...status(docs.length?'available':'awaiting_upload',docs.length+' مستندات محفوظة',[]),total:docs.length,disciplineCoverage:documentCoverage,latest:docs.slice(0,20)},
   drawingReader:{...status(drawingResults.length?'evidence_available':'awaiting_drawings',drawingResults.length+' نتائج قراءة محفوظة؛ الأدلة لا تعني اعتماد كميات أو إنشاء BIM.',drawingResults.length?[]:['رفع المخططات الإنشائية والمعمارية وMEP.']),results:drawingResults},
   boq:{...status(boq.length?'available':'awaiting_boq',boq.length+' بنود؛ إجمالي البنود المسعّرة '+total.toFixed(3)+' '+(m.currency||'عملة غير محددة'),boq.length?[]:['جدول كميات مع الوصف والوحدة والكمية.']),items:boq,summary:{itemCount:boq.length,pricedItemCount:boq.length-unpriced.length,unpricedItemCount:unpriced.length,knownPricedTotal:Number(total.toFixed(3)),currency:m.currency||null}},
   schedule:{...status(scheduleStatus,tasks.length+' أنشطة معتمدة؛ '+scheduleCandidates.length+' مرشح نشاط من BOQ يحتاج بيانات تخطيط قبل إدخاله في CPM.',tasks.length?[]:['إنتاجية الموارد لكل نشاط.','تقويم أيام العمل والعطل.','علاقات الأنشطة وتواريخ البداية عند إعداد خط الأساس.']),tasks:tasks.map(t=>({...t,predecessors:parse(t.predecessors_json,[]),cpm:cpm.tasks.find(x=>x.id===t.id)||null})),candidates:scheduleCandidates,summary:{taskCount:tasks.length,candidateCount:scheduleCandidates.length,projectDurationWorkingDays:cpm.projectDuration,criticalTaskCount:cpm.criticalTaskCount}},
   cost:{...status(rateStatus,unpriced.length+' بنداً دون سعر وحدة؛ لا تُحتسب أسعار سوقية تلقائياً دون مصدر موثق.',unpriced.length?['مصدر سعر الوحدة وتاريخ التسعير والعملة.']:[]),summary:{knownPricedTotal:Number(total.toFixed(3)),pricedItemCount:boq.length-unpriced.length,unpricedItemCount:unpriced.length,currency:m.currency||null},breakdown:costBreakdown},
   risks:{...status(riskStatus,risks.length+' مخاطر مسجلة؛ إضافة إلى '+riskSignals.length+' مؤشرات مخاطر آلية مستندة إلى نقص/حالة بيانات المشروع وليست درجات مخاطر معتمدة.',risks.length?[]:['سجل المخاطر بالموقع والعقد والتوريد والبرنامج مع تقييم احتمالية وأثر معتمد.']),items:risks.map(x=>({...x,score:Number(x.probability)*Number(x.impact)})),signals:riskSignals,summary:{count:risks.length,signalCount:riskSignals.length,critical:risks.filter(x=>x.probability*x.impact>=15).length,high:risks.filter(x=>x.probability*x.impact>=10&&x.probability*x.impact<15).length}},
   contractsClaims:{...status(events.length?'available':'awaiting_events',events.length+' أحداث تعاقدية مسجلة',events.length?[]:['المراسلات والإشعارات والتواريخ والبنود التعاقدية وأدلة الأثر.']),items:events,summary:{count:events.length,timeImpactDays:events.reduce((s,x)=>s+Number(x.time_impact_days||0),0),costImpact:Number(events.reduce((s,x)=>s+Number(x.cost_impact||0),0).toFixed(3))}},
   bim:{...status(models.length?'model_files_available':'awaiting_model',models.length+' ملفات IFC/GLB محفوظة؛ رفع الملف وحده لا يثبت إنشاء النموذج من المخطط.',models.length?[]:['استخراج عناصر BIM هندسياً من المخططات وربطها بالمقياس والمناسيب.']),models,summary:{count:models.length,ifc:models.filter(x=>x.model_format==='ifc').length,glb:models.filter(x=>x.model_format==='glb').length}},
   progressControl:{...status(tasks.length?'schedule_based':'awaiting_schedule','تقدم المشروع يحسب من الأنشطة المسجلة فقط.',tasks.length?[]:['تحديث الإنجاز الفعلي وتواريخ البدء والانتهاء والقيود.']),summary:{weightedProgress:tasks.length?Number((tasks.reduce((s,t)=>s+Number(t.duration_days||0)*Number(t.percent_complete||0),0)/Math.max(1,tasks.reduce((s,t)=>s+Number(t.duration_days||0),0))).toFixed(1)):0,completed:tasks.filter(x=>x.status==='completed').length,inProgress:tasks.filter(x=>x.status==='in_progress').length,blocked:tasks.filter(x=>x.status==='blocked').length}}
  },
  nextRequiredInputs:[...new Set(missing)],
  automationPolicy:{automaticDocumentRouting:true,automaticQuantityApproval:false,automaticMarketPricing:false,automaticDurationGuessing:false,automaticRiskScoringWithoutEvidence:false,reason:'يتم تجميع النتائج تلقائياً، لكن لا يعتمد النظام كمية أو سعراً أو مدة أو درجة خطر بلا دليل ومدخلات قابلة للتحقق.'}
 };
 res.setHeader('Cache-Control','private, no-store');
 res.json(result);
}));
module.exports=router;
