# Architecture decision records

Accepted decisions describe the architecture that implementation PRs must
follow. Acceptance does not by itself mean the behavior is shipped; each record
states its implementation status separately.

| ADR                                                                                                                | Status   | Implementation                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------- |
| [0001: Provider selection and analysis profiles](0001-provider-selection-and-analysis-profiles.md)                 | Accepted | Foundation shipped; capability work continues   |
| [0002: Controlled JavaScript replay authority and sandbox policy](0002-controlled-replay-authority-and-sandbox.md) | Accepted | Linux x86_64 extracted-module replay shipped    |
| [0003: Managed-code evidence and provider boundary](0003-managed-code-evidence-and-provider-boundary.md)           | Accepted | PE/CLI triage shipped; deeper contracts planned |
