# Implementation plan

## Boundary and contract

`src/domain/native/elfDebugLink.ts` owns the input and result schemas, limits
and limitations. Inputs use `absoluteLocalPathStringSchema`, the shared owner of
the MCP absolute-path rule.

`src/native/elf/ElfDebugLink.ts` decodes the image. Sections come from
`readElfImage` and build-ids from `parseElfNotes`, so ELF headers and note
tables are not re-parsed here. `src/native/elf/ElfDebugLinkProvider.ts` reads
the image and candidate through the stable artifact read. The candidate is
streamed by `streamStableArtifact` in `src/artifacts/readStableArtifact.ts`,
which hashes and CRCs bounded chunks and retains only a caller-sized prefix.

`src/application/binaryDiagnostics/ElfDebugLinkService.ts` depends on the
domain and the `ElfDebugLinkPort`. It is composed in
`src/composition/binaryDiagnostics.ts` and registered through
`capabilityDeclarations.ts`, `capabilityServices.ts` and `createServer.ts`,
beside the sibling binary diagnostics tools.

## Incremental work and validation

1. Define the schemas, limits and limitations, with domain tests.
2. Decode `.gnu_debuglink`, `.gnu_debugaltlink`, `.gnu_debugdata` and build-ids
   over synthetic ELF fixtures for both widths and endiannesses.
3. Add the candidate stream and verification, with service tests for each
   status and for cancellation.
4. Register the CLI command and MCP tool, then add acceptance, filesystem and
   MCP boundary tests, including the absolute-path schema test.
5. Write the guide and the CLI reference entry, update the skill reference,
   and run focused tests, lint, typecheck and test discovery.

## Effects and compatibility

Additive: one new read-only tool and CLI command. Existing tools and Evidence
shapes do not change. The candidate is never executed, and lookup paths are
reported, not opened.
