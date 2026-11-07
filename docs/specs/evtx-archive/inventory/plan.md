# Implementation plan

1. **Domain.** `src/domain/evtxArchive/` owns the result schema and a parser that
   reads the file header and each 64 KiB chunk once, deriving record extent from
   the declared sizes and the chunk offsets, and recording a diagnostic instead
   of guessing when a bound is inconsistent.
2. **Contract.** `src/contracts/evtxArchiveToolContracts.ts` declares one
   provider-free application contract with its input and Evidence output
   schemas, so MCP and CLI share the same shape.
3. **Application.** A shared verified file read owns the 64 MiB admission bound
   and Evidence construction; the MCP and CLI adapters only deliver the retained
   Evidence.
4. **Tests and docs.** Parser tests per diagnostic and per bound, the guide under
   `docs/guides/data/`, the contract reference and this specification.
