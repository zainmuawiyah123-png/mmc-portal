'use strict';

/**
 * Conservative SVG path geometry kernel for the MMC AI PDF-vector pipeline.
 *
 * This module deliberately supports only straight-segment SVG paths (M/L/H/V/Z).
 * Curves, arcs and unsupported commands are rejected instead of being silently
 * approximated. Coordinates remain in SVG page units until an explicit scale
 * calibration is supplied. This is geometry evidence, not engineering meaning.
 */

const TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g;
const round = value => Number(value.toFixed(6));

function tokenizePathData(data) {
  if (typeof data !== 'string' || !data.trim()) throw new TypeError('SVG path data is required');
  const tokens = data.match(TOKEN) || [];
  const residue = data.replace(TOKEN, '').replace(/[\s,]/g, '');
  if (residue) throw new TypeError('SVG path contains invalid tokens');
  return tokens;
}

function measureSvgPathData(data) {
  const tokens = tokenizePathData(data);
  const paths = [];
  let i = 0, command = null, current = { x: 0, y: 0 }, start = null, points = [];

  const isCommand = value => /^[a-zA-Z]$/.test(value);
  const readNumber = () => {
    if (i >= tokens.length || isCommand(tokens[i])) throw new TypeError('SVG path command has incomplete coordinates');
    const value = Number(tokens[i++]);
    if (!Number.isFinite(value)) throw new TypeError('SVG path coordinate must be finite');
    return value;
  };
  const finish = closed => {
    if (points.length) {
      const distinct = points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y
        ? points.slice(0, -1) : points.slice();
      let length = 0;
      for (let j = 1; j < points.length; j++) length += Math.hypot(points[j].x - points[j - 1].x, points[j].y - points[j - 1].y);
      if (closed && points.length > 1 && (points[0].x !== points[points.length - 1].x || points[0].y !== points[points.length - 1].y)) {
        length += Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
      }
      let twiceArea = 0;
      if (closed && distinct.length >= 3) {
        for (let j = 0; j < distinct.length; j++) {
          const a = distinct[j], b = distinct[(j + 1) % distinct.length];
          twiceArea += a.x * b.y - b.x * a.y;
        }
      }
      paths.push({
        closed,
        points: points.map(p => ({ x: round(p.x), y: round(p.y) })),
        lengthUnits: round(length),
        areaSquareUnits: closed ? round(Math.abs(twiceArea) / 2) : null,
        vertexCount: distinct.length
      });
    }
    points = [];
  };
  const addPoint = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('SVG path coordinates must be finite');
    current = { x, y };
    points.push({ x, y });
  };

  while (i < tokens.length) {
    if (isCommand(tokens[i])) command = tokens[i++];
    if (!command) throw new TypeError('SVG path must begin with a command');
    const relative = command === command.toLowerCase();
    const op = command.toUpperCase();
    if (!['M', 'L', 'H', 'V', 'Z'].includes(op)) {
      throw new TypeError('Unsupported SVG path command: ' + command);
    }
    if (op === 'Z') {
      if (start && points.length) {
        if (current.x !== start.x || current.y !== start.y) points.push({ x: start.x, y: start.y });
        current = { ...start };
        finish(true);
      }
      command = null;
      start = null;
      continue;
    }
    if (i >= tokens.length || isCommand(tokens[i])) throw new TypeError('SVG path command has no coordinates');
    let consumed = false;
    while (i < tokens.length && !isCommand(tokens[i])) {
      if (op === 'M' || op === 'L') {
        const x = readNumber(), y = readNumber();
        const point = relative ? { x: current.x + x, y: current.y + y } : { x, y };
        if (op === 'M') {
          if (points.length) finish(false);
          addPoint(point.x, point.y);
          start = { ...current };
          command = relative ? 'l' : 'L';
        } else addPoint(point.x, point.y);
      } else if (op === 'H') {
        const x = readNumber(); addPoint(relative ? current.x + x : x, current.y);
      } else if (op === 'V') {
        const y = readNumber(); addPoint(current.x, relative ? current.y + y : y);
      }
      consumed = true;
      if (op === 'M') break;
    }
    if (!consumed) throw new TypeError('SVG path command has no coordinates');
  }
  if (points.length) finish(false);
  return {
    engine: 'mmc-svg-straight-path-geometry-v1',
    supportedCommands: ['M', 'L', 'H', 'V', 'Z'],
    pathCount: paths.length,
    paths,
    limitations: [
      'Curves, arcs, SVG transforms, clipping, stroke widths and compound fill rules are not interpreted.',
      'Coordinates are raw SVG page units; no real-world dimensions are inferred.',
      'Closed-path area is geometric evidence only and is not classified as a slab, wall, excavation or BOQ item.'
    ]
  };
}

function calibrateSvgPage({ pointA, pointB, knownDistanceMm } = {}) {
  for (const [label, point] of [['pointA', pointA], ['pointB', pointB]]) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError(label + ' requires finite x and y');
  }
  if (!Number.isFinite(knownDistanceMm) || knownDistanceMm <= 0) throw new TypeError('knownDistanceMm must be greater than zero');
  const pageDistanceUnits = Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
  if (!Number.isFinite(pageDistanceUnits) || pageDistanceUnits <= 0) throw new RangeError('Calibration points must be distinct');
  const mmPerSvgUnit = knownDistanceMm / pageDistanceUnits;
  return {
    method: 'two_point_explicit_dimension_calibration',
    knownDistanceMm,
    pageDistanceUnits: round(pageDistanceUnits),
    mmPerSvgUnit: round(mmPerSvgUnit),
    metresPerSvgUnit: round(mmPerSvgUnit / 1000),
    source: 'user_or_engineer_confirmed_dimension',
    approvalEligible: false
  };
}

function applySvgCalibration(geometry, calibration) {
  if (!geometry || !Array.isArray(geometry.paths)) throw new TypeError('parsed SVG geometry is required');
  if (!calibration || !Number.isFinite(calibration.mmPerSvgUnit) || calibration.mmPerSvgUnit <= 0) {
    throw new TypeError('explicit SVG calibration is required');
  }
  const metresPerUnit = calibration.mmPerSvgUnit / 1000;
  return {
    engine: 'mmc-svg-calibrated-geometry-v1',
    sourceEngine: geometry.engine,
    scale: { mmPerSvgUnit: calibration.mmPerSvgUnit, source: calibration.source || 'explicit_calibration' },
    paths: geometry.paths.map((path, index) => ({
      pathIndex: index,
      closed: path.closed,
      vertexCount: path.vertexCount,
      lengthM: round(path.lengthUnits * metresPerUnit),
      areaM2: path.closed && path.areaSquareUnits !== null
        ? round(path.areaSquareUnits * metresPerUnit * metresPerUnit) : null,
      reviewState: 'requires_engineering_review',
      approvalEligible: false
    })),
    limitations: [
      'Calibration is valid only for the same page coordinate space and undistorted view.',
      'No drawing element classification or BOQ mapping is performed.',
      'Curved, transformed, clipped or otherwise unsupported vector geometry must be resolved before measurement.'
    ]
  };
}

module.exports = { tokenizePathData, measureSvgPathData, calibrateSvgPage, applySvgCalibration };
