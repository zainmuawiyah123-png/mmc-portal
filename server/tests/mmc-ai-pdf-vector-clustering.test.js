'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterVectorPaths, distanceBetweenBounds } = require('../src/lib/mmc-ai/pdf-vector-clustering');

test('clusters nearby vector paths and preserves original one-based path indexes', () => {
  const result = clusterVectorPaths([
    { bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, closed: true },
    { bounds: { minX: 10.5, minY: 0, maxX: 20, maxY: 10 }, closed: false },
    { bounds: { minX: 100, minY: 100, maxX: 110, maxY: 110 }, closed: false }
  ], { tolerancePageUnits: 1 });
  assert.equal(result.clusterCount, 1);
  assert.deepEqual(result.clusters[0].pathIndexes, [1, 2]);
  assert.equal(result.clusters[0].closedPathCount, 1);
  assert.equal(result.clusters[0].openPathCount, 1);
  assert.equal(result.isolatedPathCount, 1);
  assert.equal(result.status, 'spatial_clusters_only_not_element_classification');
});

test('does not merge paths beyond the configured bounding-box tolerance', () => {
  assert.equal(distanceBetweenBounds(
    { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    { minX: 3, minY: 0, maxX: 4, maxY: 1 }
  ), 2);
  const result = clusterVectorPaths([
    { bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
    { bounds: { minX: 3, minY: 0, maxX: 4, maxY: 1 } }
  ], { tolerancePageUnits: 1 });
  assert.equal(result.clusterCount, 0);
  assert.equal(result.isolatedPathCount, 2);
});

test('reports page-unit tolerance and never claims semantic or quantity classification', () => {
  const result = clusterVectorPaths([
    { bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
    { bounds: { minX: 1, minY: 0, maxX: 2, maxY: 1 } }
  ], { pageBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 500 } });
  assert.equal(result.coordinateSystem, 'raw PDF/SVG page units; not real-world dimensions');
  assert.match(result.limitations.join(' '), /not a wall/);
  assert.equal(result.tolerancePageUnits, 2.236068);
});
