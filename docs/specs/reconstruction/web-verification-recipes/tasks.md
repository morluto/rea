# Tasks and verification

- [x] R1–R3: Adapt authenticated comparison inputs, ownership and finite web claim evaluation; preserve 6.9 regressions.
- [x] R4: Add shared offline verification service and CLI registration; adapt MCP composition.
- [x] R5: Adapt recipe prompts, canonical guides, complete examples and acceptance coverage.
- [x] R6: Run source/focused tests, SDK schema checks, build, fast checks and docs checks.
- [x] R1–R6: Exercise complete owned-fixture CLI/MCP examples, record supported hosts and provider limitations.
- [x] R1–R6: Complete independent code review and verification of any fixes.

## Executed verification

Validated on 2026-11-15 using Node 24.22.1 and npm 11.16.0, from the official 6.9.0 base.

- `npm run build:cached` and `npm run check:fast`: passed. The source suite selected twelve affected domain/service files: 271 tests passed, including original process/function semantics, immutable bundles, web comparison/claim policies and transitive closure.
- `npm run test:focused -- <13 boundary/acceptance files>`: 140 passed, with real browser and process recipe tests initially skipped by the Windows host configuration. A subsequent four-file selection with `REA_BROWSER_EXECUTABLE` ran the real Chrome recipe and related adapter regressions: 31 passed. These selections overlap; their counts are not additive.
- SDK-converted schemas were validated using Ajv2020 and real SDK clients. Public CLI/MCP tests cover source integrity, exact retained references, transitive dependencies absent/present, partial coverage and visual/behavior separation.
- `npm run docs:check`, `npm run docs:build` and `npm run verify:test-discovery`: passed.
- Real Chrome examples: identical appearance with different console behavior yielded `fail`; the matching candidate passed the selected appearance/behavior claims while unobserved storage remained `unknown`. The complete web recipe changed candidate code and reproduced the same outcomes through CLI/MCP.
- Real Linux x64 PTY example: executed inside the shared offline VM with an isolated official Node 24.22.1 runtime and locked production dependencies. Initial CLI candidate failed one terminal claim; the corrected candidate passed all four terminal/exit claims, while the deliberately unobserved filesystem claim remained `unknown`. CLI and fresh stdio MCP agreed.
- The Linux Evidence was copied to Windows and re-compared/re-verified through the public CLI and a fresh stdio MCP session. Comparison identities and verification results matched the Linux run without rebasing retained paths. The VM was restored to Off with only its internal network adapter.
- Independent review reproduced an omitted transitive-closure check in the initial CLI service. The shared application owner now admits a sealed canonical bundle, evaluates the finite specification and validates complete closure for both adapters. The original reproduction now fails closed; complete closure passes. Source and public CLI/MCP regressions passed, and the reviewer confirmed the correction.

No new provider, autonomous builder, performance benchmark or platform-support claim was introduced. New process capture still requires a supported Linux/macOS host; Windows validation used retained Linux captures. The examples use deterministic fixture builders and do not establish autonomous agent quality or global reconstruction equivalence. No upstream merge or human readiness declaration was performed.
