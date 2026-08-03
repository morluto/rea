# Testing REA

REA's test suite follows one rule: use the lowest behavioral depth that can
prove a claim. Tests are grouped into native Vitest projects so ownership,
allowed dependencies, and runtime cost are visible from their paths.

## Behavioral depths

| Depth        | Location                | What it proves                                                                                        |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Module       | `src/**/*.test.ts`      | One domain, service, or adapter through its narrow public surface                                     |
| Composition  | `tests/composition/**`  | Provider-neutral session and registry wiring; filesystem access is limited to fixture materialization |
| Boundary     | `tests/boundary/**`     | Exactly one production filesystem, process, network, browser, CLI, or provider boundary               |
| MCP boundary | `tests/boundary/mcp/**` | MCP transport and tool-contract boundaries with isolated sessions and explicit cleanup                |
| Acceptance   | `tests/acceptance/**`   | A complete compiled CLI or MCP workflow                                                               |
| Conformance  | `tests/conformance/**`  | Shared provider contracts, parameterized by declared capabilities and explicit opt-outs               |
| Evaluation   | `tests/evaluation/**`   | Deterministic evaluator parsing, scoring, and report generation                                       |

Colocated domain tests may import only their owning domain and inward
dependencies. They do not construct sessions or servers and do not start
subprocesses or network listeners. Colocated application tests exercise one
service through explicit ports and recording adapters, never a CLI or MCP
entrypoint. Composition tests may assemble provider-neutral sessions and
registries but do not cross production filesystem, process, socket, or browser boundaries.
Boundary tests cross one production boundary. Only acceptance tests assemble
the complete runtime or invoke the compiled product surface.

`tests/process-global/**` is reserved for cases with a demonstrated dependency
on process-global state. Those tests run without file parallelism. Reusable,
test-scoped fixtures live under `tests/support/**`; immutable source artifacts
remain under `tests/fixtures/**`.
The process-global Vitest configuration contract rejects new direct temporary-root
creation outside the workspace seam and its narrowly documented boundary/package
exceptions.

Real Hopper, Ghidra, browser, package, managed-code, and controlled-replay
claims belong to their explicit `npm run verify:*` lanes. They are not inferred
from mocks or folded into the deterministic local gate. Real model trials are
manual; Vitest covers only deterministic evaluator logic.

## Developer commands

`npm test` runs every deterministic project once. The narrower feedback loops
are:

| Command                   | Scope                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run test:fast`       | Domain, service, adapter, composition, boundary, MCP boundary, and conformance projects                                |
| `npm run test:boundary`   | Boundary, MCP boundary, and process-global projects                                                                    |
| `npm run test:mcp`        | MCP boundary project only                                                                                              |
| `npm run test:acceptance` | Complete CLI and MCP acceptance workflows                                                                              |
| `npm run test:changed`    | Changed tests in non-serial projects via Vitest's import graph                                                         |
| `npm run test:watch`      | Changed domain, service, adapter, composition, boundary, MCP boundary, conformance, and evaluation tests in watch mode |
| `npm run test:watch:all`  | Changed tests from every deterministic project in watch mode                                                           |
| `npm run check:changed`   | Cached static checks followed by changed tests                                                                         |
| `npm run check:pr`        | Static, generated-document, and complete deterministic PR gate                                                         |

Changed-test selection is a fast feedback aid, not release evidence. It can
miss behavior connected through runtime registration, generated data, shell
entrypoints, or other relationships that are absent from the import graph.
Use `npm run check:pr` before handing off a contribution.

Vitest and Node persistent compile caches are deliberately not enabled by
default. To evaluate repeated local runs, opt in for both cold and warm
measurements with an isolated cache:

```bash
NODE_COMPILE_CACHE=.cache/node-compile npm test
```

Do not report the warm result as a cold-suite improvement, and do not enable
the cache in coverage or benchmark CI without first showing that its
instrumentation remains equivalent.

## Coverage and timing

CI owns coverage. The aggregate floors are 65% statements, 60% branches, 60%
functions, and 68% lines. `src/domain/**` must reach 80% statements, 75%
branches, 75% functions, and 80% lines. `src/contracts/**` must reach 85%
statements, 80% branches, 80% functions, and 85% lines. Thresholds are
glob-specific rather than per-file and are never updated automatically.
Coverage does not replace named boundary, acceptance, or real-provider scenario
matrices.

CI runs four native Vitest shards without retries. Each shard emits a blob
report; the merge job produces aggregate coverage plus JUnit and JSON timing
reports, uploads them together, and writes the slowest files to the workflow
summary. Static checks, documentation, build, package verification, and
real-system lanes remain separate jobs so one kind of evidence cannot stand in
for another.

The PR acceptance target is a median `npm run check:pr` wall time below three
minutes across three warm-build runs on the benchmark host. Keep Vitest caches
cold unless separately identified. The final cutover also requires three
consecutive deterministic passes without retries, `npm run verify:package`, and
the applicable real-system lanes.
