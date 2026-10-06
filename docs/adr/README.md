# Architecture decision records

Accepted decisions describe the architecture that implementation PRs must
follow. Acceptance does not by itself mean the behavior is shipped; each record
states its implementation status separately.

| ADR                                                                                                                | Status               | Implementation                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [0001: Provider selection and analysis profiles](0001-provider-selection-and-analysis-profiles.md)                 | Accepted             | Provider selection and 25 read-only Ghidra operations on Linux/macOS and experimental Windows x64 P0; Linux/macOS session annotations |
| [0002: Controlled JavaScript replay authority and sandbox policy](0002-controlled-replay-authority-and-sandbox.md) | Superseded           | Historical design; the controlled JavaScript replay tool was removed                                                                  |
| [0003: Managed-code evidence and provider boundary](0003-managed-code-evidence-and-provider-boundary.md)           | Partially superseded | Seven static managed tools remain; runtime planning removed                                                                           |
