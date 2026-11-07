# Implementation plan

1. **Domain.** `src/domain/otlpTrace/` owns the result schema and a parser that
   walks the recorded resources, scopes and spans once, retains group facts by
   index and records diagnostics rather than resolving them.
2. **Contract.** `src/contracts/otlpTraceToolContracts.ts` declares one
   provider-free application contract with its input and Evidence output
   schemas, so MCP and CLI share the same shape.
3. **Application.** `src/application/otlpTrace/OtlpTraceService.ts` owns the
   verified file read, the input-format rejection and Evidence construction; the
   MCP and CLI adapters only deliver the retained Evidence.
4. **Rejected values.** A value the schema cannot hold is routed through the
   shared raw-field helper, so it is retained rather than dropped, and an
   unrepresentable value fails the import with the file identity.
5. **Tests and docs.** Parser unit tests per diagnostic and retained field, an
   application test for the file and format boundary, the guide under
   `docs/guides/data/`, the contract reference and this specification.
