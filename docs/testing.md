# Testing REA

Use this guide when choosing coverage, pruning tests, or running a verification
lane. Start with the commands below; use [real-toolchain lanes](#real-toolchain-verification-lanes)
for engine prerequisites and [client verification](client-verification.md) for
installed-client and agent runs.

Historical verification records may refer to `experiments/analysis-efficiency`.
Those experiment scripts are available in the [archived source tree](https://github.com/morluto/rea/tree/a2e2c29b59e8775b0e6aedb09a9eb16adf32646b/experiments/analysis-efficiency);
they are not included in current checkouts. The retained [test support](https://github.com/morluto/rea/blob/main/tests/support/analysis-efficiency/README.md)
contains deterministic checkers and fixtures. The [allocation report](verification/analysis-efficiency/mcp-integer-allocation.md)
and its original receipt JSON remain documentation, checked by the report producer.

## Developer commands

Use source feedback while editing, explicit boundary checks for the changed
behavior, and complete CI evidence before merging.

| Command                           | Scope                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run test:local`              | Dirty source tests via the import graph, without build; explicit source paths run regardless of Git status              |
| `npm run test:focused -- PATH...` | Exact existing test files; compiled boundaries build first, and unmatched paths fail                                    |
| `npm run test:changed`            | Source tests affected since the merge base with `origin/main`, including committed and dirty changes                    |
| `npm run test:fast`               | All domain, service, adapter, composition, conformance, and evaluation tests without build                              |
| `npm run test:boundary`           | Boundary, CLI boundary, MCP boundary, process boundary, and process-global projects                                     |
| `npm run test:mcp`                | MCP boundary project                                                                                                    |
| `npm run test:acceptance`         | Complete compiled CLI and MCP acceptance workflows                                                                      |
| `npm run test:python`             | LLDB and mitmproxy producer contracts plus analysis-efficiency checks; no real debugger or proxy required               |
| `npm run test:watch`              | Dirty source tests in watch mode, without build                                                                         |
| `npm run test:watch:all`          | Changed tests from every project; builds at startup, so rebuild after production edits before relying on compiled tests |
| `npm run check:fast`              | Cached typecheck and lint                                                                                               |
| `npm run check:changed`           | Cached typecheck/lint and branch-related source feedback                                                                |
| `npm run check:pr`                | Opt-in complete local deterministic gate and generated-file checks                                                      |
| `npm run docs:check`              | Generated-document validation and fresh onboarding example consistency checks                                           |
| `npm run docs:build`              | Render VitePress documentation and apply its page-link checks; no live external-link or GitHub fragment verification    |

The general source suite above runs on Linux in CI, and Windows CI runs a
curated lane ([Native platform baseline in CI](#native-platform-baseline-in-ci)).
A Windows source checkout can fail source tests for reasons unrelated to the
change, such as POSIX fixture paths, `#!/bin/sh` tool stubs, or POSIX rename
semantics. Compare failures against the base revision, or run the suite on
Linux or WSL, before attributing them to a change. See `CONTRIBUTING.md` →
Windows source checkouts.

The CI documentation lane runs both `docs:check` and `docs:build` when the
existing change classifier selects documentation or its producing inputs.
Generated facts and rendered page links have separate checks. VitePress does not
establish that every external URL or GitHub-rendered localized heading exists;
verify those destinations when editing them.

For example:

```bash
npm run test:local -- src/config.test.ts
npm run test:focused -- tests/acceptance/applications/runtime.test.ts
npm run test:changed -- --base origin/main
npm run test:changed -- --dry-run
```

`test:focused` accepts exact repository-relative test file paths. Source-only
paths do not build; boundary, acceptance, process-global, or unfamiliar `tests/`
paths build conservatively. Tests use Vitest concurrency and isolated
workspaces; commands do not hold a broad test lock. Build and documentation
writers retain checkout-local locks for their shared output files. Explicit
selections do not use `--changed` or permit zero-test success.
The dry-run option reports the chosen merge base, scope and build prerequisite
without executing tests or building. A missing Git base reports how to fetch
it or select another revision.

Source typechecking needs no compiled runtime or generated test metadata.
Typecheck, runtime compilation, and Frida binding verification share
`scripts/run-typescript.mjs`. The pinned tsrs package supplies Linux x64/arm64
(GNU and musl) and macOS arm64 compilers. Windows and other unsupported hosts
retain the existing stable official TypeScript compiler. Its upstream version
can differ from tsrs, so both compiler tasks hash the selected package and version
through `scripts/run-turbo.mjs` before cache lookup. Outputs from different
compilers occupy different cache entries. Repository npm scripts and focused-test
preparation use that entrypoint; a raw Turbo compiler task without matching
identity fails instead of publishing an ambiguous successful cache entry.
A missing binary on a supported host also fails without silently falling back.

Development verifiers load their shared command, terminal and file owners from
source using Node's in-process TypeScript transformation. A single process-lifetime
loader handles this checkout's `src/` and `scripts/lib/` graphs, resolving missing
relative `.js`/`.mjs` imports to their `.ts`/`.mts` source. Existing JavaScript and
modules outside those roots keep native resolution and failures. Node's module
cache shares source identities within the verifier process; transformed output
is not cached across Node versions. Restart the verifier after source edits.
This avoids a cold-cache compiler subprocess surviving command cleanup; the
live process-lineage checks remain required.

The Rust compiler defaults to at most two checker threads. For `--noEmit` checks,
`--maxMemory 3G` also sets a soft memory target; emit builds do not use that target.
Explicit compiler arguments can override the defaults. These controls do not
impose a process-family memory limit. Termux's explicit build, Stryker's compiler
API dependency, and independent fixture compiler oracles keep their existing
TypeScript versions.

`npm run build:cached` compiles the CLI/MCP runtime and its packaged skill.
The build also records `dist/mcp-catalog.json` (compact inputs) and
`dist/mcp-catalog-full.json` from the canonical SDK registrations and binds
each to the runtime with its own SHA-256 digest. These are
runtime artifacts, separate from the test catalog below. Default target-free
MCP startup serves its schemas without constructing analysis validators;
the first tool or guided-workflow request materializes the canonical runtime
on that same SDK server. Explicit compact/full input selections preserve
their advertised schemas throughout materialization. Initial-target,
HTTP and output-schema-off startup keep the eager path; source runs without
recorded artifacts also use eager composition. Compare memory both after discovery and after a completed
request; report diagnostic GC separately from normal resident memory.

Turbo's strict task environment preserves caller-selected `GOMAXPROCS`,
`GOMEMLIMIT`, and `UV_THREADPOOL_SIZE` for resource-constrained builds and
checks. These execution controls do not change artifact content, so changing
their values retains cache reuse. They control individual runtimes; monitor
the complete process family separately when enforcing a total memory budget.
`npm run test:prepare` also generates the MCP contract test catalog, product
catalog, and portable managed evidence used by the complete suite. Focused
tests prepare those extra outputs only when their selected files consume them.
The MCP test catalog is JSON in `.cache/mcp-tool-catalog.json`; the tracked
test loader supplies its types without making generation a source-check
prerequisite. Run `npm run mcp-catalog:generate` to refresh it independently.
Documentation generation and managed conformance run through their separate
`docs:generate` and `evidence:generate` task graphs.

Changed selection can miss runtime registration, generated data, shell
entrypoints, bridges, or other relationships absent from the import graph.
An empty changed selection means no tests were selected, not verified
correctness. Select relevant boundary files and real-provider lanes explicitly.
Source projects also contain large capacity regressions; `test:fast` promises
no compiled-runtime prerequisite, not a fixed time budget.

`npm run lint` prints errors and a warning summary; `npm run jscpd` prints
duplication statistics. Complete reports remain in `.cache/static-checks/`.
The fast gate uploads them as `static-check-reports`. Full qualification
uploads duplication diagnostics from the deep job as
`static-deep-check-reports`, including after that gate fails.
Task-graph recording runs `check:ci:fast:tasks` and `check:ci:deep:tasks`
without the artifacts lock, so it can record hashes while `check:pr` or
`check:test` already holds that lock. The CI jobs still run the locked
`check:ci:fast` and `check:ci:deep` commands.
Use `npm run lint:details` or `npm run jscpd:details` for all console diagnostics.
Both duplicate commands scan production and test code using the limit in
[`.jscpd.json`](https://github.com/morluto/rea/blob/main/.jscpd.json).
The summary commands preserve checker failures and restore reports from cached
static tasks. Both lint caches include the website, documentation configuration,
and experiment code scanned by the checker; a regression compares the actual
lint inventory with Turbo's resolved inputs.

Static checks locate candidates; they do not establish semantic ownership.
`jscpd` finds token clones, and Knip counts test references as uses. Module
boundaries and architecture guards enforce their declared import and source
rules. Passing them does not prove that two parsers agree, a wrapper is still
needed at runtime, or cleanup has one owner.

The lint gate treats `no-async-promise-executor`, `no-unreachable`, and
`no-unsafe-optional-chaining` as errors. These catch lost async executor failures,
dead code, and unsafe uses of optional-chain results. `no-unsafe-finally` remains
a warning because cleanup paths can deliberately throw aggregated failures;
review whether they preserve the primary failure. Two local rules
cover narrower observed failures: `rea/no-buffer-deep-equality` flags Vitest
deep comparisons of Buffers from recognized constructors and file reads,
including simple `const` aliases; `rea/cancellation-cause` requires an explicit
cause when a directly checked caller `AbortSignal` is converted to an
`AnalysisCancelledError`. The rules do not infer arbitrary Buffer types,
follow indirect cancellation helpers, or prove that an explicit cause equals
the caller's reason. Keep focused boundary and lifecycle tests for those facts.

`rea/no-evidence-json-preadmission` rejects direct generic JSON parses in
`createEvidence` payload expressions; it does not analyze intermediate values.
`rea/no-positional-tool-contract` rejects catalog indices used to select
operation names, schemas or types; display-only selection remains allowed.
`rea/no-fixture-root-cleanup` follows `const` fixture-root aliases into teardown
deletion; mutable bindings and mixed root arrays remain outside its scope.

`rea/no-shared-module-mock` resolves Vitest import bindings before rejecting
module mocks in projects without per-file isolation. The test-project definitions
own isolation for Vitest and lint; the executable gate checks the resolved policy
and runs the same collector. Aliases and namespace imports count; comments,
shadowed locals, ordinary methods and `spyOn` do not. Negative CLI probes use an
external temporary project so concurrent repository checks cannot discover them.

Focused `.only` declarations, broken assertion promise chains, and unused disable
directives are errors. `vitest/valid-expect` warns (`maxArgs: 2`) because valid stored and
collected assertions can be awaited later. `import/no-duplicates` warns with
`preferInline: false`.

`no-useless-escape` keeps intentional `\-` regex escapes because advertised
patterns must also compile in `v` mode; the catalog regression checks every
advertised pattern.

Fast lint stays syntax-based. `npm run lint:typed` runs serially with pinned
`oxlint-tsgolint` 7.0.2005 and records native plus typed diagnostics in
`.cache/static-checks/typed-oxlint.json`. Production `src` treats
`no-misused-promises` as an error; tests/fixtures warn. `no-floating-promises` is
an error throughout the lint inventory. `return-await` is an error in
error-handling scopes so asynchronous completion stays inside its catch or
cleanup boundary. Exhaustiveness is an error when a union member has neither a
case nor a default. Intentional defaults count as handling the remaining union;
new members covered by those defaults therefore require behavioral review.

Two HTTP/3 source-test files allow the runner-owned `node:test` registration API;
ordinary unowned promises in those files still fail. The authored code-split
recovery input is exempt from floating-promise policy because it is analysis
input, rather than application orchestration. Preserve framework-owned callbacks
such as an awaited `Promise.finally`; inspect the actual completion owner before
changing a callback solely to satisfy its declared `void` return type.

`npm run knip:production` writes advisory candidates to
`.cache/static-checks/production-reachability.json`; execution/report errors fail.
Ordinary Knip remains. `check`, `check:pr`, and `check:ci:deep` run reachability
then typed lint sequentially after cached work. Typed lint builds the project
type graph and stays separate from fast feedback. Its default Go settings are
`GOMAXPROCS=1` and `GOMEMLIMIT=1024MiB`; caller-selected settings take precedence.
One Go worker reuses checker caches across the file queue without changing the
file inventory or TypeScript project scope. The Go memory target is soft and
does not cap the complete process family's memory; measure the full invocation
when enforcing a host budget.

Routine iterations and rebases need focused regressions and relevant checks.
Before handing off a PR, run `npm run check` and generated-document checks when
applicable; CI owns the full suite and coverage. Use the full local gate for
broad changes or diagnosing CI, rather than after every edit. Package/install
changes additionally need package verification; provider changes need actual
provider evidence.

Vitest projects use up to two workers, bounded by host parallelism.
`process-boundary` runs later with serial files because process-tree sampling
shares host resources. Acceptance and process-global cases use isolated forks
without serial scheduling. Pure domain/service, composition, conformance,
evaluation, CLI boundary, and MCP boundary projects share module graphs. Their
tests avoid process-global state and keep resource cleanup test-scoped. Each
MCP session still owns its resources, and CLI cases retain fresh command
instances or subprocesses. Fixtures using `vi.mock` or `vi.doMock` need an
isolated project. CLI/MCP fixtures normally live in `tests/process-global/`.
When a path must stay, assign it explicitly in `scripts/lib/test-projects.mjs`,
exclude it from its shared owner, and preserve its source/built group.
Product catalog verification stays with the
isolated filesystem boundary tests because it loads both source and compiled
module graphs. Adapter, other boundary, acceptance, and process-global projects
retain per-file isolation. See `vitest.config.ts` for current settings.

Inject producer faults through scoped dependencies in shared workers: a module
mock cannot replace a consumer that was imported earlier. Check these tests
with the consumer preloaded as well as alone. For simulated protocol traces,
use an acknowledged event barrier before asserting complete observations;
a zero-duration capture does not guarantee queued events have arrived.

Place faults at the semantic boundary under test: the selected read, EOF, hash
completion, or cleanup attempt. Global call ordinals can shift during setup or
refactoring without reaching that phase. For controlled asynchronous gates, use
`awaitAcknowledgement` from `tests/fixtures/lifecycleAcknowledgement.ts` to race
the acknowledgement against triggering-operation settlement and a bounded
deadline. Register release gates before launch, then release and join launched
work in `finally` before restoring mocks, even when the barrier fails.

Focused contract tests should import the named contract family they exercise;
reserve the full tool catalog for catalog-wide assertions. Resolve contracts by
operation name rather than array position.

Check advertised schemas after SDK conversion for every supported schema
profile. Meta-schema validity does not establish client acceptance or useful
rendered declarations. Keep canonical rejection checks separate from the
intentionally reduced compact advertisement, and probe actual client renderers
when changing schema representations.

The reused CLI boundary workers cap V8 old space at 512 MiB, with or without
coverage. Ordinary CI also exhausted the former 384 MiB budget after earlier
files loaded the shared source/contract graph, while later command registration
and schema/help rendering still needed transient allocation space. This is a
measured capacity control, not a suite-wide speedup claim. The worker count
remains bounded at two, and spawned REA processes retain their own heap settings.
Coverage enablement still controls instrumentation, test deadlines and coverage
thresholds; explicitly disabling it or selecting only a provider does not enable
instrumentation.

Vitest worker limits do not bound subprocesses launched within a test. Bound
those batches separately so repeated CLI validation cannot oversubscribe the
runner. Preserve simultaneous launches where concurrency is itself under test.

Coordinate expensive checks across agents sharing a host. If a test unexpectedly
consumes heavy CPU, stop its owned process family, retain its log and revision,
and profile a bounded representative case before retrying. Separate production
work from fixture generation, schema compilation, subprocess startup and cleanup.
Choose elapsed, CPU and process-family memory limits before the run; a worker
count or test timeout alone does not enforce those limits.

Keep capacity fixtures intact when diagnosing a test failure. For byte equality
of large buffers, use `Buffer.equals` or `Buffer.compare`; a generic structural
diff can allocate far more than the production operation.

Remove demonstrated repeated work while preserving distinct assertions and
resource ownership. Share immutable fixture preparation where safe; keep fresh
sessions when lifecycle or concurrency is the behavior under test. Compare the
same completed workload before and after, report cache state and measurement
limits, and record interrupted runs separately from passes. Increasing a timeout
does not explain a CPU regression.

Build/documentation writers hold checkout-local output locks. Tests do not
hold a broad command lock; `check:pr` finishes tests before document validation.
Turbo caches deterministic preparation and static checks, but `test:run` always
executes. Repository files do not fully describe installed tool contents or host
state. A previous test pass therefore cannot replace current validation, even
when the source tree is unchanged. `check:pr` also runs the fast Python producer
suite. Fast CI runs it from the selected Python job after installing dependencies
and preparing the compiled runtime; full qualification runs it from the deep
static job. These producer tests do not establish real LLDB engine coverage.

Vitest's persistent compile cache remains disabled. The `cliTest` fixture shares
a temporary Node compile cache among its fresh CLI subprocesses. The worker
removes it after test-scoped processes finish. Explicit child environment
settings take precedence; children requesting `NODE_V8_COVERAGE` do not receive
the fixture cache. These subprocesses are outside aggregate Vitest coverage;
subprocess coverage attachment remains disabled. Cold-start import checks launch
independently without this fixture cache.

`analyzeJavaScriptDirectory` stdio MCP cases in one `cliTest` file share one
server and that compile cache. The first case pays startup; later cases reuse
the process. File teardown waits for startup still in flight, closes a server
registered during that wait, and does not open a server after close. A failed
handshake stays the caller error when its cleanup also fails, including a
rejection without a reason. That cleanup stays owned until a later close or
call releases it. Another server does not open while the cleanup remains, and
a cleanup that already succeeded is not run again. Pass
`mcpCall` when a case needs its own server, environment, or lifecycle. CLI
cases for that helper share one compiled CLI process per child environment.
The first case pays process startup; later cases reuse the loaded runtime.
The process restarts when the environment changes, after 32 commands, or when
the worker reports a resident set of at least 1 GiB. A fatal worker failure
or a broken session frame retires that process and waits for it to exit before
the next command starts.
`cli.run` still starts a fresh process, including stdin and explicit deadlines.
`runFileCli` uses the file session for commands that have neither. Go binary,
IL2CPP metadata, and dylib-resolution commands use that session. File teardown
stops the shared CLI process, including startup still in flight, and does not
open another after close.
`exportedFunctionBindingsCli.test.ts` uses the shared compiled CLI session for
its file and compares its JSON command results with the MCP session. It selects
20-second startup and command deadlines; other callers retain their existing
deadline behavior. Retired processes stay owned until exit, block replacement,
and remain available for a later close to retry after failed termination.
Shared session cleanup closes stdin so the worker can release JavaScript
resources, waits the bounded grace, then escalates to SIGTERM and SIGKILL only
if needed. Confirmed exit succeeds; an unconfirmed exit reports cleanup failure.
When startup or a command fails and cleanup also fails, the reported aggregate
retains both failures and the original failure as its cause.
`applicationWorkflowCli.test.ts` keeps one compiled CLI process for its JSON
commands, including a non-zero status whose stdout is still a JSON document,
and closes that process after the file.

The Apple artifact verifier step shares a job-temporary bytecode cache among
its fresh CLI/MCP children via `REA_ARTIFACT_NODE_COMPILE_CACHE`. The artifact
helper maps this setting to child `NODE_COMPILE_CACHE`; npm, Turbo, and nested
Vitest runs do not inherit that setting. Explicit `NODE_COMPILE_CACHE` takes
precedence, and coverage collection or `NODE_DISABLE_COMPILE_CACHE=1` disables
the helper's cache. The cache is discarded with the CI job.

To evaluate persistent compile caching for repeated local runs, opt in for both
cold and warm measurements with an isolated cache:

```bash
NODE_COMPILE_CACHE=.cache/node-compile npm test
```

Do not report the warm result as a cold-suite improvement, and do not enable
the cache in coverage or benchmark CI without first showing that its
instrumentation remains equivalent.

## CodeQL production scope

[The production configuration](../.github/codeql/production.yml) excludes
`tests/`, `scripts/fixtures/`, `*.test.*`, `*.fixture.*`, `test_*.py`, and `*_test.py` inputs
during extraction. It retains the default queries and the existing `local`
threat model. Production source, bridges, runtime scripts, installation and
release controllers, and Actions remain in scope for the configured languages.
Verification scripts remain included unless they match an explicit test path;
excluding the entire `scripts/` directory would hide shipped entrypoints.
The `paths` list retains repository-root traversal and explicitly includes
`docs/.vitepress/`, which JavaScript extraction otherwise skips as a hidden
directory. Keep directory entries here: the shared Python extractor does not
accept individual files as traversal roots. When changing this list, compare the
complete production file inventory as well as alert counts.
These exclusions do not change which behavioral tests CI executes. CodeQL's
JavaScript/TypeScript, Python, and Actions lanes do not add shell, Java, or Swift
analysis; their existing checks remain responsible for those languages.

[The production workflow](../.github/workflows/codeql.yml) is inactive until a
repository administrator disables CodeQL **default setup** and sets the Actions
repository variable `REA_CODEQL_ADVANCED` to `true`. Disable default setup first:
it rejects advanced CodeQL uploads. Then enable the variable and manually run
**CodeQL production** on `main`; verify all three analyses complete before
relying on the new scope. While the variable is unset, the existing default
setup continues scanning. Adding the configuration file alone does not change
default setup in this user-owned repository.

Each analysis uses two threads and a 4096 MiB CodeQL memory budget; language
jobs run one at a time. Complete SARIF reports are retained for seven days.
For a scope comparison, use the same source SHA, CodeQL bundle, default query
suite, and `local` threat model on both runs. Change only extraction paths, inspect
the extracted-file inventory and diagnostics, and retain both complete reports.
Alert counts do not establish a false-positive rate or a speedup. Report elapsed
time, CPU time, and process-family memory with their measurement limits.

## Choose verification for the change

`test:local` is fast source-level feedback. For the strongest practical
regression, prefer a real public CLI/MCP workflow, then production-boundary
integration, then a producer golden; use the table to select quick feedback and
claim-specific additional evidence. Provider-behavior claims require the
matching real-provider lane.

| Change or claim                           | Fast feedback                                                 | Claim-specific coverage                                     |
| ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Source semantics                          | `npm run test:local -- PATH...`                               | Relevant boundary cases when the behavior crosses a port    |
| CLI/MCP workflow                          | `npm run test:focused -- PATH...`                             | Actual public calls; an injected provider has limited scope |
| Documentation or generated metadata       | `npm run docs:check`                                          | `npm run docs:build` for rendered pages and links           |
| Engine adapter                            | Its real-provider lane below                                  | Host, version, target identity, and owned cleanup           |
| Client configuration or schema conversion | [Native client lane](client-verification.md)                  | Distinguish loopback models from live services              |
| Agent investigation quality               | [Agent evaluation](#agent-evaluation-and-conformance-records) | Review transcript and scenario-specific evidence            |

### Provider-backed workflow verification

For a new or changed provider-backed tool, select tests from the analyst's
question and the facts the contract claims, not from an upstream command list.
Use the existing workflow as a baseline and identify what the proposed tool
adds. Choose the relevant cases below; do not require every provider or a
Cartesian matrix when it would not change the claim.

When auditing existing tools, compare selected analyst workflows with the cases
their existing tests and real-provider lanes actually exercise. Run relevant
public workflows and focused checks; report untested scenarios rather than
inferring that a green test proves them or that no prior testing occurred. A fix
should add a regression for the demonstrated failure at its owning boundary and
affected consumer.

- Use a controlled target with independently known facts and a meaningful
  counterexample. Compare native provider output with the target or a
  format-aware oracle; a provider label, a mock, or another REA projection is
  not independent proof of the underlying fact.
- Exercise the affected public CLI/MCP workflow, including handoffs between
  calls. Assert the requested result, caller-selected inputs, source identity,
  evidence and coverage. Check that unavailable, partial and empty outcomes
  retain their different meanings across the producing and consuming boundaries.
- Where relevant, continue after a mixed success, failed request, cancellation
  or close/reopen. Verify the next supported recovery and preservation of prior
  results and resource ownership. Use the applicable lifecycle regressions below.
- For lookup failures, distinguish malformed input from a valid missing or
  ambiguous selector. Check the returned candidate and input identity, follow
  an actionable recovery where possible, and verify that an inventory miss is
  not presented as artifact-wide absence. Test schema-repair advice separately.
- Record the provider version, host, fixture, actual entrypoint, controlled
  faults and skipped or unavailable coverage. A simulated provider tests the
  integration boundary; a scripted sequence tests that sequence, not an agent's
  ability to discover it. Run the matching real-provider and agent lanes when
  their respective claims require them.

For prerequisite recovery, include a case where only the wrong alternative is
configured: Unblob cannot enable Binwalk inspection, and Binwalk cannot enable
Unblob extraction. Check the final readiness or capability output retains the
producer's repair instructions, including which launch environment must change.
When feasible, follow the advice and verify that the same operation now works.
Report unexecuted recovery steps explicitly.

### Checking installers and publisher downloads

When changing setup or investigating an install failure, check the stages affected
by the change:

1. **Does REA support installation on this host?** Check the distribution and CPU
   architecture, including an unsupported case. Recognizing RPM or DEB packages
   does not mean REA can install on every related distribution. Check prompts in
   a terminal and with redirected output; image builds cannot answer interactive
   prompts. `doctor` checks health; `setup` installs.
2. **Does the downloaded package match the publisher's metadata?** Record the
   release version, package format, URL and check date. Verify the signature and
   compare the launcher hash inside that package with the feed and installed
   launcher. Check each format you claim works: a passing DEB check says nothing
   about the RPM. Old fixtures cannot catch a newly published package mismatch.
   Test both an invalid signature and a valid signature with a mismatched launcher
   hash; setup must reject either before running the package manager.
3. **Can download failures be diagnosed?** Use REA's request headers and timeout.
   Check whether the setup result identifies the failed URL, HTTP status or
   timeout, and next action; report missing details. Use controlled failures for
   repeatable tests. A fast download on one network does not rule out a timeout
   elsewhere, and curl with different headers may get a different response.
4. **Does the installed provider run?** Check package-manager prerequisites and
   run doctor for the selected provider. For Linux Hopper, check Python and REA's
   private Xvfb display separately from package installation. Where relevant,
   test an unusable `/tmp/.X11-unix` and a blocked user/mount namespace fallback.
   Starting an extra X server does not test the display REA creates and cleans up.

For a full Linux Hopper setup check, run `npm run verify:setup:linux` on a clean
root Linux runner. Set `REA_VERIFY_SERVER_COMMAND` to the installed REA command.
This checks setup, doctor, CLI/MCP analysis and repeated setup on that runner.
Report which host, package format and steps you tested. Inspecting a Linux package
on macOS verifies package contents, not a working Linux installation.

## Test design and pruning

Prefer real public CLI/MCP workflows, then production-boundary integration,
then goldens captured from real producers. Keep module tests for distinct
failures or semantics that stronger workflows cannot reliably reproduce.
Paths, compiled imports, and suite names do not establish test depth.

Prune tests that mirror implementation details or duplicate a stronger claim.
Before deleting a distinct regression, identify the replacement scenario and
assertions. Preserve malformed formats, cancellation, cleanup, permissions,
capacity, target identity, and combinations with distinct interactions.
Trivial helper assertions need no replacement. Remove abandoned production
scaffolding only after checking runtime and verifier consumers, including
compiled imports.

Assert error codes, structured limit facts, source provenance, and observed
recovery behavior instead of freezing explanatory sentences or banning obsolete
phrases. Keep exact checks for protocol values, setting and parameter names,
caller data, and diagnostic provenance. To verify guidance delivery, compare the
consumer with the owning formatter or constant, alongside independent assertions
for the behavior and facts; shared text alone is not a correctness oracle.
Documentation wording belongs in review, not substring tests of source files.
When replacing prose assertions, verify that a harmless wording change passes
and an incorrect budget or lost fact still fails.

After an owner changes, move fault injection and event spies to the path the
production consumer actually uses, and assert that the intended boundary was
reached. Keep independent expectations from authored input, producer output, or
an external oracle; comparing two paths through the same replacement algorithm
does not preserve the old oracle. A negative probe inside a conditional or loop
must assert that it ran. Check that the facts compared actually exist: `every`
on an empty list, optional chaining, or comparing two missing values can pass
without exercising the behavior. For a suspicious assertion, use an isolated
controlled change that removes or alters the relevant fact; confirm the test
fails at the intended assertion, then restore the change and rerun it.

When a fixture generates JavaScript imports, serialize a `file:` URL as a
JavaScript string literal rather than embedding a native path. For relative-path
cases, choose the child process working directory deliberately and verify the
fixture produced a relative path; on Windows, paths on different drives can
produce an absolute result. Run the relevant platform lane when available and
report when it was not run.

Use representative scenarios rather than Cartesian matrices of equivalent
cases. Share setup without hiding inputs or expected evidence. For successful
`Result` values, throw the typed error before asserting the value; a preceding
`.ok` assertion adds no coverage. Protocol fixtures must reject unmodeled
commands and preserve actual producer reply shapes.

For comparison normalization, include a legitimate equivalent pair and a
distinct pair that would collapse if representation tags or scope were lost.
For learned identifiers, cover conflicting pairs and reused values in different
collections; mappings must remain one-to-one within their declared scope.

For coverage propagation, compare the same returned rows under complete and
incomplete examination. If a row exists on the left but is missing from a fully
examined compatible right inventory, removal can be established. If the right
side examined only eight of ten applicable records, or returns only one page,
the same missing row remains unknown unless separate evidence proves absence.
Assert the structured coverage and comparison status as well as the explanation.

For format compatibility, identify the producer revision that establishes each
rule. Include an accepted boundary case beside the rejected case so a stricter
parser cannot pass by refusing both. Keep source-derived behavior, synthetic
fixtures, and executed producer or runtime oracles distinct in validation
reports. A fixture accepted by REA proves its reader behavior; it does not prove
that a real loader accepts the artifact. If multiple producer revisions share a
format identifier but differ in behavior, record that ambiguity rather than
using one installed version as an oracle for all of them.

### Boundary regressions

For parser, inventory, snapshot, or projection fixes, select the applicable
cases below. Assert the producing boundary's facts and their meaning in affected
consumers. Add [lifecycle regressions](#lifecycle-regressions) when resource
ownership or finalization changes; a single malformed fixture cannot establish
the whole contract.

| Failure class                         | Regression that catches it                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format assumptions                    | Pair valid padding, offsets, or names containing delimiters with malformed input. Identify the producer revision when behavior varies by version; an unrelated runtime API's range is not an on-disk format limit.                                                                                                                                 |
| Raw identity and normalization        | Exercise allowed empty or unusual source names/metadata keys and values that normalize to one lookup or display value. Preserve admitted raw spelling under the existing redactions for transport credentials and explicitly marked sensitive values. Distinguish local paths, file URLs and HTTP paths; assert source identity through consumers. |
| Missing, empty, and unknown values    | Distinguish omitted, null, empty, zero, and false where the format admits them. Pair a malformed optional field with usable sibling facts; assert uncertainty without inventing absence or discarding the row.                                                                                                                                     |
| Completed work followed by failure    | Complete one input, then fail or cancel a later input. Assert earlier digests, metadata, and parsed facts survive with the later failure reason and accurate processed/unprocessed coverage. For cancellation, assert the exact caller abort reason; where a primary failure was already produced, assert it survives.                             |
| Independent limits and failures       | Trigger a sample/output limit alongside a read or parse failure. Assert both dimensions survive; reaching a limit does not erase sampling failures or prove complete coverage.                                                                                                                                                                     |
| Representation expansion and capacity | Keep a valid set near the limit and a large malformed input followed by a valid input. Cover JSON escaping, expanded paths or decoded rows as applicable. Assert serialized bounds, retained identities, later valid results, and unknown omissions without charging discarded interpretations as retained output.                                 |
| Snapshots, caches, and comparison     | Vary metadata that affects the result while keeping payload bytes equal. Exercise historical records with newly introduced fields omitted, current caller inputs on replay, and reuse across differing selections. Assert correct invalidation or unknown coverage, current request provenance, and unchanged saved Evidence and IDs.              |
| Public success and error delivery     | Exercise affected public CLI/MCP paths, including partial Evidence on failure. Assert retained facts and named contracts; retrieve partial Evidence when MCP returns a reference. If SDK cancellation suppresses the reply, check server settlement and any retained Evidence. An error-code assertion alone misses lost observations.             |

For partial Evidence delivery, verify that same-session readback preserves
identity and provenance without rerunning the provider. Include a no-writer
control that keeps completed Evidence inline and preserves the original failure.

When producer order is unspecified, synchronize fixtures on the observed request
or completion event. A filename, generated key, or fixed delay does not prove
which item completed before cancellation. Preserve real producer ordering and
use a controlled seam for the phase that needs deterministic failure.

Packed bridge validation uses Python's standard-library AST and tar readers
with `-I -S`: caller-local modules, `PYTHONPATH`, and site startup hooks must
not replace those readers or execute during validation. Controlled `ast.py`
and `sitecustomize.py` fixtures must leave their markers absent and still
reject malformed packed Python with `SyntaxError`. This checks static package
verification, not real Hopper or Ghidra behavior.

Stateless source-analysis matrices may share a file-owned stdio MCP connection
and retain representative compiled CLI parity checks. Every distinct source
scenario still runs through the public workflow; session-lifecycle scenarios
need their own sessions and cleanup assertions.

Complete-inline-Evidence conformance uses
`scripts/lib/mcp-verification-environment.mjs`: a finite 65,536-element
allowance selected by the application harness, file-owned CLI/MCP session and
artifact verifiers.
Explicit harness environment selections take precedence. This keeps canonical
workflow assertions reachable for large retained observations. Admission-policy
tests launch the public server with the resource setting unset or explicitly
selected, including the default structured-input boundary and continued-service
checks. Downstream capacity fixtures select enough finite transport allowance
to reach their original memory, depth, cycle or representation boundary; retain
those stronger assertions.

When a matrix already holds a named tool definition from live `tools/list`,
pass that definition through the SDK's `toolDefinition` call option. This keeps
the selected output-schema validation without eagerly compiling unrelated
catalog schemas. Re-read definitions if the server advertises a changed list.

For exact nested input constraints, select the full profile explicitly or use
the full-SDK conformance suite that owns the field. Compact workflow tests
should assert canonical failure categories and provider-call controls where
rejection before provider work matters. Do not make today's omission of a
constraint a compact-profile invariant.

When a file repeatedly validates the same MCP schemas, use
`createMcpSchemaValidation` for file-owned preparation and clear it in
`afterAll`. Its content keys include the complete schema, and the SDK provider
keeps dialect and format validation. Keep sessions and connections scoped to
each test; share immutable schema preparation through the fixture's validator
dependency.

Artifact verification uses `artifactMcpCall` for both lifecycle and analysis
calls. A fresh SDK client has no held tool listing, so a bare `callTool` can
skip output-schema validation. The helper discovers actual advertised
definitions, rejects missing or ambiguous schemas, and validates the requested
tool without compiling unrelated catalog schemas. REA registers process-static
tool contracts; bindings share one discovery per negotiated connection and are
discarded on reconnect or failed discovery. Keep raw artifact calls on this
shared path and retain explicit request options such as timeouts.
Caller-supplied tool definitions are rejected: the helper owns selection from
the advertised catalog so a stale or permissive schema cannot bypass it.

The regression fixture changes only `canonical_path` in a real stdio response
to a number. The old helper accepts that response; the named schema must reject
it. This client-boundary fault injection does not establish native Apple
behavior, which remains covered by the macOS verification lane.

Report unavailable authority as a named skip. Await owned cleanup before a
verifier reports success. Native process inspectors are released at Vitest
worker teardown; fork termination does not run Node exit hooks, and per-file
teardown would retire inspectors still needed by other files.

Measure slow cases before pruning capacity coverage. Retain inputs beyond the
formerly failing size/depth and distinguish cold runs, warm builds, coverage,
and toolchain conditions when comparing timings.

## Lifecycle regressions

Investigation lifetime changes exercise public MCP target A/B switches, target-free
close and close cleanup failure/retry, with exact retained IDs and complete Unknown
revision histories. Verify engine replay/cache removal separately from retained
facts. An explicit reset must preserve a healthy engine and existing metadata
invalidation, drain an admitted signal-ignoring late result, block later work,
and prevent stale replay/source bindings from restoring old facts. Cover checkpoint
overwrite refusal, publication followed by cancellation or staging cleanup failure,
cleanup retry, then fresh-process bundle import with identical original references
and Unknown history. Capacity admission tests preserve the complete pre-state on
failed record/import/Unknown transactions, count duplicates once, account for
metadata size deltas and release budget on reset. Controlled providers and cleanup
seams establish ordering and failure semantics; real application/provider runs are
reported separately.

Hold successful and error replies at the MCP transport boundary while reset
queues behind their original admission. Verify checkpoint contents and publication
order, including SDK output validation failure, handler failure and cancellation
before or during send. Handler cleanup must settle even when the SDK suppresses
the reply. An outgoing server request with the same numeric ID as an incoming
tool request must not acknowledge that tool's response.

For changes to resource acquisition, readiness, cancellation, or cleanup, select
the affected owners and applicable scenarios below. Include temporary snapshots
and one-shot commands. Use public CLI/MCP workflows where practical and a
controlled production seam for interleavings that cannot be reproduced reliably.

| Scenario                                                                                | Assertion and control                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target admitted; startup still pending                                                  | Status preserves the readiness distinction and observed startup activity; readiness requires the provider's documented proof.                                                                                                                        |
| First handshake is late, absent, invalid, or recovered during close                     | Initial and recovery paths retain the same authenticated identity facts. Foreign run/token controls cannot authorize cleanup; authenticated idle/native work survives the unauthenticated listener deadline.                                         |
| Launch returns an error with a valid process handle                                     | Cover already-exited and still-live owned processes. Verify observed exit separately from creation; failed termination or unavailable identity remains unresolved.                                                                                   |
| Cancellation arrives after workload exit, during result reads or temporary-root removal | Return typed cancellation with available partial observations and actual cleanup status. The non-aborted control succeeds; existing primary/cleanup failures keep their precedence.                                                                  |
| Children have mixed health or cleanup outcomes                                          | Missing peer health does not erase an observed failure or activity. Idle plus unknown stays unknown. Retry a failed child without closing a successful peer again, including after a close-option change.                                            |
| Cleanup fails after success or primary failure                                          | Public output retains the completed observation or primary diagnostic, remaining resources, and owner recovery action. Restore the denied resource and verify the owning cleanup retry.                                                              |
| Cleanup owners recover after an error was returned                                      | Retain the original child and aggregate errors and project them after each owner releases. A successful peer stays released; the aggregate remains incomplete until all owners release. Preserve the first cause even when rejection is `undefined`. |
| Target exits without an acknowledgement, or transport disappears while it stays alive   | Positive owned exit proof resolves target lifetime; other resources still need cleanup. Lost transport alone does not prove exit. Verify unrelated/attached targets survive and same-connection recovery works when supported.                       |

Shared process-supervision controls separate leader exit from output closure.
Cover output during held or failed cleanup, bounded retention and drain timeout,
retry, and borrowed stream authority. The POSIX inherited-stderr control uses a
separate pipe as a release barrier after leader exit; it does not establish
native Windows Job Object behavior.

Synchronize cancellation with the finalization boundary being tested; a fixed
delay after dispatch does not establish that phase. Use markers, barriers, or
owned cleanup seams while preserving real cleanup where feasible. Check server
settlement and retained resources even if the MCP SDK rejects the client promise
before the handler finishes. A cancellation during active execution does not
cover cancellation during final cleanup.
For ZIP extraction, replace the pathname after inventory reader close while the
admitted root descriptor remains owned. Verify that identical member bytes in a
different carrier, a directory, or a missing pathname cannot switch the
materialized source. Exercise descriptor close failure and retry before output
publication.
Use explicit abort reasons and assert their identity at admission and after
provider completion, alongside retained observations and cleanup state.

Electron fuse regressions cover actual descriptor close denial and retry through
the built CLI, same-connection MCP recovery, mixed descriptor outcomes, and
server shutdown. Controlled seams cover cancellation during final close and
after reader finalization, plus active-provider shutdown during preflight.
They preserve real filesystem cleanup where possible; mocked launch boundaries
do not establish real Electron teardown or naturally occurring OS failures.

Active Electron cleanup controls retain independent transport and process-family
owners, block replacement captures until recovery, and retry only unresolved
owners. Cover late close acknowledgement and rejection after a wait deadline,
opaque rejection reasons, cancellation during failed finalization, and missing
lineage followed by a confirmed passive family census. Windows controls require
a fresh lineage observation and do not signal cached descendant PIDs after root
termination. Simulated Windows controls do not establish native Windows behavior.

Native process-ownership controls distinguish start identity, zombie lifecycle,
current parent/group relation, and token-read evidence. Retain generation-bound
candidates through smaller lineage observations, table omissions, reparenting,
group changes, and failed cleanup retries. Identityless exit-refresh controls
cover a replacement row that is not linked to the prior descendant set: a
matching token on its own group is signaled, a foreign or absent token is not,
an unreadable live token stays unresolved, a replacement that appears only in
the confirmation table is still token-checked, a group discovered during
revalidation is signaled before cleanup succeeds, a member that changes groups
during confirmation is signaled in its new group, a PID first seen with a
foreign token is read again on the confirmation table, a PID whose token was
already read is read again even when its parent and group return to the
pre-exit values, a pre-existing PID is read again when its parent or group
changes, an unchanged pre-existing row that was never token-read stays unread,
an unbounded confirmation
chain stays unresolved, lineage reads a row again when its launcher-tree
membership changes, a cached lineage token is read again on the next refresh, an initial descendant whose token already matched is read again on a later refresh, the launcher is read again on that refresh and a missing, unowned, or relation-changed launcher PID stays unavailable, a descendant absent from the latest refresh is omitted,
a group that reappears after it was processed is revalidated once, a further
reappearance stays unresolved, lineage publishes one row per PID, and lineage does not publish a
verified empty descendant list while that row remains unexamined. A readable token with unavailable
identity stays unresolved. Native UID facts, rather than an earlier process-table
row, determine whether a token denial concerns another user. Darwin tests compile
the helper and exercise snapshot growth, absence, lifecycle, and UID observations;
controlled Linux procfs tests do not establish real Linux exit or PID-reuse behavior.

For atomic writes, exercise cancellation on both sides of the documented commit
point and preserve any publication receipt. A late interruption does not prove
that no output was published.

For successful provider reports, test cancellation immediately before the report
reaches the application workflow as well as during provider cleanup. Validate
the report before classifying completion: a valid report must retain its Evidence
on cancellation, and an invalid report must keep its output error. Exercise both
the provider boundary and the shared CLI/MCP workflow; a downstream guard does
not repair the provider's own completion contract. When callers share startup,
cancel each waiter independently and verify that the last departure awaits owned
cleanup while interested peers can still reach readiness. Repeat the same
shutdown event after a cleanup failure to verify that its listener can retry.
Exercise non-default lifecycle deadlines through queued requests and their
consumers; default-only controls cannot detect dropped request options.

For descriptor-backed reads, inject a close failure after a successful read and
after a primary read or cancellation failure. Verify that the exact descriptor
remains owned, both failures survive, and a later close retries it. Repeat
admission attempts while close still fails: no additional descriptor or
native command should start. Restore close and verify that the exact owner
resolves the originating cleanup marker and allows later work, while the earlier
failure remains available as a diagnostic. Retain errors returned by multiple
failed retries, including admission and shutdown aggregates, and assert that
each becomes complete after recovery. For an aggregate with multiple owners,
release one owner while another still fails and assert that it remains incomplete.
Cover recovery before the
caller-specific error is bound to its retained owner, as
another request can retry cleanup concurrently. Confirm that an already released
owner resolves a later binding too. Include
admission failure after opening the descriptor. If caller cancellation returns
before an inspection settles, gate its final read or close and verify that
session shutdown waits for the owned work and reports any retained resources.
Gate a later read in a multi-read inspection, not only its first read. Overlap
operations so one retains a failed descriptor while another reaches its next
read; both the operation and shutdown must settle without nested-admission
deadlock. Deny child close and verify its containing root survives until retry.

Exercise publication on filesystems without hard links using an unsupported-link
seam. Check exclusive destination creation, stat/write/close failures, completed
output receipts, and cancellation at the documented cutoff. A streamed fallback
has different visibility from an atomic hard-link commit and must report it
accurately. For Windows command supervision, keep a descendant writing after its
leader exits, deny cleanup observation, and verify a competing writer remains
excluded until the exact Job Object closes. Portable doubles cover retry logic;
the native Windows lane must establish actual process-tree behavior.

Supervisor tests must observe process exit, output-pipe closure, and IPC
disconnection separately. In the pinned Node runtime, a parent-initiated IPC
disconnect can omit the aggregate `ChildProcess` close event. Join the actual
resource observations before reporting completion; process exit alone does not
establish pipe or process-tree release.

When changing an internal helper contract, check its JavaScript verifier and
subprocess-script consumers alongside TypeScript references. Source typecheck
does not check those calls; run their orchestration tests against the built
modules, including the verifier's failure and cleanup paths.

Representative regressions include
[process cleanup-time SIGINT](https://github.com/morluto/rea/blob/e78455338fe2d06c4cd03d59cbf33473d754998b/tests/boundary/process/processCaptureCancellationAdapters.test.ts),
[late authenticated cleanup](https://github.com/morluto/rea/blob/e78455338fe2d06c4cd03d59cbf33473d754998b/tests/boundary/providers/hopper/hopperClient.handshakeRecovery.test.ts),
[LLDB launch and finalization](https://github.com/morluto/rea/blob/e78455338fe2d06c4cd03d59cbf33473d754998b/tests/boundary/providers/native/lldbCallTracerFailures.test.ts),
[composed child ownership](https://github.com/morluto/rea/blob/e78455338fe2d06c4cd03d59cbf33473d754998b/src/application/binary/CompositeProvider.test.ts),
and [public CLI cleanup denial](https://github.com/morluto/rea/blob/e78455338fe2d06c4cd03d59cbf33473d754998b/tests/boundary/cli/wasmCleanupCli.test.ts).
These controlled probes do not replace the matching real-provider lane. Record
the base failure, passing control, exact host/provider, verified cleanup, and
unavailable coverage; a missing engine is not a pass.

## Behavioral depths

| Depth        | Location                | What it proves                                                                                        |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Module       | `src/**/*.test.ts`      | One domain, service, or adapter through its narrow public surface                                     |
| Composition  | `tests/composition/**`  | Provider-neutral session and registry wiring; filesystem access is limited to fixture materialization |
| Boundary     | `tests/boundary/**`     | Exactly one production filesystem, process, network, browser, CLI, or provider boundary               |
| MCP boundary | `tests/boundary/mcp/**` | MCP transport and tool-contract boundaries with isolated sessions and explicit cleanup                |
| Acceptance   | `tests/acceptance/**`   | A compiled CLI or MCP journey; injected providers still make it integration                           |
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

Focused immutable builders and recording ports shared by one test family live
beside their production owner as `src/**/*.fixture.ts`. They are typechecked
with the suite and excluded from package builds; broader runtime and provider
fixtures remain under `tests/fixtures/**`.

`tests/process-global/**` is reserved for cases with a demonstrated dependency
on process-global state. Those tests use isolated forks so environment and
exit-status changes cannot leak between files. Serialize a case only when it
demonstrably shares an external resource that cannot be isolated. Reusable,
test-scoped fixtures live under `tests/support/**`; immutable source artifacts
remain under `tests/fixtures/**`.
The process-global Vitest configuration contract rejects new direct temporary-root
creation outside the workspace seam and its narrowly documented boundary/package
exceptions.

The shared temporary-directory and workspace helpers preserve caller labels
under an owned `rea-` prefix when needed. Their
[cleanup ownership differs](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#temporary-files-and-diagnostics):
`createTestTempDirectory` registers `onTestFinished` deletion, while
`createTestWorkspace` requires caller cleanup. Close resources before removing
their directory. `npm run verify:test-temp-hygiene`
uses the same ownership rule to find retained fixtures under a private temporary
root. Third-party caches remain outside that ownership rule.

Real Hopper, Ghidra, IDA, browser, package, and managed-code claims belong to their
explicit `npm run verify:*` lanes. The reconstruction-readiness lane separates
observed native CLI inspection and JavaScript/Electron static CLI/MCP analysis
from synthetic report-evaluator conformance. Its determinism, tamper, and
stale-source checks concern the synthetic evaluator; they do not execute fixture
applications or verify runtime authority, cleanup, comparison, or reconstruction
closure. The evaluator and its semantic tests belong to
`tests/conformance/readiness/report/`, outside the shipped runtime. When
application runtime behavior is needed, exercise the actual target through
browser, Electron, or process capture. Real model trials are manual; Vitest
covers deterministic evaluator logic.

`verify:managed` runs the portable PE byte-fixture conformance entrypoint under
`scripts/verify/managed/`, with its byte builder under
`scripts/fixtures/managed/`. It checks static classification, members,
reconstruction, native-boundary relationships and application graphs without
executing fixture PE files. Operator-local manifests and actual ILSpy oracles
remain optional, separately reported checks; the real Ghidra NativeAOT lane has
its own toolchain prerequisites. See [the managed guide](managed-code-analysis.md)
for those configurations. Generated completion-ledger checks use the same owning
entrypoint and include its verifier/fixture files in their cache inputs.

## End-to-end, integration and golden evidence

Prefer the public CLI or MCP workflow when it can observe the required behavior.
Use production-boundary integration for contracts the complete workflow cannot
reliably exercise, and producer goldens for format-specific facts. An acceptance
case with an injected provider verifies that integration boundary; it does not
establish real-provider behavior.

For installed-client versions, executable selectors, disposable profiles, model
fixtures, and detailed receipts, see [client verification](client-verification.md#end-to-end-integration-and-golden-evidence).
Use [real-toolchain lanes](#real-toolchain-verification-lanes) for engines and
[agent evaluation](#agent-evaluation-and-conformance-records) for investigation
quality. Report unavailable tools or authority explicitly and verify owned
cleanup before claiming success.

## Coverage and timing

CI owns coverage; aggregate and domain/contract thresholds are maintained in
`vitest.config.ts`. They are glob-specific and never updated automatically.
Coverage does not replace named boundary or real-provider scenarios.

The `reverse-tools` commands run the focused tests and report coverage and
mutation results without an additional percentage requirement. Test failures,
invalid mutation configuration, and runner failures still fail the check.
Mutation targets cover reviewed production behavior, including signal-terminated
commands, Cutter descriptor identity, debugger cleanup ownership, GDB command
exit and cancellation, and Rizin startup, timeout Evidence, and process exit.
A second exhaustive pass runs the focused Cutter and Rizin timeout semantics tests against every compilable
selected mutant to avoid relying on per-test mutation coverage associations;
Stryker reports compile-error mutants separately because those cannot execute
tests. Both passes resolve named syntax owners, scoped declarations, guards,
callbacks, and reviewed expressions from the current TypeScript source; no
hand-maintained line ranges select mutations. Missing, ambiguous, or malformed
source targets stop configuration before mutation generation. The selections
retain their review scope rather than expanding to whole source files. The
focused suite also exercises affected MCP routes and the Python Cutter bridge.
Contract, integration, and real-provider lanes complement these focused tests;
simulated providers do not establish real-provider behavior.

Required CI retains fresh reverse-tools coverage and preflights both canonical
Stryker configurations with `--dryRunOnly`. These preflights resolve the owned
targets, instrument the source, and execute the real initial tests. Invalid
configuration, target resolution, and initial test failures still fail the job.
Preflights execute no mutants and produce no mutation-outcome report. Both fast
feedback and full qualification, including exact-revision release qualification,
require coverage and both preflights. A failed, canceled, skipped or missing
selected quality job still fails the required gate.

The separate **Mutation sweep** workflow runs both complete configurations daily
and on manual dispatch, in two isolated jobs. It is a maintenance check outside
the PR and release publication gates. `ci:full` requests full regression,
coverage and provider qualification; it does not request a complete mutation
sweep. Use the Mutation sweep workflow to request that result. Targets,
checkers, concurrency, deadlines and the existing non-blocking mutation-score
threshold are unchanged. `npm run test:mutation:reverse-tools` also retains both
complete passes for local callers.

The two passes write separate JSON and HTML reports under `reports/mutation/`:
`reverse-tools` and `reverse-tools-semantics`. Required CI retains focused
coverage; the sweep retains each configuration's JSON/HTML reports separately.
Both retain available diagnostics for seven days after failure and skip uploads
on cancellation. Artifact names identify the tier or configuration and run
attempt. A successful sweep requires both jobs and their nonempty reports;
partial diagnostics and preflights do not establish complete mutation outcomes
or qualify the release revision for mutation coverage.

Fast CI starts the source-only projects after classification, independently of
build and static checks, and runs eight built-dependent shards after the build.
Those nine test jobs still select every portable test. Full qualification keeps six
complete Vitest shards with coverage. Neither tier retries tests. Canonical
project ownership lives in `scripts/lib/test-projects.mjs`, shared by Vitest,
CI group execution, and development-test preparation. A test importing compiled
verifier code belongs to the built group even if its directory is conformance.
Source and built blobs have separate labels to prevent merge collisions.
Each test job emits a blob report; the merge job produces JUnit and JSON diagnostics, a module timing
report, plus aggregate coverage during full qualification. It retains available
reports even when a shard fails, uploads available diagnostics, and writes the
slowest files to the workflow summary. Partial reports are marked diagnostic
only. Failed, cancelled, or missing selected shards still fail the required gate,
and aggregate coverage thresholds remain enforced in full qualification.
Only a successful complete merge on the default branch publishes shard history,
and only from a push, schedule, or manual run. Fast runs publish
`test-timings-fast`. Full runs publish `test-timings-full`. Pull requests do not
publish it: the lookup reads one unpaginated artifact page, and pull-request
artifacts would crowd out the default branch. The build job downloads the
artifact that matches its tier, so fast shards use durations measured without
coverage and full shards keep coverage-weighted durations. A tier with no
qualifying artifact leaves history unset. The download is that small
checkout-relative timing file, not the coverage/JUnit bundle. Timing weights come from Vitest module
diagnostics and include tests and hooks, worker preparation, environment,
imports, and setup. Import timings already include transform waits, which are
not added again. The weights describe file costs under the measured worker and
coverage settings; their sum is not workflow elapsed time. The diagnostic
artifact retains the phase breakdown, while shard history keeps only each
file's total. Legacy test-body-only history and missing history fall back to native
sharding. Static checks, documentation, build, package verification, and
real-system lanes remain separate jobs so one kind of evidence cannot stand in
for another. Workflow syntax and expression validation runs inside the required
static-check job when workflow changes select it, avoiding a separate runner.
Native, provider, fixture, SQLite compatibility, and website lanes wait for
the fast static checks (typecheck, built lint, and format) to succeed before
allocating their runners. Knip, duplication, architecture guards, test
discovery, and the Python producer run in the separate full-tier deep static
job and do not gate provider admission. On the fast tier, changes to Python
bridges, analysis-efficiency inputs, or the Python test runner select a separate
required Python job. That job installs locked dependencies and prepares the
compiled runtime before the suite, because analysis-efficiency checks import
built process modules. Bridge tests are discovered from the source tree. The
mitmproxy, native, and pwndbg families must each contain a test module and
execute at least one non-skipped case or subtest. A parent case with only skipped
subtests does not satisfy this requirement. A newly added failing test fails the job.
Portable test shards and documentation checks remain independent of static results, so they can still provide
diagnostic feedback. The required gate rejects skipped selected lanes when
static checks fail; on the full tier it also requires the deep static job.
Passing revisions retain all selected coverage. This ordering reduces peak
demand on invalid revisions but can add static-check waiting to otherwise
passing runs; it is not a measured reduction in end-to-end latency.

Core jobs have execution limits of five minutes for classification, ten minutes
for static checks, builds, docs, and report merging, and thirty minutes per
portable test shard. These limits leave headroom for cold setup and full coverage
while preventing a hung job from holding the active main run for hours. They do
not bound runner queue waiting. Timeouts still fail the required gate.

The separate `CI timings` workflow also diagnoses missing, startup-failed,
queued/running, approval-required, canceled, and failed PR CI through bounded,
read-only API scans. Incomplete pagination or changing identity stays unknown.
It never closes/reopens PRs, reruns workflows, posts comments, or changes gates.
The timing manifest retains each run's event and head branch, including explicit
unknowns, so PR runs cannot consume the eligible-main comparison budget.
Its static failure report compares supported lint/duplication diagnostics with
failed main runs using exact source, ancestry, task hashes, and toolchain proof.
A match describes those diagnostics only; it does not establish that every
failure in a job came from main. Duplication reports retain the actual checker
exit result, so passing duplication checks preserve lint failures and caller
thresholds remain owned by the producer. Missing checker outcomes leave
those duplication diagnostics unclassified. Missing historical receipts remain unknown.
The reporter executes only trusted default-branch code and parses whitelisted
JSON artifact members without executing artifact content. Reports and limits
are retained in `ci-health-diagnostics`; its ten-minute job limit covers the
existing four-minute timing collection plus the bounded diagnostic stages.

Fast built shards target under ten minutes of uncontended shard-job execution.
That figure is the `test-shard` job. The job waits for classification and the
build, and the portable-test merge runs after the slowest shard. On 2026-10-20,
run `39451548945` measured those surrounding jobs with runner queue excluded:
classification 15 seconds, build 49 seconds, and the portable-test merge 29
seconds. Shard 1/5 of that run spent 22 seconds before built Vitest and 3
seconds after it, including `npm ci` at 9 seconds. `node_modules` is about 674
MiB, so publishing it as a shared artifact would transfer more data than that
install saves. The npm download cache stays the setup cache.

File timings from that run put the built suite at 7944 seconds of module time.
The sequencer keeps each file's full duration on one worker. Extra workers
overlap other files in the same sequence group, and `process-boundary` runs
after that group. Scheduling the unsplit inventory onto five shards peaks at
820 seconds of tests. That run's slowest built shard job lasted 925 seconds
(shard 4/5), and shard 1/5 spent 874 seconds in built Vitest, so hosted job
time sits above the file schedule. Six shards of the same inventory peak at
684 seconds of tests. Eight shards, after the 578-second loader file is split
by case count (54 cases stay in that file and 46 move into each of three
files), peak at 513 seconds of tests. With the measured 25-second shard setup,
that shard job is about 538 seconds. Adding the measured classification, build,
and merge makes an uncontended portable critical path of about 631 seconds,
still before the gap between this file schedule and hosted Vitest. Runner queue
is separate and grows when more shard jobs compete for runners.
`process-boundary` stays serial because process-tree sampling shares the host.
Raising the worker cap from two to four on this four-core host cut a six-file
acceptance sample from 96–101 seconds to 71 seconds and did not remove the
single-file floor, so the cap stays two. Full qualification keeps six covered
shards; its longer instrumentation is outside this fast budget.

The separate `CI timings` workflow batches recent completed CI and Release runs
hourly or on manual dispatch. It uploads `ci-job-timings-batch` with raw API pages and
a normalized point-in-time report for each collected workflow attempt, plus a
batch manifest describing examined coverage, failures, and limits. Overlapping
lookback windows may collect an attempt again; identify records by run ID and
attempt. Each batch examines at most 100 completed runs per workflow created in
the preceding 24 hours, with a four-minute API collection budget. It collects the
latest attempt of each selected run and does not claim an exhaustive archive.
It runs the reporter from the trusted default branch with read-only permissions,
treating workflow runs as API data. It does not allocate a new reporter job for
every completed, cancelled, or skipped workflow. Reports separate queue
waiting (`created_at` to `started_at`) from completed execution and report
percentiles plus matched `npm ci` and artifact-step durations.
Queue excludes dependency waiting before job creation and does not establish
whether account concurrency or runner availability caused the wait. Queued jobs with
placeholder start times, skipped jobs, and missing or invalid timestamps remain
unknown. The reporter targets each selected run and attempt explicitly.
Summed job elapsed time is parallel work, not workflow wall time, CPU time,
memory usage, or billing. Step names identify samples, not complete transfer
costs. Its queue, execution, and failures are independent of the required gate
and publication. CPU time and peak process-family memory are not measured by this API.

The build job saves portable Turbo outputs across runs. Eight Linux real-system
lanes reuse its current-run artifact; standalone dispatches restore the cross-run cache. The shared action
derives its key from `test:prepare --dry=json` task hashes, runner OS and
architecture, `.npmrc`, `.nvmrc`, and the lockfile; test-only changes can reuse compiled outputs. Every
build and verification command still runs, so Turbo checks task inputs and
rebuilds misses. A restore prefix with the same platform and toolchain permits
partial task reuse when one generator's inputs change; Turbo still invalidates
that generator's entry. Native outputs are not stored in this cache.

Native package jobs, the Windows curated lane, and the Apple artifact lane reuse
the same workflow's Turbo cache for portable compiled JavaScript, skills, and
catalogs. The key parser retains the validated `test:prepare` task identities in
`.cache/ci-build-plan.json`; staging reads this plan without starting another
Turbo run that could evict cache entries. The producer stages matching archives,
metadata, and available manifests into `.cache/ci-build-cache/`.
`portable-build-cache.json` records availability per task. Evicted or partially
missing entries are omitted as whole entries, and consumers rebuild cache misses,
including when every entry is unavailable. Malformed plans, non-file entries,
and I/O errors other than disappearance still fail publication. After a trusted
static run, superseded cross-run Turbo snapshots for that OS and architecture
are deleted down to the two newest generations. The Windows lane also runs the
official compiler's complete source typecheck with two checker threads,
independently of the accelerated Linux checker. Both lanes retain the normal
build and prepack commands, which restore matching outputs or rebuild on a cache
miss. Native
artifacts, dependency installs, package archives, and runtime verification remain
host-local. Keep platform-dependent outputs out of this shared cache.

The Windows native verifier's private-runtime ACL observer reads the owner and
access rules only in SID form, checks that every identity it compares is a
`SecurityIdentifier`, and never uses `Get-Acl` or the convenience `Access`
property, which resolves account names. Its Windows PowerShell observers call
.NET members directly and build their JSON without cmdlets, pipelines, module
autoloading, or type-table updates. The `private-runtime-acl` stderr markers
report the powershell.exe process uptime and each completed phase; inspect them
on a timeout before attributing it to startup, ACL reads, or identity lookup.
The 60-second observer deadline bounds a hung observer while covering a cold
powershell.exe start on a starved hosted runner. All ownership, DACL, and
readonly assertions remain in force. A passing retry alone does not explain a
previous timeout.

Record cold and warm preparation separately from fresh test execution when
benchmarking the optional `npm run check:pr` gate. Compare multiple runs on the
same host, including subprocess and queue costs; a cached pass is not a test
runtime measurement. A PR that touches packaging or real-system
behavior requires the applicable `verify:*` lanes; packaging and installation
changes also require `npm run verify:package`. The full-gate benchmark measures
that explicit lane, not the routine iteration requirement.

The package-update registry fixture retains its first proxy/body failure and
aborts the owned updater command. It joins the helper and installer descendants
before workspace removal. Incomplete process cleanup retains the exact owner
and workspace rather than reporting successful removal. The controlled
`packageUpdateRegistryFailure` regression needs built process modules, uses no
public registry, and checks both the primary failure and live descendant absence.

## Real-toolchain verification lanes

See [Real-toolchain verification lanes](testing-lanes.md#real-toolchain-verification-lanes).

## Android APK analysis

See [Android APK analysis](testing-lanes.md#android-apk-analysis).

## Apktool resource decoding

See [Apktool resource decoding](testing-lanes.md#apktool-resource-decoding).

## Flutter build identification

See [Flutter build identification](testing-lanes.md#flutter-build-identification).

## ADB device acquisition

See [ADB device acquisition](testing-lanes.md#adb-device-acquisition).

## Optional NativeAOT Ghidra analysis

See [Optional NativeAOT Ghidra analysis](testing-lanes.md#optional-nativeaot-ghidra-analysis).

## IDA MCP adapter

See [IDA MCP adapter](testing-lanes.md#ida-mcp-adapter).

## Kuna lane

See [Kuna lane](testing-lanes.md#kuna-lane).

## DOS Ghidra analysis

See [DOS Ghidra analysis](testing-lanes.md#dos-ghidra-analysis).

## Apple Interface Builder archives

See [Apple Interface Builder archives](testing-lanes.md#apple-interface-builder-archives).

## Native platform baseline in CI

See [Native platform baseline in CI](testing-lanes.md#native-platform-baseline-in-ci).

### Termux Android browser smoke test

See [Termux Android browser smoke test](testing-lanes.md#termux-android-browser-smoke-test).

## Packet capture analysis

See [Packet capture analysis](testing-lanes.md#packet-capture-analysis).

## Apple native metadata and UI

See [Apple native metadata and UI](testing-lanes.md#apple-native-metadata-and-ui).

### Firmware adapters

See [Firmware adapters](testing-lanes.md#firmware-adapters).

### JavaScript source recovery

See [JavaScript source recovery](testing-lanes.md#javascript-source-recovery).

### Captured website source-map lane

See [Captured website source-map lane](testing-lanes.md#captured-website-source-map-lane).

### JavaScript large-output lane

See [JavaScript large-output lane](testing-lanes.md#javascript-large-output-lane).

### Website runtime attribution lane

See [Website runtime attribution lane](testing-lanes.md#website-runtime-attribution-lane).

### Offline binary layout

See [Offline binary layout](testing-lanes.md#offline-binary-layout).

### Offline EVM interface

See [Offline EVM interface](testing-lanes.md#offline-evm-interface).

### Recorded crash evidence

See [Recorded crash evidence](testing-lanes.md#recorded-crash-evidence).

### Exported environment bundles

See [Exported environment bundles](testing-lanes.md#exported-environment-bundles).

## Agent evaluation and conformance records

See [Agent evaluation and conformance records](testing-lanes.md#agent-evaluation-and-conformance-records).

## Frida instrumentation

See [Frida instrumentation](testing-lanes.md#frida-instrumentation).

### Offline WASM artifacts

See [Offline WASM artifacts](testing-lanes.md#offline-wasm-artifacts).
