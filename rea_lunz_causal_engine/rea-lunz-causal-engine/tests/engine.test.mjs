import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalEvidenceEngine, isAllowedUrl, safeQueryTerms, validateEvidenceGraph } from '../src/external-evidence-engine/index.mjs';

const ddg = '<div class="result"><a class="result__a" href="https://github.com/electron/electron/blob/main/README.md">Electron runtime dependency information</a><a class="result__snippet">Electron runtime package dependencies and version behavior.</a></div><div class="result"><a class="result__a" href="https://developer.mozilla.org/en-US/docs/Web/JavaScript">JavaScript execution documentation</a><a class="result__snippet">JavaScript runtime behavior, module imports, and execution semantics.</a></div>';

const makeFetch = () => async (input, options = {}) => {
  const url = String(input);
  if (url.startsWith('https://html.duckduckgo.com/')) return new Response(ddg, { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://registry.npmjs.org/')) return new Response(JSON.stringify({ name: 'electron', description: 'Build cross-platform desktop apps', 'dist-tags': { latest: '31.0.0' }, versions: { '30.0.0': { description: 'Electron desktop runtime', dependencies: { '@electron/get': '^2.0.0' }, repository: { url: 'https://github.com/electron/electron' } } }, repository: { url: 'https://github.com/electron/electron' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.deps.dev/')) return new Response(JSON.stringify({ package: { name: 'electron', system: 'npm' }, version: { version: '30.0.0' }, dependencies: [{ package: { name: '@electron/get' }, version: { version: '2.0.0' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [{ id: 'GHSA-test-1234', aliases: ['CVE-2099-1000'], summary: 'Example electron runtime issue caused by affected dependency', details: 'Test advisory used to verify evidence graph construction.', published: '2026-01-01T00:00:00Z', affected: [{ package: { name: 'electron', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '30.0.1' }] }] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('github.com/electron/electron')) return new Response('<html><head><title>Electron</title></head><body><main>Electron runtime dependency information. This page describes module dependencies and version behavior used by desktop applications.</main></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.includes('developer.mozilla.org')) return new Response('<html><head><title>JavaScript</title></head><body><main>JavaScript runtime behavior, module imports, and execution semantics are described here.</main></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response('not found', { status: 404 });
};

test('allowlist requires HTTPS and rejects local or unapproved destinations', () => {
  assert.equal(isAllowedUrl('https://api.osv.dev/v1/query'), true);
  assert.equal(isAllowedUrl('http://api.osv.dev/v1/query'), false);
  assert.equal(isAllowedUrl('https://127.0.0.1/private'), false);
  assert.equal(isAllowedUrl('https://localhost/internal'), false);
  assert.equal(isAllowedUrl('https://example.invalid/path'), false);
});

test('query sanitizer removes literal source blocks and string contents', () => {
  const query = safeQueryTerms('Investigate `const secret = "raw-code-value";` electron version CVE');
  assert.equal(query.includes('raw-code-value'), false);
  assert.equal(query.includes('const'), false);
});

test('research builds a source-bound graph and deterministic validation result', async () => {
  const engine = createExternalEvidenceEngine({ fetchImpl: makeFetch(), cacheTtlMs: 60000 });
  const result = await engine.research({ query: 'electron runtime dependency issue', packages: [{ name: 'electron', version: '30.0.0' }], maxSources: 12 });
  assert.ok(result.source_count >= 3);
  assert.ok(result.graph.nodes.length >= 4);
  assert.ok(result.graph.edges.some(edge => edge.relation === 'affects_package_version'));
  assert.ok(result.graph.edges.some(edge => edge.relation === 'evidence_for' && edge.target === result.graph.root_node_id));
  assert.equal(result.graph.edges.some(edge => edge.relation === 'supports_hypothesis'), false);
  const dependencyEdge = result.graph.edges.find(edge => edge.relation === 'declares_dependency');
  assert.ok(dependencyEdge);
  assert.equal(result.graph.nodes.find(node => node.id === dependencyEdge.source)?.type, 'package');
  assert.equal(result.graph.nodes.find(node => node.id === dependencyEdge.target)?.properties.package_name, '@electron/get');
  assert.equal(result.validation.valid, true, JSON.stringify(result.validation.errors));
  assert.ok(['validated', 'provisional'].includes(result.validation.status));
  assert.ok(result.graph.sources.every(source => source.excerpt_hash.length === 64));
  const provenanceValidation = engine.validate(result.graph);
  assert.equal(provenanceValidation.valid, true, JSON.stringify(provenanceValidation.errors));
  const tamperedSource = structuredClone(result.graph);
  tamperedSource.sources[0].query = 'modified query metadata';
  const provenanceRejected = engine.validate(tamperedSource);
  assert.equal(provenanceRejected.valid, false);
  assert.ok(provenanceRejected.errors.some(error => error.startsWith('source_ledger_mismatch:')));
  const tamperedEdge = structuredClone(result.graph);
  tamperedEdge.edges[0].relation = 'candidate_causal_link';
  const graphRejected = engine.validate(tamperedEdge);
  assert.equal(graphRejected.valid, false);
  assert.ok(graphRejected.errors.includes('graph_not_in_engine_provenance_ledger'));
});

test('tampered excerpt is rejected by the independent validator', async () => {
  const engine = createExternalEvidenceEngine({ fetchImpl: makeFetch() });
  const result = await engine.research({ query: 'electron runtime dependency issue', packages: [{ name: 'electron', version: '30.0.0' }], maxSources: 12 });
  const tampered = structuredClone(result.graph);
  tampered.sources[0].excerpt = 'asserted without provenance';
  const validation = validateEvidenceGraph(tampered);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.startsWith('source_excerpt_hash_mismatch:')));
});

test('mismatched package API entities are discarded instead of becoming evidence', async () => {
  const mismatchFetch = async input => {
    const url = String(input);
    if (url.startsWith('https://html.duckduckgo.com/')) return new Response('<html></html>', { status: 200 });
    if (url.startsWith('https://registry.npmjs.org/')) return new Response(JSON.stringify({ name: 'other-package', 'dist-tags': { latest: '1.0.0' }, versions: { '30.0.0': { dependencies: { unexpected: '*' } } } }), { status: 200 });
    if (url.startsWith('https://api.deps.dev/')) return new Response(JSON.stringify({ package: { name: 'other-package', system: 'npm' }, version: { version: '30.0.0' }, dependencies: [] }), { status: 200 });
    if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [{ id: 'GHSA-other', affected: [{ package: { name: 'other-package', ecosystem: 'npm' } }] }] }), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const engine = createExternalEvidenceEngine({ fetchImpl: mismatchFetch });
  const result = await engine.research({ query: 'electron runtime dependency issue', packages: [{ name: 'electron', version: '30.0.0' }] });
  assert.equal(result.source_count, 0);
  assert.equal(result.status, 'insufficient_evidence');
  assert.ok(result.warnings.some(value => value.startsWith('npm_registry:exact_entity_match_failed:')));
  assert.ok(result.warnings.some(value => value.startsWith('deps_dev:exact_entity_match_failed:')));
  assert.ok(result.warnings.some(value => value.startsWith('osv_advisory:exact_entity_match_failed:')));
  assert.equal(result.graph.nodes.find(node => node.type === 'package')?.verified, false);
});

test('unverified local facts never become a causal relation', async () => {
  const engine = createExternalEvidenceEngine({ fetchImpl: makeFetch() });
  const result = await engine.research({ query: 'electron runtime dependency issue', packages: [{ name: 'electron', version: '30.0.0' }], targetFacts: [{ id: 'f1', kind: 'package', value: 'electron', evidence_id: 'ev_missing' }], maxSources: 12 });
  assert.equal(result.graph.nodes.some(node => node.type === 'target_fact' && node.verified === false), true);
  assert.equal(result.graph.edges.some(edge => edge.relation === 'candidate_causal_link' && edge.target.includes('fact_')), false);
});
