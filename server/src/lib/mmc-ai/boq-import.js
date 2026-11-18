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
  // Detect delimiters across several non-empty lines; exported BOQs may have a title row first.
  const sample = text.split(/\\r?\\n/).filter(line=>line.trim()!=='').slice(0,20);
  const candidates = [',', ';', '\\t'];
  const delimiter = candidates.map(d => {
    const counts=sample.map(line=>line.split(d).length-1).filter(n=>n>0);
    const total=counts.reduce((x,y)=>x+y,0);
    const consistency=counts.length?counts.length/sample.length:0;
    return {d,score:total*consistency};
  }).sort((x,y)=>y.score-x.score)[0].d;
  const rows = []; let row = [], field = '', quoted = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) {
      if (c === '"' && text[i+1] === '"') { field+='"'; i++; }
      else if (c === '"') quoted=false;
      else field+=c;
    } else if (c === '"' && field.length===0) quoted=true;
    else if (c === delimiter) { row.push(field); field=''; }
    else if (c === '\n' || c === '\r') {
      if (c==='\r' && text[i+1]==='\n') i++;
      row.push(field); field=''; if (row.some(v=>String(v).trim()!=='')) rows.push(row); row=[];
    } else field+=c;
  }
  row.push(field); if (row.some(v=>String(v).trim()!=='')) rows.push(row);
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
  const files=zipEntries(buffer);
  const ss=files.get('xl/sharedStrings.xml')||'';
  const shared=[];
  for(const si of ss.matchAll(/<(?:\\w+:)?si(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?si>/g)) {
    shared.push([...si[1].matchAll(/<(?:\\w+:)?t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?t>/g)].map(m=>xmlDecode(m[1])).join(''));
  }
  const sheetNames=[...files.keys()].filter(k=>/^xl\\/worksheets\\/sheet\\d+\\.xml$/.test(k));
  if(!sheetNames.length) throw new Error('ملف Excel لا يحتوي ورقة عمل قابلة للقراءة.');
  function readSheet(xml) {
    const rows=[];
    for(const rm of xml.matchAll(/<(?:\\w+:)?row(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?row>/g)) {
      const row=[];
      for(const cm of rm[1].matchAll(/<(?:\\w+:)?c(?:\\s[^>]*)?(?:\\/>|>([\\s\\S]*?)<\\/(?:\\w+:)?c>)/g)) {
        const tag=cm[0].slice(0,cm[0].indexOf('>')+1), ref=attr(tag,'r'), type=attr(tag,'t'), body=cm[1]||'';
        const vm=body.match(/<(?:\\w+:)?v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?v>/);
        let value=vm?xmlDecode(vm[1]):'';
        if(type==='s') value=shared[Number(value)]??'';
        else if(type==='inlineStr') value=[...body.matchAll(/<(?:\\w+:)?t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?t>/g)].map(m=>xmlDecode(m[1])).join('');
        else if(type==='str'&&!vm) value='';
        const index=colIndex(ref);
        if(index>=0) row[index]=value;
      }
      rows.push(row.map(v=>v??''));
    }
    return rows;
  }
  // Do not assume sheet1 is the BOQ: workbooks often contain cover/instructions sheets first.
  // Select the worksheet whose first 20 rows contain the greatest number of recognized BOQ headers.
  let bestRows=[],bestScore=0;
  for(const name of sheetNames) {
    const rows=readSheet(files.get(name)||'');
    let score=0;
    for(const row of rows.slice(0,20)) {
      const cells=row.map(normalizeHeader);
      const found=['description','unit','quantity'].filter(field=>
        cells.some(cell=>(ALIASES[field]||[]).some(alias=>normalizeHeader(alias)===cell))
      ).length;
      score=Math.max(score,found);
    }
    if(score>bestScore) { bestScore=score; bestRows=rows; }
    if(score===3) return rows;
  }
  if(bestRows.length) return bestRows;
  throw new Error('لم أتمكن من قراءة صفوف جدول Excel. تأكد أن الملف بصيغة XLSX غير محمية.');
}
function normalizeHeader(value) {
  return String(value??'').normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670]/g,'').replace(/[ـ]/g,'').replace(/[\s_\-./()]+/g,'').trim();
}
const ALIASES = {
  description:['description','itemdescription','workdescription','item','name','details','scope','الوصف','وصفالبند','البيان','بيانالاعمال','العمل','وصفالعمل'],
  unit:['unit','uom','unitofmeasure','measurementunit','الوحدة','وحدة','وحدةالقياس'],
  quantity:['quantity','qty','qnty','amount','الكمية','كميه','العدد'],
  rate:['unitrate','rate','price','unitprice','السعر','سعرالوحدة','سعرالوحده','سعر'],
  itemCode:['itemcode','code','ref','reference','رقمالبند','الكود','الرمز'],
  discipline:['discipline','trade','category','التخصص','القسم','الفئة']
};
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
  for(let i=0;i<Math.min(matrix.length,100);i++){
    const cells=matrix[i].map(normalizeHeader), candidate={};
    for(const [field,names] of Object.entries(ALIASES)){
      const at=cells.findIndex(c=>names.some(a=>normalizeHeader(a)===c));
      if(at>=0) candidate[field]=at;
    }
    if(candidate.description!==undefined&&candidate.unit!==undefined&&candidate.quantity!==undefined){headerIndex=i;mapping=candidate;break;}
  }
  if(headerIndex<0) throw new Error('لم أتعرف على أعمدة الوصف والوحدة والكمية. استخدم Description / Unit / Quantity أو العناوين العربية المكافئة.');
  const items=[], errors=[], duplicates=[], seen=new Map();
  for(let i=headerIndex+1;i<matrix.length;i++){
    const row=matrix[i], get=k=>mapping[k]===undefined?'':String(row[mapping[k]]??'').trim();
    const description=get('description'), unit=get('unit'), rawQty=get('quantity');
    if(!description&&!unit&&!rawQty) continue;
    const quantity=parseNumber(rawQty);
    const issue=[];
    if(!description) issue.push('الوصف مفقود');
    if(!unit) issue.push('الوحدة مفقودة');
    if(quantity===null||Number.isNaN(quantity)||quantity<0) issue.push('الكمية غير صالحة أو مفقودة');
    const rateRaw=get('rate'), rate=rateRaw===''?null:parseNumber(rateRaw);
    if(rateRaw!==''&&(rate===null||Number.isNaN(rate)||rate<0)) issue.push('سعر الوحدة غير صالح');
    const item={rowNumber:i+1,itemCode:get('itemCode')||null,description,unit,quantity,rate,discipline:get('discipline')||null};
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
  return {...normalizeRows(matrix),sourceFormat:ext};
}
module.exports={parseBoqFile,normalizeRows,csvRows,xlsxRows,parseNumber};
