# Raw raster preview tasks

The checklist describes planned verification, not executed results. Update it
only from checks against the final implementation. See [spec](spec.md) and
[plan](plan.md).

- [x] R1: Add pure typed decoding with exact pixel fixtures for all five formats.
- [x] R2: Cover row directions, nonzero offsets, inter-row padding and omitted
      final-row padding; retain the full caller-selected range.
- [x] R3: Exercise malformed dimensions/ranges, arithmetic overflow, short input,
      short stride and input/output allowances; verify input bytes stay unchanged.
- [x] R4: Produce an experimental PNG and reproducible manifest; independently
      decode a tiny fixture and verify all pixels and both hashes.
- [x] R5: Confirm no provider, CLI, MCP, runtime configuration or catalog wiring.
- [x] Run applicable focused tests, test discovery, type/lint and documentation
      checks; report blocked or unrun checks without claiming success.
- [x] Obtain independent diff review and address actionable findings.

## Deferred integration gates

- [ ] Obtain maintainer scope and architecture decisions in #8162.
- [x] Resolve artifact/subject identity and production source acquisition,
      stability, cancellation and evidence semantics using existing owners.
- [ ] Define full-workflow resource accounting and public transport contracts;
      verify real CLI/MCP workflows before enabling them.
- [ ] Human owner reviews the final diff and verification before marking a
      future PR ready for maintainer review.
