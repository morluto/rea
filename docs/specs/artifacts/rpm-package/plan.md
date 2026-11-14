# Plan

## Shape

The RPM on-disk format is the only thing this feature knows, so the parser owns
it and everything else consumes its facts.

- `src/domain/rpm/package.ts` holds the schema, comparison vocabulary, and
  bounds, so a reader and a test share one definition of what a package report
  is.
- `src/rpm/RpmPackageParser.ts` decodes a `Buffer` into lead, signature, and
  main-header facts. It is given bytes only; it never opens a file.
- `src/rpm/RpmPackageProvider.ts` owns the observation budget, the file read,
  and the remediation text. It is the boundary that turns bytes into a reported
  fact.
- `src/cli/rpmPackageCommands.ts` and the MCP registration are thin adapters
  over the same service, so both surfaces report the same facts.

## Order

1. Pin the format in the domain schema so later steps cannot disagree about it.
2. Write the parser against encoded fixtures, including colliding signature vs
   header tag numbers.
3. Add the provider, the budget, and its remediation.
4. Expose the CLI command, then the MCP tool, over the same provider.
5. Document the command and the report, and link the guide from both indexes.

## Budget

Header index entries, file-inventory rows, and optional scriptlet text are the
unbounded parts of the read. Each has a caller-selected budget and a hard
ceiling. The provider reports which bound was reached and whether raising it is
the caller's next step, so a refusal is actionable rather than a bare
truncation.
