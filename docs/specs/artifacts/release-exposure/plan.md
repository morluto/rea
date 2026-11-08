# Implementation plan

## Boundary and contract

`src/domain/releaseExposure.ts` owns the report schema, check ids, statuses,
severities and read allowances. `src/domain/releaseExposureCredentialMarkers.ts`
owns the provider-prefixed marker rules. `src/artifacts/ReleaseExposureReader.ts`
owns the bounded scan of the selected artifact and its members.
`src/application/releaseExposure/ReleaseExposureService.ts` composes the existing
owners through `ReleaseExposurePort` and decides each check from their results.
`src/contracts/releaseExposureToolContracts.ts`, `src/cli/releaseExposureCommands.ts`
and `src/server/registerReleaseExposureTool.ts` are thin adapters over the same
service.

## Changes to existing owners

- `inventoryArtifact` gains optional `acquisitionLimits`. Only this audit sets
  them. Exhausting one keeps a partial inventory with unknown coverage. Other
  callers are unchanged.
- `src/domain/binaryTarget.ts` adds `inspectPeCodeViewFromBuffer`, which
  separates absent CodeView records from incomplete parsing.
  `parsePeCodeViewFromBuffer` keeps its behavior on top of it.
- `src/artifacts/inventory/classify.ts` exports
  `classifyEmbeddedExecutablePackage`, so the audit recognizes a packaged
  executable with the same probes as inventory.
- Declared integrity uses `record-and-continue` for this audit only.

## Change detection

Every file read is bound to its inventoried digest. A file or container whose
bytes differ from inventory at read time adds a change diagnostic and leaves the
affected checks `unknown`. Native images carry their
inventory digest into the Go, Rust and fuse reads.

## Effects and compatibility

The tool is read-only, local and additive to the CLI and MCP catalogs. It adds no
provider and no runtime dependency. `verify:release-exposure` installs
`@electron/fuses` into a temporary prefix when it runs.
