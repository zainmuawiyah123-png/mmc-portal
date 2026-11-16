'use strict';

const TOKEN = /[a-zA-Z]|[-+]?(?:(?:\\d+\\.\\d*)|(?:\\.\\d+)|(?:\\d+))(?:[eE][-+]?\\d+)?/g;
const round = value => Number(value.toFixed(6));
const CURVE_STEPS = 24;
const ARC_STEPS_PER_TURN = 96;

function tokenizePathData(data) {
  if (typeof data !== 'string' || !data.trim()) throw new TypeError('SVG path data is required');
  const tokens = data.match(TOKEN) || [];
  const residue = data.replace(TOKEN, '').replace(/[\\s,]/g, '');
  if (residue) throw new TypeError('SVG path contains invalid tokens');
  return tokens;
}

function measureSvgPathData(data, options = {}) {
  const curveSteps = options.curveSteps ?? CURVE_STEPS;
  const arcStepsPerTurn = options.arcStepsPerTurn ?? ARC_STEPS_PER_TURN;
  if (!Number.isInteger(curveSteps) || curveSteps < 4 || curveSteps > 256) throw new RangeError('curveSteps must be between 4 and 256');
  if (!Number.isInteger(arcStepsPerTurn) || arcStepsPerTurn < 24 || arcStepsPerTurn > 512) throw new RangeError('arcStepsPerTurn must be between 24 and 512');
  const tokens = tokenizePathData(data);
  const paths = [];
  let i = 0, command = null, current = { x: 0, y: 0 }, start = null, points = [];
  let previousControl = null, previousCurve = null;

  const isCommand = value => /^[a-zA-Z]$/.test(value);
  const readNumber = () => {
    if (i >= tokens.length || isCommand(tokens[i])) throw new TypeError('SVG path command has incomplete coordinates');
    const value = Number(tokens[i++]);
    if (!Number.isFinite(value)) throw new TypeError('SVG path coordinate must be finite');
    return value;
  };
  const readFlag = () => {
    const value = readNumber();
    if (value !== 0 && value !== 1) throw new TypeError('SVG arc flags must be 0 or 1');
    return value;
  };
  const finish = closed => {
    if (!points.length) return;
    const distinct = points.length > 1 && points[0].x === points.at(-1).x && points[0].y === points.at(-1).y ? points.slice(0, -1) : points.slice();
    let length = 0;
    for (let j = 1; j < points.length; j++) length += Math.hypot(points[j].x - points[j - 1].x, points[j].y - points[j - 1].y);
    if (closed && points.length > 1 && (points[0].x !== points.at(-1).x || points[0].y !== points.at(-1).y)) length += Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y);
    let twiceArea = 0;
    if (closed && distinct.length >= 3) for (let j = 0; j < distinct.length; j++) {
      const a = distinct[j], b = distinct[(j + 1) % distinct.length];
      twiceArea += a.x * b.y - b.x * a.y;
    }
    paths.push({ closed, points: points.map(p => ({ x: round(p.x), y: round(p.y) })), lengthUnits: round(length), areaSquareUnits: closed ? round(Math.abs(twiceArea) / 2) : null, vertexCount: distinct.length });
    points = [];
  };
  const addPoint = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('SVG path coordinates must be finite');
    current = { x, y };
    const last = points.at(-1);
    if (!last || last.x !== x || last.y !== y) points.push({ x, y });
  };
  const cubic = (p0,p1,p2,p3,t) => {
    const u=1-t;
    return {x:u*u*u*p0.x+3*u*u*t*p1.x+3*u*t*t*p2.x+t*t*t*p3.x,y:u*u*u*p0.y+3*u*u*t*p1.y+3*u*t*t*p2.y+t*t*t*p3.y};
  };
  const quadratic = (p0,p1,p2,t) => {
    const u=1-t;
    return {x:u*u*p0.x+2*u*t*p1.x+t*t*p2.x,y:u*u*p0.y+2*u*t*p1.y+t*t*p2.y};
  };
  const arcPoints = (from, rxInput, ryInput, rotation, largeArc, sweep, to) => {
    let rx=Math.abs(rxInput), ry=Math.abs(ryInput);
    if (rx===0 || ry===0 || (from.x===to.x && from.y===to.y)) return [to];
    const phi=rotation*Math.PI/180, cos=Math.cos(phi), sin=Math.sin(phi);
    const dx=(from.x-to.x)/2, dy=(from.y-to.y)/2;
    const xp=cos*dx+sin*dy, yp=-sin*dx+cos*dy;
    const lambda=xp*xp/(rx*rx)+yp*yp/(ry*ry);
    if(lambda>1){const s=Math.sqrt(lambda);rx*=s;ry*=s;}
    const numerator=Math.max(0,rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp);
    const denominator=rx*rx*yp*yp+ry*ry*xp*xp;
    const sign=largeArc===sweep?-1:1;
    const factor=denominator===0?0:sign*Math.sqrt(numerator/denominator);
    const cxp=factor*(rx*yp/ry), cyp=factor*(-ry*xp/rx);
    const cx=cos*cxp-sin*cyp+(from.x+to.x)/2;
    const cy=sin*cxp+cos*cyp+(from.y+to.y)/2;
    const angle=(ux,uy,vx,vy)=>Math.atan2(ux*vy-uy*vx,ux*vx+uy*vy);
    const ux=(xp-cxp)/rx, uy=(yp-cyp)/ry, vx=(-xp-cxp)/rx, vy=(-yp-cyp)/ry;
    let theta=Math.atan2(uy,ux), delta=angle(ux,uy,vx,vy);
    if(!sweep&&delta>0)delta-=2*Math.PI;
    if(sweep&&delta<0)delta+=2*Math.PI;
    const steps=Math.max(1,Math.ceil(Math.abs(delta)/(2*Math.PI)*arcStepsPerTurn));
    const result=[];
    for(let n=1;n<=steps;n++){const a=theta+delta*n/steps;result.push({x:cx+rx*cos*Math.cos(a)-ry*sin*Math.sin(a),y:cy+rx*sin*Math.cos(a)+ry*cos*Math.sin(a)});}
    result[result.length-1]=to;
    return result;
  };

  while(i<tokens.length){
    if(isCommand(tokens[i])){command=tokens[i++];previousControl=null;previousCurve=null;}
    if(!command)throw new TypeError('SVG path must begin with a command');
    const relative=command===command.toLowerCase(), op=command.toUpperCase();
    if(!'MLHVZCSQTA'.includes(op))throw new TypeError('Unsupported SVG path command: '+command);
    if(op==='Z'){if(start&&points.length){if(current.x!==start.x||current.y!==start.y)points.push({...start});current={...start};finish(true);}command=null;start=null;previousControl=null;previousCurve=null;continue;}
    if(i>=tokens.length||isCommand(tokens[i]))throw new TypeError('SVG path command has no coordinates');
    let consumed=false;
    while(i<tokens.length&&!isCommand(tokens[i])){
      const point=(x,y)=>relative?{x:current.x+x,y:current.y+y}:{x,y};
      if(op==='M'||op==='L'){const p=point(readNumber(),readNumber());if(op==='M'){if(points.length)finish(false);addPoint(p.x,p.y);start={...current};command=relative?'l':'L';}else addPoint(p.x,p.y);}
      else if(op==='H'){const x=readNumber();addPoint(relative?current.x+x:x,current.y);}
      else if(op==='V'){const y=readNumber();addPoint(current.x,relative?current.y+y:y);}
      else if(op==='C'){const p0={...current},p1=point(readNumber(),readNumber()),p2=point(readNumber(),readNumber()),p3=point(readNumber(),readNumber());for(let n=1;n<=curveSteps;n++){const p=cubic(p0,p1,p2,p3,n/curveSteps);addPoint(p.x,p.y);}previousControl=p2;previousCurve='C';}
      else if(op==='S'){const p0={...current},p1=previousCurve==='C'?{x:2*current.x-previousControl.x,y:2*current.y-previousControl.y}:{...current},p2=point(readNumber(),readNumber()),p3=point(readNumber(),readNumber());for(let n=1;n<=curveSteps;n++){const p=cubic(p0,p1,p2,p3,n/curveSteps);addPoint(p.x,p.y);}previousControl=p2;previousCurve='C';}
      else if(op==='Q'){const p0={...current},p1=point(readNumber(),readNumber()),p2=point(readNumber(),readNumber());for(let n=1;n<=curveSteps;n++){const p=quadratic(p0,p1,p2,n/curveSteps);addPoint(p.x,p.y);}previousControl=p1;previousCurve='Q';}
      else if(op==='T'){const p0={...current},p1=previousCurve==='Q'?{x:2*current.x-previousControl.x,y:2*current.y-previousControl.y}:{...current},p2=point(readNumber(),readNumber());for(let n=1;n<=curveSteps;n++){const p=quadratic(p0,p1,p2,n/curveSteps);addPoint(p.x,p.y);}previousControl=p1;previousCurve='Q';}
      else if(op==='A'){const rx=readNumber(),ry=readNumber(),rotation=readNumber(),large=readFlag(),sweep=readFlag(),p=point(readNumber(),readNumber());for(const q of arcPoints(current,rx,ry,rotation,large,sweep,p))addPoint(q.x,q.y);previousControl=null;previousCurve='A';}
      if(!'CSQT'.includes(op)&&op!=='A'){previousControl=null;previousCurve=null;}
      consumed=true;
      if(op==='M')break;
    }
    if(!consumed)throw new TypeError('SVG path command has no coordinates');
  }
  if(points.length)finish(false);
  return { engine:'mmc-svg-flattened-path-geometry-v2', supportedCommands:['M','L','H','V','C','S','Q','T','A','Z'], curveApproximation:{method:'uniform-parametric-polyline',curveSteps,arcStepsPerTurn}, pathCount:paths.length,paths,limitations:['Curves and arcs are approximated by polylines; increase sampling density for precision-sensitive drawings.','Coordinates are raw SVG page units; no real-world dimensions are inferred.','Closed-path area is geometric evidence only and is not classified as a slab, wall, excavation or BOQ item.','Stroke widths, clipping and compound fill rules are not interpreted.'] };
}

function calibrateSvgPage({ pointA, pointB, knownDistanceMm } = {}) {
  for (const [label, point] of [['pointA', pointA], ['pointB', pointB]]) if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError(label + ' requires finite x and y');
  if (!Number.isFinite(knownDistanceMm) || knownDistanceMm <= 0) throw new TypeError('knownDistanceMm must be greater than zero');
  const pageDistanceUnits=Math.hypot(pointB.x-pointA.x,pointB.y-pointA.y);
  if(!Number.isFinite(pageDistanceUnits)||pageDistanceUnits<=0)throw new RangeError('Calibration points must be distinct');
  const mmPerSvgUnit=knownDistanceMm/pageDistanceUnits;
  return {method:'two_point_explicit_dimension_calibration',knownDistanceMm,pageDistanceUnits:round(pageDistanceUnits),mmPerSvgUnit:round(mmPerSvgUnit),metresPerSvgUnit:round(mmPerSvgUnit/1000),source:'user_or_engineer_confirmed_dimension',approvalEligible:false};
}

function applySvgCalibration(geometry,calibration){
  if(!geometry||!Array.isArray(geometry.paths))throw new TypeError('parsed SVG geometry is required');
  if(!calibration||!Number.isFinite(calibration.mmPerSvgUnit)||calibration.mmPerSvgUnit<=0)throw new TypeError('explicit SVG calibration is required');
  const metresPerUnit=calibration.mmPerSvgUnit/1000;
  return {engine:'mmc-svg-calibrated-geometry-v1',sourceEngine:geometry.engine,scale:{mmPerSvgUnit:calibration.mmPerSvgUnit,source:calibration.source||'explicit_calibration'},paths:geometry.paths.map((path,index)=>({pathIndex:index,closed:path.closed,vertexCount:path.vertexCount,lengthM:round(path.lengthUnits*metresPerUnit),areaM2:path.closed&&path.areaSquareUnits!==null?round(path.areaSquareUnits*metresPerUnit*metresPerUnit):null,reviewState:'requires_engineering_review',approvalEligible:false})),limitations:['Calibration is valid only for the same page coordinate space and undistorted view.','No drawing element classification or BOQ mapping is performed.']};
}

module.exports={tokenizePathData,measureSvgPathData,calibrateSvgPage,applySvgCalibration};
