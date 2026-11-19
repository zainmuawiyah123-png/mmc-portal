'use strict';
/**
 * MMC AI BOQ import foundation.
 * Reads CSV (UTF-8/UTF-16LE) and XLSX without executing workbook content.
 * It extracts tabular values only; it does not invent missing quantities or rates.
 */
const zlib = require('node:zlib');

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) { const x = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = x; }
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}
function csvRows(text) {
  // Detect the separator across non-empty lines, including files with a title row.
  const sample = text.split(/\r?\n/).filter(line => line.trim() !== '').slice(0, 20);
  const candidates = [',', ';', '\t'];
  const delimiter = candidates.map(d => {
    const counts = sample.map(line => line.split(d).length - 1).filter(n => n > 0);
    const total = counts.reduce((x, y) => x + y, 0);
    const consistency = counts.length ? counts.length / sample.length : 0;
    return { d, score: total * consistency };
  }).sort((x, y) => y.score - x.score)[0].d;
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => String(v).trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(v => String(v).trim() !== '')) rows.push(row);
  return rows;
}
function zipEntries(buffer) {
  // Locate End of Central Directory; XLSX files are ordinary ZIP containers.
  let eocd=-1, min=Math.max(0,buffer.length-65557);
  for(let i=buffer.length-22;i>=min;i--) if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0) throw new Error('ملف XLSX غير صالح: لم يتم العثور على فهرس ZIP.');
  const count=buffer.readUInt16LE(eocd+10), offset=buffer.readUInt32LE(eocd+16), out=new Map();
  let p=offset;
  for(let n=0;n<count;n++){
    if(buffer.readUInt32LE(p)!==0x02014b50) throw new Error('ملف XLSX غير صالح: فهرس ZIP تالف.');
    const method=buffer.readUInt16LE(p+10), compressed=buffer.readUInt32LE(p+20);
    const nameLen=buffer.readUInt16LE(p+28), extraLen=buffer.readUInt16LE(p+30), commentLen=buffer.readUInt16LE(p+32);
    const localOffset=buffer.readUInt32LE(p+42), name=buffer.toString('utf8',p+46,p+46+nameLen);
    if(buffer.readUInt32LE(localOffset)!==0x04034b50) throw new Error('ملف XLSX غير صالح: بيانات ZIP تالفة.');
    const ln=buffer.readUInt16LE(localOffset+26), le=buffer.readUInt16LE(localOffset+28);
    const start=localOffset+30+ln+le, packed=buffer.subarray(start,start+compressed);
    let data;
    if(method===0) data=Buffer.from(packed);
    else if(method===8) data=zlib.inflateRawSync(packed);
    else throw new Error('طريقة ضغط XLSX غير مدعومة.');
    out.set(name,data.toString('utf8'));
    p+=46+nameLen+extraLen+commentLen;
  }
  return out;
}
function xmlDecode(s) {
  return String(s||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function attr(tag,name) {
  const m=tag.match(new RegExp('(?:^|\\s)'+name+'="([^"]*)"'));
  return m?xmlDecode(m[1]):'';
}
function colIndex(ref) {
  const letters=(String(ref).match(/[A-Z]+/i)||['A'])[0].toUpperCase(); let n=0;
  for(const c of letters)n=n*26+c.charCodeAt(0)-64;
  return n-1;
}
function xlsxRows(buffer) {
  const files = zipEntries(buffer);
  const sharedXml = files.get('xl/sharedStrings.xml') || '';
  const shared = [];
  for (const si of sharedXml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    shared.push([...si[1].matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => xmlDecode(m[1])).join(''));
  }
  const sheetNames = [...files.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetNames.length) throw new Error('ملف Excel لا يحتوي ورقة عمل قابلة للقراءة.');
  function readSheet(xml) {
    const rows = [];
    for (const rm of xml.matchAll(/<(?:\w+:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<(?:\w+:)?c(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const tagEnd = cm[0].indexOf('>');
        const tag = tagEnd >= 0 ? cm[0].slice(0, tagEnd + 1) : cm[0];
        const ref = attr(tag, 'r'), type = attr(tag, 't'), body = cm[1] || '';
        const vm = body.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/);
        let value = vm ? xmlDecode(vm[1]) : '';
        if (type === 's') value = shared[Number(value)] ?? '';
        else if (type === 'inlineStr') {
          value = [...body.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => xmlDecode(m[1])).join('');
        }
        const index = colIndex(ref);
        if (index >= 0) row[index] = value;
      }
      rows.push(row.map(value => value ?? ''));
    }
    return rows;
  }
  // Read every worksheet with a recognizable BOQ table. Some tenders contain
  // several sections and repeat their column headings throughout the sheet.
  const combined = [];
  const acceptedSheets = [], skippedSheets = [], inferredSheets = [];
  for (const name of sheetNames) {
    const rows = readSheet(files.get(name) || '');
    const hasSingleHeader = rows.some(row => hasBoqHeader(row));
    const hasSplitHeader = rows.some((row, i) => i + 1 < rows.length &&
      hasBoqHeader([...row, ...rows[i + 1]]));
    if (!hasSingleHeader && !hasSplitHeader) {
      // A headerless tender tab may still expose a verifiable fixed layout:
      // description in B, recognized unit in C, numeric quantity in D.
      const inferred = rows.filter(row => {
        const description = String(row[1] ?? '').trim();
        const unit = normalizeUnit(row[2]);
        const quantity = parseNumber(row[3]);
        return description.length > 0 && unit.known && quantity !== null &&
          Number.isFinite(quantity) && quantity >= 0;
      });
      if (!inferred.length) {
        skippedSheets.push(name);
        continue;
      }
      acceptedSheets.push(name);
      inferredSheets.push(name);
      combined.push(['Item Code','Description','Unit','Quantity','Unit Rate','Amount']);
      for (const row of inferred) combined.push(['',row[1],row[2],row[3],row[4] ?? '',row[5] ?? '']);
      combined.push([]);
      continue;
    }
    acceptedSheets.push(name);
    // Join a two-line heading (description on one row, unit/quantity on next).
    for (let i = 0; i < rows.length; i++) {
      if (i + 1 < rows.length && hasSplitHeaderPair(rows[i], rows[i + 1])) {
        const merged = [];
        const width = Math.max(rows[i].length, rows[i + 1].length);
        for (let c = 0; c < width; c++) {
          merged[c] = normalizeHeader(rows[i][c]) ? rows[i][c] : (rows[i + 1][c] || '');
        }
        combined.push(merged);
        i++;
      } else {
        combined.push(rows[i]);
      }
    }
    combined.push([]);
  }
  if (!acceptedSheets.length) throw new Error('لم أتمكن من العثور على ورقة تحتوي عناوين جدول كميات واضحة.');
  combined.sourceSheets = acceptedSheets;
  combined.skippedSheets = skippedSheets;
  combined.inferredSheets = inferredSheets;
  return combined;
}
function hasBoqHeader(row) {
  const cells = row.map(normalizeHeader);
  return ['description','unit','quantity'].every(field =>
    cells.some(cell => (ALIASES[field] || []).some(alias => normalizeHeader(alias) === cell))
  );
}
function hasSplitHeaderPair(first, second) {
  const a = first.map(normalizeHeader), b = second.map(normalizeHeader);
  const desc = a.some(cell => ALIASES.description.some(alias => normalizeHeader(alias) === cell)) ||
    b.some(cell => ALIASES.description.some(alias => normalizeHeader(alias) === cell));
  const unit = a.some(cell => ALIASES.unit.some(alias => normalizeHeader(alias) === cell)) ||
    b.some(cell => ALIASES.unit.some(alias => normalizeHeader(alias) === cell));
  const qty = a.some(cell => ALIASES.quantity.some(alias => normalizeHeader(alias) === cell)) ||
    b.some(cell => ALIASES.quantity.some(alias => normalizeHeader(alias) === cell));
  return desc && unit && qty && !hasBoqHeader(first) && !hasBoqHeader(second);
}
function normalizeHeader(value) {
  return String(value??'').normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g,'')
    .replace(/[ـ]/g,'')
    .replace(/[أإآٱ]/g,'ا')
    .replace(/ى/g,'ي')
    .replace(/ة/g,'ه')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u200c\u200d\ufeff]/g,'')
    .replace(/[\s_\-./()\[\]{}:：،؛]+/g,'').trim();
}
const ALIASES = {
  description:['description','itemdescription','workdescription','item','name','details','scope','الوصف','وصفالبند','وصفالاعمال','وصفالعمل','البيان','بيانالاعمال','بيانالعمل','اسم البند','البند','تفاصيلالبند','العمل','نوعالعمل'],
  unit:['unit','uom','unitofmeasure','measurementunit','الوحدة','وحدة','وحدةالقياس','وحدة القياس'],
  quantity:['quantity','qty','qnty','amount','الكمية','كميه','كمية','كميات','العدد','الكميةالاجمالية','اجماليالكمية','الكميةالمطلوبة','كميةالبند'],
  rate:['unitrate','rate','price','unitprice','السعر','سعرالوحدة','سعرالوحده','سعر'],
  itemCode:['itemcode','code','ref','reference','رقمالبند','الكود','الرمز'],
  discipline:['discipline','trade','category','التخصص','القسم','الفئة']
};
const UNIT_MAP = Object.freeze({
  m:'m', meter:'m', metre:'m', meters:'m', metres:'m', lm:'m', 'م':'m', 'متر':'m', 'متر طولي':'m',
  m2:'m2', 'm²':'m2', sqm:'m2', 'sq m':'m2', 'م2':'m2', 'م²':'m2', 'متر مربع':'m2',
  m3:'m3', 'm³':'m3', cum:'m3', 'م3':'m3', 'م³':'m3', 'متر مكعب':'m3',
  nr:'nr', no:'nr', nos:'nr', ea:'nr', each:'nr', pcs:'nr', pc:'nr', 'عدد':'nr', 'حبة':'nr',
  kg:'kg', kgs:'kg', kilogram:'kg', kilograms:'kg', 'كجم':'kg', 'كغم':'kg', 'كغ':'kg', 'كيلوغرام':'kg', 'كيلوجرام':'kg',
  ton:'ton', tonne:'ton', tons:'ton', tonnes:'ton', 'طن':'ton',
  ls:'ls', lsum:'ls', 'lump sum':'ls', 'مقطوعية':'ls'
});
function normalizeUnit(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { unit:null, known:false, raw:null };
  const original = String(raw).trim();
  const text = original.normalize('NFKC');
  const key = normalizeHeader(text);
  const direct = UNIT_MAP[original.toLowerCase()] || UNIT_MAP[text.toLowerCase()] || UNIT_MAP[key];
  return direct ? {unit:direct,known:true,raw:original} : {unit:original.slice(0,24),known:false,raw:original};
}
function parseNumber(value) {
  let s=String(value??'').trim().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
  if(!s) return null;
  s=s.replace(/[\u066C,](?=\d{3}(?:\D|$))/g,'').replace(/\u066B/g,'.').replace(/,/g,'.');
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return NaN;
  const n=Number(s); return Number.isFinite(n)?n:NaN;
}
function normalizeRows(matrix) {
  if(!matrix.length) throw new Error('الملف فارغ.');
  let headerIndex=-1, mapping={};
  const findMapping = row => {
    const cells = row.map(normalizeHeader), candidate = {};
    for (const [field,names] of Object.entries(ALIASES)) {
      const at = cells.findIndex(c => names.some(a => normalizeHeader(a) === c));
      if (at >= 0) candidate[field] = at;
    }
    return candidate;
  };
  for(let i=0;i<Math.min(matrix.length,1000);i++){
    const candidate=findMapping(matrix[i]);
    if(candidate.description!==undefined&&candidate.unit!==undefined&&candidate.quantity!==undefined){
      headerIndex=i; mapping=candidate; break;
    }
  }
  if(headerIndex<0) throw new Error('لم أتعرف على أعمدة الوصف والوحدة والكمية. استخدم Description / Unit / Quantity أو العناوين العربية المكافئة.');
  const items=[], errors=[], duplicates=[], seen=new Map();
  for(let i=headerIndex+1;i<matrix.length;i++){
    const row=matrix[i];
    if (!row || !row.some(v => String(v ?? '').trim())) continue;
    const repeated = findMapping(row);
    if (repeated.description!==undefined&&repeated.unit!==undefined&&repeated.quantity!==undefined) {
      mapping = repeated;
      continue;
    }
    const get=k=>mapping[k]===undefined?'':String(row[mapping[k]]??'').trim();
    const description=get('description'), unit=get('unit'), rawQty=get('quantity');
    if(!description&&!unit&&!rawQty) continue;
    const quantity=parseNumber(rawQty);
    const issue=[];
    if(!description) issue.push('الوصف مفقود');
    if(!unit) issue.push('الوحدة مفقودة');
    if(quantity===null||Number.isNaN(quantity)||quantity<0) issue.push('الكمية غير صالحة أو مفقودة');
    const rateRaw=get('rate'), rate=rateRaw===''?null:parseNumber(rateRaw);
    if(rateRaw!==''&&(rate===null||Number.isNaN(rate)||rate<0)) issue.push('سعر الوحدة غير صالح');
    const unitInfo=normalizeUnit(unit);
    const item={rowNumber:i+1,itemCode:get('itemCode')||null,description,unit,unitNormalized:unitInfo.unit,unitKnown:unitInfo.known,quantity,rate,discipline:get('discipline')||null};
    if(issue.length) errors.push({rowNumber:i+1,issues:issue,source:item}); else {
      const key=[normalizeHeader(description),normalizeHeader(unit),String(quantity)].join('|');
      if(seen.has(key)){item.duplicateOfRowNumber=seen.get(key);duplicates.push({rowNumber:i+1,duplicateOfRowNumber:seen.get(key),item});}
      else { seen.set(key,i+1); items.push(item); }
    }
  }
  return {headerRow:headerIndex+1,items,errors,duplicates,summary:{rowsRead:matrix.length-headerIndex-1,validItems:items.length,errorRows:errors.length,duplicateRows:duplicates.length}};
}
function parseBoqFile({buffer,filename}) {
  if(!Buffer.isBuffer(buffer)||!buffer.length) throw new Error('لم يتم استلام ملف.');
  const ext=String(filename||'').toLowerCase().split('.').pop();
  let matrix;
  if(ext==='csv'||ext==='txt') matrix=csvRows(decodeText(buffer));
  else if(ext==='xlsx') matrix=xlsxRows(buffer);
  else throw new Error('الصيغ المدعومة: XLSX وCSV فقط.');
  const parsed = normalizeRows(matrix);
  return {...parsed,sourceFormat:ext,sourceSheets:matrix.sourceSheets||[],warnings:[...(matrix.skippedSheets||[]).map(name=>({code:'SHEET_SKIPPED_NO_HEADERS',sheet:name,message:'لم تُستورد هذه الورقة لعدم وجود عناوين أو نمط أعمدة موثوق؛ لم يتم تخمين البيانات.'})),...(matrix.inferredSheets||[]).map(name=>({code:'HEADERLESS_LAYOUT_INFERRED',sheet:name,message:'تم التعرف على ترتيب الوصف والوحدة والكمية من نمط الأعمدة B/C/D بعد التحقق من وصف ووحدة معروفة وكمية رقمية.'}))]};
}
module.exports={parseBoqFile,normalizeRows,csvRows,xlsxRows,parseNumber,normalizeUnit,UNIT_MAP};
