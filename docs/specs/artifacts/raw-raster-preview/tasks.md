# Raw raster preview tasks

The checklist describes planned verification, not executed results. Update it
only from checks against the final implementation. See [spec](spec.md) and
[plan](plan.md).

- [x] R1: Add pure typed decoding with exact pixel fixtures for all six formats.
- [x] R2: Cover row directions, nonzero offsets, inter-row padding and omitted
      final-row padding; retain the full caller-selected range.
- [x] R3: Exercise malformed dimensions/ranges, arithmetic overflow, short input,
      short stride and input/output allowances; verify input bytes stay unchanged.
- [x] R4: Produce an experimental PNG and reproducible manifest; independently
      decode a tiny fixture and verify all pixels and both hashes.
- [x] R5: Keep the experimental script unregistered, without its own provider,
      runtime configuration or catalog wiring.
- [x] R6: Add an experimental file workflow with pre-read range admission, bounded
      positional reads, pre/post descriptor and selected-path checks, original offset
      provenance, source preservation, cleanup and exclusive output tests.
- [x] Run applicable focused tests, test discovery, type/lint and documentation
      checks; report blocked or unrun checks without claiming success.
- [x] Obtain independent diff review and address actionable findings.

- [x] R7: Add configurable conservative PNG working-buffer admission and test
      rejection and explicit override without claiming an RSS ceiling.
- [x] R8: Provide help/actionable errors; pre-serialize and retain failed output
      with a marker where possible, testing real I/O failure without deleting files.
- [x] Validate an external pinned PPM fixture against independent Pillow decoding.

- [x] R9: Add generic indexed4 with explicit palette/nibble order, synthetic
      boundary cases, file CLI verification and independent matrix review.

- [x] Default manifests omit personal paths and filesystem identifiers; explicit
      path opt-in warns clearly and is covered by API/CLI privacy regressions.

## Deferred integration gates

- [ ] Obtain maintainer scope and architecture decisions in #8162.
- [x] Separate discovery workflows reuse existing source identity, acquisition,
      stability, cancellation, Evidence and canonical CLI/MCP contracts. Their
      scope is described in the raw and structured discovery specifications.
- [ ] Human owner reviews the final diff and verification before marking a
      future PR ready for maintainer review.
