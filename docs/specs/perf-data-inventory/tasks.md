# Tasks

- [x] Header inventory with derived byte order and declared extents.
- [x] Event attribute groups with typed fields and the period/frequency bit.
- [x] Bounded identifier retention with diagnostics for unusable extents.
- [x] Coverage and identifier completeness derived from what was read.
- [x] Artifact- and allowance-scoped fact ids.
- [x] CLI/MCP registration, complete-only delivery, operator guide.
- [x] Producer unit tests for malformed, truncated, big-endian and allowance cases.
- [ ] Real-`perf` verification on a Linux host. Not run: this workspace has no
      `perf` binary, so every fixture is constructed from the kernel's on-disk
      layout rather than a recording produced by `perf`. The PR states this.
- [ ] Public CLI/MCP acceptance test on a real recording. Partial: the CLI and
      MCP paths are covered by tests against constructed fixtures only.
