import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCodeFidelityReport } from '../src/external-evidence-engine/index.mjs';

test('fidelity report highlights simulated code and unobservable behavior', () => {
  const result = generateCodeFidelityReport({ target: 'Sample app', observations: [
    { id: 'a', path: 'src/original.ts', origin: 'original_source', completeness: 'complete' },
    { id: 'b', path: 'native/handler.c', origin: 'pseudocode', completeness: 'partial', source_visible: false, attempted_simulation: true, content_excerpt: 'unresolved call target ... simulated behavior', issues: ['unresolved_dynamic_dispatch'] },
    { id: 'c', path: 'vendor/hidden.bin', origin: 'unknown', completeness: 'not_visible', limitations: ['Original implementation not visible'] }
  ] });
  assert.equal(result.part_count, 3);
  assert.equal(result.simulated_or_inferred_count >= 1, true);
  assert.equal(result.not_observable_count >= 1, true);
  assert.equal(result.likely_unfaithful_count >= 1, true);
  assert.ok(result.markdown.includes('native/handler.c'));
  assert.ok(result.parts.find(part => part.id === 'b').likely_not_faithful_to_original);
  assert.equal(result.parts.find(part => part.id === 'b').cannot_see_but_may_simulate, true);
});
