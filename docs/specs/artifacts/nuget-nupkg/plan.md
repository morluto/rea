# Implementation plan

## Boundary and contract

Add the result and input schemas in `src/domain/nuget/nupkg.ts` and the tool
contract in `src/contracts/nuget/nupkgToolContracts.ts`, registered with the
tool families, effects and capability declarations. The application port and
service live in `src/application/nuget/`; the service admits one absolute path
and delegates to the parser. The CLI command is `src/cli/nugetNupkgCommands.ts`.

`src/nuget/NugetNupkgParser.ts` owns ZIP enumeration, `.nuspec` selection and
decoding, member roles and limitation wording. Capacity and format failures are
typed in `src/nuget/NugetNupkg.errors.ts`.

## Incremental work and validation

1. Define the domain schema, tool contract and capability registration.
2. Implement bounded ZIP enumeration that stops once the entry allowance is
   exceeded, then OPC and root `.nuspec` selection.
3. Decode identity, license, repository and dependency groups with DOCTYPE
   rejection.
4. Add the service, composition and CLI wiring.
5. Add parser, domain and service tests with synthetic fixtures in
   `src/nuget/NugetNupkg.fixture.ts`.
6. Update the usage guide, CLI guide, README and skill references.

## Effects and compatibility

The tool reads one existing local file. Nothing is executed, restored or
downloaded. The change is additive to the CLI and MCP surfaces.
