# Implementation plan

## Boundary and contract

Add the result and input schemas in `src/domain/vsix/vsixPackage.ts` and the
tool contract in `src/contracts/vsix/vsixPackageToolContracts.ts`, registered
with the tool families, effects and capability declarations. The application
port and service live in `src/application/vsix/`; the service admits one
absolute path and delegates to the parser. The CLI command is
`src/cli/vsixPackageCommands.ts`.

`src/vsix/VsixPackageParser.ts` owns ZIP enumeration, vsixmanifest and
package.json decoding, member kinds, interesting-member hashing and
limitation wording.

## Incremental work and validation

1. Define the domain schema, tool contract and capability registration.
2. Implement bounded ZIP enumeration that stops once the entry allowance is
   exceeded, then vsixmanifest and package.json decoding.
3. Report identity disagreements, activation, contributes, hashed interesting
   members and signature-file presence.
4. Add the service, composition and CLI wiring.
5. Add parser, domain and service tests with synthetic fixtures in
   `src/vsix/VsixPackage.fixture.ts`.
6. Update the usage guide, CLI guide, README and skill references.

## Effects and compatibility

The tool reads one existing local file. Nothing is executed, installed or
downloaded. The change is additive to the CLI and MCP surfaces.
