# Implementation plan

## Boundary and contract

`src/domain/native/kernelBuildConfig.ts` owns the input and result schemas,
reasons, limits and limitations. `src/native/elf/KernelBuildConfig.ts` parses
the banner, the IKCFG framing and the bzImage setup header.
`src/native/elf/KernelCompressionCodec.ts` owns compression magic detection and
is shared with `KernelModuleParser.ts`, so the two parsers name codecs the same
way. `src/native/elf/KernelBuildConfigProvider.ts` reads the file through the
stable artifact read and passes the cancellation signal to the parser.

`src/application/binaryDiagnostics/KernelBuildConfigService.ts` depends on the
domain and `KernelBuildConfigPort`. It is composed in
`src/composition/binaryDiagnostics.ts` and registered through
`capabilityDeclarations.ts`, `capabilityServices.ts` and `createServer.ts`,
beside the sibling binary diagnostics tools.

## Incremental work and validation

1. Define the schemas, reasons and limits, with domain tests.
2. Parse the banner and IKCFG framing over synthetic fixtures, including
   malformed, truncated and decoy members.
3. Add bzImage payload handling and the shared codec detection.
4. Add search budgets and cancellation, with tests for each.
5. Register the CLI command and MCP tool, then add acceptance, filesystem and
   MCP boundary tests.
6. Write the guide and the CLI reference entry, update the skill reference,
   and run focused tests, lint, typecheck and docs checks.

## Effects and compatibility

Additive: one new read-only tool and CLI command. The kernel module parser's
codec detection moves to the shared owner with no change in its output.
