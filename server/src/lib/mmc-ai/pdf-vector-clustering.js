'use strict';

function distanceBetweenBounds(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function clusterVectorPaths(paths, options = {}) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array');
  const pageBounds = options.pageBounds || null;
  const pageWidth = pageBounds && Number.isFinite(pageBounds.minX) && Number.isFinite(pageBounds.maxX)
    ? pageBounds.maxX - pageBounds.minX : 0;
  const pageHeight = pageBounds && Number.isFinite(pageBounds.minY) && Number.isFinite(pageBounds.maxY)
    ? pageBounds.maxY - pageBounds.minY : 0;
  const pageDiagonal = Math.hypot(pageWidth, pageHeight);
  const tolerance = Number.isFinite(options.tolerancePageUnits)
    ? Math.max(0, Math.min(options.tolerancePageUnits, 100))
    : Math.max(0.75, Math.min(6, pageDiagonal > 0 ? pageDiagonal * 0.002 : 1));
  const items = paths.map((path, index) => ({ path, index, bounds: path && path.bounds }))
    .filter(item => item.bounds && ['minX','minY','maxX','maxY'].every(key => Number.isFinite(item.bounds[key])) &&
      item.bounds.maxX >= item.bounds.minX && item.bounds.maxY >= item.bounds.minY)
    .sort((a, b) => a.bounds.minX - b.bounds.minX);
  const parent = items.map((_, index) => index);
  const rank = items.map(() => 0);
  const find = value => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value]; parent[value] = root; value = next;
    }
    return root;
  };
  const union = (a, b) => {
    let ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };
  let active = [];
  for (let i = 0; i < items.length; i++) {
    const current = items[i];
    active = active.filter(candidate => items[candidate].bounds.maxX + tolerance >= current.bounds.minX);
    for (const candidate of active) {
      if (distanceBetweenBounds(current.bounds, items[candidate].bounds) <= tolerance) union(i, candidate);
    }
    active.push(i);
  }
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }
  const clusters = [...groups.values()].filter(group => group.length >= 2).map(group => {
    const bounds = {
      minX: Math.min(...group.map(item => item.bounds.minX)),
      minY: Math.min(...group.map(item => item.bounds.minY)),
      maxX: Math.max(...group.map(item => item.bounds.maxX)),
      maxY: Math.max(...group.map(item => item.bounds.maxY))
    };
    const closedCount = group.filter(item => item.path.closed).length;
    return {
      memberCount: group.length,
      pathIndexes: group.map(item => item.index + 1).sort((a, b) => a - b),
      closedPathCount: closedCount,
      openPathCount: group.length - closedCount,
      bounds,
      spanPageUnits: { x: bounds.maxX - bounds.minX, y: bounds.maxY - bounds.minY },
      evidenceType: 'spatially_adjacent_vector_paths',
      interpretation: 'unclassified_geometry_group_requires_drawing_context'
    };
  }).sort((a, b) => b.memberCount - a.memberCount || a.pathIndexes[0] - b.pathIndexes[0]);
  const clusteredPathCount = clusters.reduce((sum, cluster) => sum + cluster.memberCount, 0);
  return {
    status: 'spatial_clusters_only_not_element_classification',
    coordinateSystem: 'raw PDF/SVG page units; not real-world dimensions',
    adjacencyRule: 'minimum axis-aligned bounding-box distance',
    tolerancePageUnits: Number(tolerance.toFixed(6)),
    inputPathCount: paths.length,
    pathsWithValidBounds: items.length,
    clusteredPathCount,
    isolatedPathCount: items.length - clusteredPathCount,
    clusterCount: clusters.length,
    clusters: clusters.slice(0, options.maxClusters || 60),
    truncatedClusters: clusters.length > (options.maxClusters || 60),
    limitations: [
      'Clusters are based only on bounding-box proximity; they do not prove physical connection, parallelism or engineering meaning.',
      'A cluster is not a wall, opening, footing, slab, MEP component, quantity or BIM element.',
      'Tolerance is expressed in raw page units and must not be interpreted as millimetres or metres.',
      'Nearby unrelated drawing details may be grouped; all clusters require visual and engineering review.'
    ]
  };
}

module.exports = { distanceBetweenBounds, clusterVectorPaths };
