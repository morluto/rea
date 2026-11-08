# Plan

## Shape

The container format is the only thing this feature knows, so the parser owns it and
everything else consumes its facts.

- `src/domain/v8/v8CodeCache.ts` holds the schema, the bit constants and the bounds, so a
  reader and a test share one definition of what a container is.
- `src/v8/V8CodeCacheParser.ts` decodes a `Buffer` into retained strings and producer
  facts. It is given bytes only; it never opens a file.
- `src/v8/V8CodeCacheProvider.ts` owns the observation budget, the file read and the
  remediation text. It is the boundary that turns bytes into a reported fact.
- `src/cli/v8CodeCacheCommands.ts` and the MCP registration are thin adapters over the
  provider, so both surfaces report the same facts.

## Measured premises

Each of these was measured on Node 24.22.1 before the parser was written, because the
container is undocumented and the layout had to be derived rather than assumed:

- `vm.Script.createCachedData()` writes `0x…|length` for its producer word.
- `vm.compileFunction` sets `0x20000000`, and `vm.SourceTextModule` sets `0x40000000`.
- The payload retains UTF-8 strings above the threshold, and the retained set grows with
  the source's literals rather than with the bytecode size.

## Order

1. Pin the format in the domain schema so later steps cannot disagree about it.
2. Write the parser against the measured producer words.
3. Add the provider, the budget and its remediation.
4. Expose the CLI command, then the MCP tool, over the same provider.
5. Document the command and the report, and link the guide from both indexes.

## Budget

The retained-string scan is the only unbounded part of the read, so it is bounded on three
axes at once: a maximum string count, a minimum string length, and a maximum artifact size.
The provider reports which of the three was reached and whether raising or lowering it is
the caller's next step, so a refusal is actionable rather than a bare truncation.
