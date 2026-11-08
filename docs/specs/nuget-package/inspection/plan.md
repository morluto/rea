# Implementation plan

1. **Domain.** `src/domain/nugetPackage/` owns the result schema and a parser
   that takes the archive's admitted member list and derives each asset's kind,
   framework and RID from its path, recording a diagnostic instead of guessing
   when a path is refused or a document cannot be read. The `.nuspec` is parsed
   through the shared XML owner with document types rejected.
2. **Contract.** `src/contracts/nugetPackageToolContracts.ts` declares one
   provider-free application contract with its input and Evidence output
   schemas, so MCP and CLI share the same shape.
3. **Application.** A shared verified file read owns the 64 MiB admission bound,
   the hardened ZIP reader owns member enumeration and CRCs, and only `.nuspec`
   members are decompressed into a bounded buffer. The service builds the
   Evidence; the MCP and CLI adapters only deliver it.
4. **Tests and docs.** Parser tests per diagnostic and per bound, an end-to-end
   read of a locally constructed package, the guide under `docs/guides/data/`,
   the contract reference and this specification.
