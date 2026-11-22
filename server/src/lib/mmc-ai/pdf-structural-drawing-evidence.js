'use strict';

const normalize = value => String(value || '').normalize('NFKC').replace(/[–—−]/g,'-').replace(/\\s+/g,' ').trim();
const REBAR = /\\b(?:Y|T|Ø|D)\\s*(\\d{1,2})\\s*(?:-\\s*(\\d{2,3})\\s*(?:MM\\s*)?C\\s*\/\\s*C|-\\s*(\\d{1,3})\\s*(?:-\\s*(\\d{2,3})\\s*(?:MM\\s*)?C\\s*\/\\s*C))?/gi;
const VIEW = /\\b(PLAN|SECTION\\s*[A-Z](?:\\s*[-–]\\s*[A-Z])?|ELEVATION|DETAIL\\s*[A-Z0-9.-]*)\\b/gi;

function extractStructuralDrawingEvidence({textLines=[], fullText=''}={}) {
  const lines = (Array.isArray(textLines)?textLines:[]).map((line,index)=>({
    id:line.id||'line-'+(index+1), page:line.page||1, text:normalize(typeof line==='string'?line:line.text)
  })).filter(x=>x.text);
  const sourceText = [fullText,...lines.map(x=>x.text)].filter(Boolean).join('\n');
  const normalized = normalize(sourceText);
  const unitMatch = normalized.match(/ALL\\s+DIMENSIONS?\\s+(?:ARE\\s+)?IN\\s+(MM|MILLIMETERS?|CM|CENTIMETERS?|M|METERS?)\\b/i);
  const unit = unitMatch ? (/^MM|^MILLIMETER/i.test(unitMatch[1])?'mm':/^CM|^CENTIMETER/i.test(unitMatch[1])?'cm':'m') : null;
  const rebar = [];
  for(const line of lines){
    REBAR.lastIndex=0;
    let match;
    while((match=REBAR.exec(line.text))){
      const dia=Number(match[1]);
      const spacing=Number(match[2]||match[4]||0)||null;
      rebar.push({id:line.id,page:line.page,raw:match[0],barDiameterMm:dia,spacingMm:spacing,
        status:spacing?'explicit_bar_diameter_and_spacing':'bar_diameter_or_count_only',quantityEligible:false});
    }
  }
  const views=[];
  for(const line of lines){
    VIEW.lastIndex=0;
    let match;
    while((match=VIEW.exec(line.text))) views.push({id:line.id,page:line.page,label:normalize(match[0])});
  }
  const drawingTitle = normalized.match(/(?:SEPTIC\\s+TANK\\s+REINFORCEMENT\\s+DETAILS|REINFORCEMENT\\s+DETAILS)/i)?.[0]||null;
  const dimensionLikeNumbers = [];
  for(const line of lines){
    if(/^\\d{2,5}(?:\\.\\d+)?$/.test(line.text)) dimensionLikeNumbers.push({
      id:line.id,page:line.page,raw:line.text,value:Number(line.text),unit,
      status:'unassociated_numeric_candidate',quantityEligible:false
    });
  }
  return {
    engine:'mmc-structural-drawing-evidence-v0.1',
    status:rebar.length||views.length||drawingTitle?'evidence_extracted':'no_structural_evidence_found',
    drawingTitle,unit,
    counts:{inputLines:lines.length,rebarCallouts:rebar.length,viewLabels:views.length,unassociatedNumericCandidates:dimensionLikeNumbers.length},
    reinforcementCallouts:rebar,viewLabels:views,unassociatedNumericCandidates:dimensionLikeNumbers,
    limitations:['Text evidence only: no bar lengths, bar shapes, cover, laps, anchorage, element association or reinforcement tonnage inferred.',
      'Standalone numbers are not promoted to dimensions until linked to dimension-line geometry and a drawing view.']
  };
}
module.exports={extractStructuralDrawingEvidence};
