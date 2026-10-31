# Tasks

The checked items below record work completed on an earlier revision. The
current revision's final caller-frame assertions, marker-derived line
expectations, timeout handling, and Unicode budget case remain source-reviewed
only; the full native-call verifier is incomplete.

- [x] Define the single-feature scope, contract and implementation plan.
- [x] Reproduce lost source coordinates with producer regression tests.
- [x] Retain line-entry metadata in the producer and canonical schema.
- [x] Verify boundary/MCP propagation and historical omission.
- [x] Historical: verify real CLI/MCP call coordinates on an owned Free Pascal 3.2.2 program.
- [x] Historical: update documentation; pass Python, focused TypeScript, static and discovery checks.
- [ ] Complete the full native-call verifier after investigating #2397.
