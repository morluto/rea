import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidenceGraph } from '../src/external-evidence-engine/index.mjs';

test('oversized graph is rejected before traversal', () => {
  const validation = validateEvidenceGraph({ schema_version: 'rea-lunz.external-evidence-graph.v1', nodes: Array.from({ length: 5001 }, (_, i) => ({ id: String(i), type: 'node' })), edges: [], sources: [] });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('graph_resource_limit_exceeded'));
});

test('unproven edges and unknown relation types are rejected', () => {
  const graph = { schema_version: 'rea-lunz.external-evidence-graph.v1', nodes: [{ id: 'a', type: 'investigation' }, { id: 'b', type: 'source' }], edges: [{ id: 'e1', source: 'b', target: 'a', relation: 'made_up', status: 'test', score: 0.9, confidence: 0.8, evidence_ids: ['src_missing'] }, { id: 'e2', source: 'b', target: 'a', relation: 'supports_hypothesis', status: 'test', score: 0.9, confidence: 0.8, evidence_ids: ['src_missing'] }], sources: [] };
  const result = validateEvidenceGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('unknown_relation:e1'));
  assert.ok(result.errors.includes('edge_without_valid_evidence:e2'));
});
