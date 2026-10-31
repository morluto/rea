# Implementation plan

1. Define a provider-neutral `VcpuInterpreterStructure` Evidence schema in
   `src/domain/native/`, including dispatch-loop, dispatch-target,
   handler-entry, state-operand, and coverage records.
2. Add a projection in `src/application/native/` that consumes authenticated
   native-analysis Evidence from the active provider session and emits the
   dossier without executing or mutating the target.
3. Add the first Ghidra-backed adapter under `src/ghidra/`, reusing existing
   instruction, reference, and jump-table facts. Hopper and IDA adapters are
   later increments.
4. Add synthetic fixtures for a complete dispatch table and a partially
   unresolved dispatch path.
5. Register a shared CLI command and MCP tool, preserving caller-selected
   regions and Evidence provenance.
6. Document the workflow in `docs/native-investigation.md` and link the spec
   to the maintainer scope decision.
7. Run focused native-analysis tests, the shared CLI/MCP parity tests, and
   the repository documentation checks.
