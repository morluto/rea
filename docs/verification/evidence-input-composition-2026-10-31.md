# Evidence input composition verification

The shared declaration and request resolver cover 20 individual-Evidence
composition tools. Artifact file sources, analysis views and environment export
keep their explicit source owners. Catalog conformance checks those boundaries
and rejects undeclared record inputs or unsupported source containers.

This record accompanies [#8293](https://github.com/morluto/rea/issues/8293) and
the real Ghidra input-capacity regression
[#8281](https://github.com/morluto/rea/issues/8281).
The [machine-readable receipt](evidence-input-composition-2026-10-31.json)
retains all fourteen model attempts, artifact identities, oracle provenance,
tool profiles, actual usage, resource measurements and limitations.

## Runtime and measurement scope

Tests used Node 24.22.1 and local Codex CLI 0.165.0, explicitly requesting
`gpt-6.1-terra` with reasoning `high`. This identifies the requested alias;
the resolved server model is not inferred. Both dirty candidate builds were
based on `23de10bb2849cdce8ddbe70504aa7cc57de75a98`. Their complete built-file
fingerprints are recorded in the receipt. The later build includes the shared
reference-format hint and authenticated source/type-boundary corrections.
Subsequent cleanup reused the existing pure semantic-query input schema and
moved SDK tests into their boundary project. Full and compact catalog bytes
remained identical to the later model build; 22 affected checks were rerun.

Heavy tasks ran serially in owned Linux scopes: one CPU, 4 GiB hard memory,
3 GiB early stop, no swap and at most 192 tasks. CPU and peak memory are kernel
process-family counters at payload exit while the observer remains alive;
they are not final whole-scope counters. Cleanup was verified for every model
attempt and CLI phase. No OOM event occurred.

Each model task starts a fresh MCP process and isolated client profile. Native
tasks start a fresh Ghidra database, then reuse its two retained dossiers.
System/filesystem caches were not cleared; cold filesystem costs are unmeasured.
Initial primary tasks used the complete catalog. Later scoped tasks are labeled
`diagnostic/catalog-selection`; their different tools, guidance and selected
facts prevent a controlled speed or token comparison.

## Real application results

| Domain           | Real artifact                                          | Reviewed outcome                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native           | Installed jq ELF, real Ghidra 12.1.4                   | Each selected function analyzed once; complete parent references supported a direct one-hop path and function comparison. Independent `objdump` corroborated the selected call. Nonexhaustive frontier and behavioral uncertainty remained visible.                                         |
| Managed          | Shipped NuGet.CommandLine.XPlat.dll, assembly 6.11.2.1 | Artifact/member parent references projected a managed graph. The existing distinct-Evidence rule refused self-comparison. Digest, MVID, owner/token and selected CIL facts matched an independent metadata reader; its parser warnings limit that oracle's scope.                           |
| JavaScript       | Obsidian 1.14.4 ASAR                                   | Partial: the producer hit its existing 300-second per-source timeout. The retained parent still supported a semantic trace. A bidirectional feature trace exceeded 10 MiB and had no supported retained summary. Tracked separately in [#8296](https://github.com/morluto/rea/issues/8296). |
| JavaScript       | Shipped agent-browser 0.27.0 CLI entrypoint            | The final scoped task analyzed the exact selected source once, then reused its parent for feature and semantic traces. Independent source facts confirmed builtin imports/call locations. Unselected sources remained unknown; directory and file digests were distinguished.               |
| WASM             | Shipped VS Code Tree-sitter CSS module                 | One real WABT inspection supplied retained references for export comparison and a portable bundle. An independent raw WASM reader confirmed seven imports, three exports and `tree_sitter_css: () -> i32`. Static interface equality did not imply runtime compatibility.                   |
| Artifact / Apple | Rectangle 2.0.4 release ZIP                            | One retained inventory supported Apple projection and artifact comparison. Independent ZIP and Mach-O observations corroborated paths/content. Symlink metadata gaps remained unknown.                                                                                                      |
| Android          | NewPipe 0.29.1 release APK                             | One retained inventory supported Android projection. Independent ZIP observations confirmed manifest, three DEX files and four ABI library members/digests. JNI path-pair hypotheses stayed inferred.                                                                                       |
| Harmony          | Shark 1.0.8 release APP and its real inner HAP         | Both retained inventories supported Harmony projection. Separate ZIP/JSON checks preserved outer ZIP, APP and HAP identities, Stage/Ark/resource path observations and shallow APP coverage. Signature naming was not treated as cryptographic verification.                                |
| Process          | Two controlled real jq CLI captures                    | Authentic captures were imported and compared by references, then their retained comparison was aggregated. MCP output deep-equaled the existing inline CLI result. Terminal change, settlement differences, filesystem/process unknowns and source closure were preserved.                 |

The first supplemental agent-browser model task wandered into unrelated
inventory tools and failed to perform the requested producer analysis. It was
stopped and retained as an interrupted failure, including cumulative usage as
a lower bound. The successful later scoped task does not erase that attempt.
The missing-reference task produced its expected typed failure without opening
a target, repeating a request or inventing Evidence.

## Actual model task costs

Input counts include schemas, accumulated context, extra calls and retries.
Cached input is a subset of total input. Reasoning is included in output;
its separate subset is retained in JSON. These are completed task costs, not
serialized-byte estimates. The initial partial/interrupted attempts and their
costs also remain in the receipt.

| Later task                     | Calls / failed | Input tokens | Cached input | Output tokens | Task elapsed (s) | Family CPU (s) |    Peak bytes |
| ------------------------------ | -------------: | -----------: | -----------: | ------------: | ---------------: | -------------: | ------------: |
| jq, complete catalog           |         11 / 0 |      599,933 |      535,424 |         1,894 |           80.931 |      38.326466 | 1,269,936,128 |
| agent-browser, scoped          |         12 / 1 |      619,589 |      563,712 |         2,519 |           54.521 |       9.472096 |   903,847,936 |
| NewPipe, scoped                |          5 / 0 |      179,635 |      150,528 |         1,750 |           40.835 |      10.080132 |   704,409,600 |
| Shark APP, scoped              |          6 / 0 |      221,571 |      197,376 |         1,339 |           32.437 |       6.377128 |   560,021,504 |
| Shark HAP, scoped              |          5 / 0 |      184,452 |      152,576 |         1,212 |           31.108 |       6.012587 |   580,714,496 |
| WASM plus export, scoped       |          4 / 0 |      161,702 |      141,056 |         1,033 |           32.320 |       9.036127 |   700,076,032 |
| Imported process chain, scoped |          3 / 0 |       89,101 |       73,984 |           725 |           26.911 |       5.575060 |   531,283,968 |

The later jq task made no malformed reference calls, while the initial task
omitted the required `kind` twice. It selected a different callee and made three
guidance calls; its longer elapsed time and different facts preclude attributing
a general improvement to the new hint.

## Equivalent portable CLI comparison

The actual WASM model task exported a 13,925,066-byte authenticated bundle.
Both fresh CLI processes selected its same complete inspection parent and
compared exports against that parent. Their 3,732-byte outputs were byte-identical
and deep-equal to the model's MCP comparison:
`ev_b32346965c153a067abff9698aeba1ccbace34c78ac2071ac18311250b68c6da`.
Bundle, selected source and runtime hashes stayed unchanged. Neither CLI arm
started a decoder or reanalyzed the module.

| Input                              | Request bytes | Elapsed including scope (s) | Family CPU (s) |  Peak bytes |
| ---------------------------------- | ------------: | --------------------------: | -------------: | ----------: |
| Complete inline pair               |    27,823,017 |                       2.832 |       2.612440 | 370,515,968 |
| Retained pair plus selected bundle |           261 |                       2.632 |       2.385397 | 310,009,856 |

The reference arm still reads/authenticates the existing bundle. This single
ordered pair ran inline first with shared uncontrolled host caches. It establishes
equivalent completed results and records observed costs; it does not establish
a general speedup. Common upstream inspection/export costs appear in the model
table. Preparation additionally cost 1.119 s / 0.875255 CPU s / 316,796,928 peak
bytes; verification cost 0.518 s / 0.282755 CPU s / 42,881,024 peak bytes.
The optional tokenizer was unavailable, so request-token savings are unmeasured.
Request bytes are not presented as model tokens.

## Regression and coverage limits

The focused regression run passed 508 checks covering source integrity, exact
IDs, mixed/optional/nested selections, default constraints, converted full and
compact SDK schemas, source closure, caller choices, CLI bundle immutability,
capacity admission and late cancellation/source retention. SDK boundary tests
are kept in the MCP boundary project; pure declaration checks stay in contracts.

Full-library lint exceeded the local early-stop limit even with one worker.
The same selected 6,105 files were checked in sequential batches of 400;
peak family memory was 741,650,432 bytes. Two new test grouping errors were
corrected and those files rerun. Failed lint/driver attempts remain in local
receipts. Process-driver path/ANSI oracle corrections reused the original
authentic captures.

No real Hopper, IDA, Windows capture, Android device, Harmony runtime, passive
browser reconciliation or managed/native runtime equivalence is established
by these tests. There is no controlled main-versus-candidate model cohort,
no cold filesystem measurement and no claim that every provider facet was
independently verified.
