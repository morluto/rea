# Plan

## Shape

The `.deb` ar/tar layout is the only thing this feature knows, so the parser
owns it and everything else consumes its facts.

- `src/domain/deb/debPackage.ts` holds the schema, version/relationship
  parsers, and caller-selected budgets.
- `src/deb/DebPackageParser.ts` decodes a `Uint8Array` into ar members,
  control fields, and data inventory. It is given bytes only; it never opens a
  file.
- `src/deb/DebPackageProvider.ts` owns the stable file read and maps parser
  failures onto the shared analysis error algebra.
- `src/application/deb/DebPackageService.ts` validates caller input, parses
  provider output, and records Evidence for CLI and MCP.
- CLI `inspect-deb-package` and MCP `inspect_deb_package` are thin adapters
  over that service.

## Order

1. Pin the format in the domain schema so later steps cannot disagree about it.
2. Write the parser against synthetic ar/tar fixtures.
3. Add the provider, service, CLI command, and MCP tool over the same facts.
4. Document the command and the report, and link the guide from both indexes.
