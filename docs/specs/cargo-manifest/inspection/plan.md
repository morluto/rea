# Implementation plan

1. **Domain.** `src/domain/cargoManifest/` owns the result schema and a parser
   that reads the decoded TOML once, inventories each dependency table and
   feature, and records a diagnostic instead of synthesizing a value the
   manifest does not state.
2. **Package settings.** `[package]` values that are neither a string nor a
   `workspace = true` inheritance are diagnosed at their own pointer, and an
   unreadable `edition` keeps edition-dependent interpretation unknown.
3. **Contract.** `src/contracts/cargoManifestToolContracts.ts` declares one
   provider-free application contract with its input and Evidence output
   schemas, so MCP and CLI share the same shape.
4. **Application.** A shared verified file read owns the 32 MiB admission bound
   and Evidence construction; the MCP and CLI adapters only deliver the retained
   Evidence.
5. **Tests and docs.** Parser tests per diagnostic and per bound, the guide under
   `docs/guides/data/`, the contract reference and this specification.
