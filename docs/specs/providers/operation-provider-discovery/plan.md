# Implementation plan

## Boundary and contract

`src/contracts/sessionStatusContract.ts` adds the `operation` detail, the
`operation` input and their pairing rule. `toolOutputSchemaPrimitives.ts` adds
the operation-specific output shape, keyed by `detail` like the summary and
complete shapes.

`CapabilityInventory` stays the owner of tool requirements. `availabilityComposition`
holds the compositions that decide availability; `toolProviderRequirements`
exposes them without a second mapping. The new application projection
`src/application/binary/OperationCandidates.ts` resolves a tool against the
router's declared deep operations and projects each candidate from the existing
`AnalysisProviderCandidateStatus` values. `BinarySessionStatus` emits it for the
operation detail. The MCP registration and the CLI `DirectAnalysisStatus` path
both consume that projection.

Readiness gating is stated by the provider owner. `CapabilityDescriptor` gains an
internal `readinessGated` mark on unavailable capabilities, set by IDA, Kuna and
Ghidra's Windows readiness and existing-project paths. Public capability
projections select their fields explicitly, so the mark is not emitted.

## Incremental work and validation

1. Record the base behaviour and response sizes; add failing application tests.
2. Add the contract, requirements accessor and projection; keep summary and
   complete output unchanged.
3. Add MCP output-schema shapes, hidden-family refusal and representative MCP
   tests; add `capabilities --operation` and its CLI test.
4. Rebase on current `main` and repeat the standard checks.
5. Address automated review: navigation modes, admission before MCP probes,
   resource-only sessions and producer-owned readiness gating, each with a
   regression test that fails without the fix.
6. Run the standard checks and a real-provider workflow on the final revision.

## Effects and compatibility

The view is read-only. It reuses existing candidate statuses and availability
probes and starts no provider; invalid input is refused before discovery. The
input and output additions are additive; `summary` and `complete` are
unchanged. The tool-catalog digest changes with the schema.

## References

- [MCP contracts: binary_session detail](../../../reference/mcp-contracts.md)
- https://github.com/morluto/rea/pull/9299
