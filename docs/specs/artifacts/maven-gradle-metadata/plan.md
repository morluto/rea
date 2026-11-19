# Plan

## Shape

The document formats are the only thing this feature knows, so the parser owns
them and everything else consumes its facts.

- `src/domain/java/mavenGradleMetadata.ts` holds the schema and version-kind
  helpers, so a reader and a test share one definition of the report.
- `src/java/MavenGradleMetadataParser.ts` decodes UTF-8 bytes into coordinates,
  dependencies, and unresolved references. It is given bytes only; it never
  opens a file.
- `src/java/MavenGradleMetadataProvider.ts` owns the file read and the
  file-size budget. It is the boundary that turns bytes into a reported fact.
- `src/cli/mavenGradleMetadataCommands.ts` and the MCP registration are thin
  adapters over the same service, so both surfaces report the same facts.

## Order

1. Pin the report in the domain schema so later steps cannot disagree about it.
2. Write the parser against tiny valid POM and Gradle `.module` fixtures.
3. Add the provider and the file-size budget.
4. Expose the CLI command, then the MCP tool, over the same provider.
5. Document the command and the report, and link the guide from both indexes.

## Budget

The only unbounded part of the read is the selected file size, so it is bounded
by `max_file_bytes` (default 1 MiB, ceiling 16 MiB). Exceeding it fails without
partial success.
