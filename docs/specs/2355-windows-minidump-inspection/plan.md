# Plan

1. Confirm the existing recorded-crash surface is ELF-core specific and keep it
   unchanged; add a distinct minidump profile and tool.
2. Define the domain input/output schema with validated ranges, historical IDs
   and explicit limitations.
3. Implement a pure TypeScript bounded parser following the portable PE
   resource parser/provider pattern (stable read, typed failures, cleanup).
4. Add a shared service that validates provider output before Evidence and
   register identical CLI and MCP surfaces through the contract registry.
5. Add hand-authored fixtures and tests for valid, truncated, overlapping,
   incomplete, duplicate, absent-stream, budget and cancellation cases.
6. Document the workflow and run focused tests and static checks.
