# Architecture decision records

Accepted decisions describe the architecture that implementation PRs must
follow. Acceptance does not by itself mean the behavior is shipped; each record
states its implementation status separately.

| ADR                                                                                                                                | Status               | Implementation                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [0001: Provider selection and analysis profiles](0001-provider-selection-and-analysis-profiles.md)                                 | Accepted             | Provider selection and 25 read-only Ghidra operations on Linux/macOS and experimental Windows x64 P0; Linux/macOS session annotations |
| [0002: Controlled JavaScript replay authority and sandbox policy](0002-controlled-replay-authority-and-sandbox.md)                 | Superseded           | Historical design; the controlled JavaScript replay tool was removed                                                                  |
| [0003: Managed-code evidence and provider boundary](0003-managed-code-evidence-and-provider-boundary.md)                           | Partially superseded | Seven static managed tools remain; runtime planning removed                                                                           |
| [0004: Runtime execution boundaries and output budgets](0004-runtime-execution-boundaries-and-output-budgets.md)                   | Accepted             | Native/CDP byte limits and truthful process effects shipped; hardened process-execution policy remains                                |
| [0005: Canonical skill bundle and contained installation](0005-canonical-skill-bundle-and-contained-installation.md)               | Accepted             | Generated digest manifest and contained setup shipped; richer upgrade/doctor policy remains                                           |
| [0006: CI dependency immutability and release artifact identity](0006-ci-dependency-immutability-and-release-artifact-identity.md) | Accepted             | Full-SHA Action pins shipped; pack-once/exact-SHA/readback lifecycle remains a release blocker                                        |
| [0007: Immutable runtime configuration and bounded shutdown](0007-immutable-runtime-configuration-and-bounded-shutdown.md)         | Proposed             | Not implemented; restart-required configuration and bounded shutdown require focused implementation review                            |
