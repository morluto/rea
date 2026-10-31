# Verification

This proposal is not implemented yet. Before integration, verification should
cover:

- a synthetic native fixture with a complete dispatch table, asserting that
  the dossier reports the loop, every target, and every handler entry;
- a synthetic fixture with computed or opaque dispatch targets, asserting
  that unresolved targets remain explicit and coverage is partial;
- provider refusal when the selected regions are not admitted;
- cancellation before and during projection;
- CLI and MCP parity;
- absence of target execution and mutation;
- preservation of Evidence provenance and unknown coverage.

Real provider verification should initially target Ghidra on a self-owned
fixture. Hopper and IDA coverage should be recorded separately when their
adapters are added.
