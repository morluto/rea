# Test suite audit

## Scope and priority

The expanded audit on 2026-10-04 reviewed every one of the 355 Vitest files
present at its start: 82 domain/contracts, 56 application/composition, 147
adapter/configuration/process/filesystem/CLI files, and 70 MCP/acceptance/
conformance/evaluation files. Three review passes checked the proposed removals
against existing stronger coverage and checked the final changes for lost
assertions. The remaining suite has 351 files.

Prefer full real-provider E2E, then integration across schemas and transports,
then real-data goldens. Remove lower-level duplication once the replacement
asserts the same behavior. Keep distinct failure regressions that a successful
E2E cannot exercise. Do not lower coverage thresholds to accommodate pruning.

## Changes made

| Previous test or assertion                                                                      | Decision                              | Replacement or retained claim                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Asset application tests using fabricated `.car` bytes and injected utility JSON                 | Remove two plumbing cases             | `verify:asset-catalog`: real actool → assetutil → CLI and stdio MCP, including digest, full metadata, pagination and invalid input   |
| Keyed archive positive binary/XML objects assembled with the same plist library as the reader   | Remove two synthetic success cases    | Captured Foundation XML plus reviewed complete object/reference graph golden; real Foundation binary/XML → CLI and stdio MCP         |
| Generic contract schema/annotation/example loops and output-map inventory comparisons           | Consolidate into one SDK wire test    | Assert exported schemas, guidance, effect annotations and valid examples on the actual advertised MCP catalog                        |
| Ghidra function operation enum membership                                                       | Remove                                | Canonical catalog, provider handshake and actual operation roundtrips establish admission; malformed provider results remain covered |
| Asset page assertion pinning `10_001`                                                           | Remove                                | Invalid-page rejection through real MCP; malformed utility data still covered                                                        |
| Suggested prompt tool positions                                                                 | Remove incidental ordering assertions | Keep authority, evidence, untrusted input and preparation constraints                                                                |
| Package “acceptance” assertions pinning CI matrix/shard values and fake launcher command arrays | Remove configuration-shaped cases     | Actual package/install verifier remains; retain a compact release verification-before-publish and registry-canary static guard       |
| Package failure classifier under acceptance                                                     | Move to package evaluation            | Preserve all malformed/unrelated-failure rejection cases; do not call them E2E                                                       |
| Native value graph checks conditional on success                                                | Strengthen                            | Require success before pagination/ambiguity assertions; unexpected errors can no longer pass                                         |
| Native UI verifier treating permission denial as a positive pass                                | Separate outcomes                     | Default lane requires real capture/action success; opt-in permissions lane explicitly reports no positive E2E proof                  |

Ten previous test cases were removed or consolidated; three replacement
Vitest cases cover the captured goldens and release guard. The two real artifact
E2E scripts add product-level evidence outside the deterministic Vitest count.

## Exhaustive follow-up

The follow-up removes or consolidates another 31 test declarations, including
three redundant test files. Parameterized declarations and executed cases have
different counts; the figures above count source declarations. It also repairs
assertions that could pass without exercising their stated behavior.

| Area                         | Cleanup                                                                                                                       | Stronger retained evidence                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Configuration                | Merge duplicate target/loader tests and preserve custom launcher, explicit provider and actionable error diagnostics          | Independent malformed inputs; each capability flag is rejected separately                                         |
| Browser scenarios            | Remove fake launch success and expression-selected artifact success                                                           | Real Chromium scenarios, actual artifacts, CLI capture and owned/external cleanup in `verify:browser`             |
| CLI policy                   | Remove duplicate confirmation helper cases                                                                                    | Compiled CLI proves project files stay unchanged until `--yes`; distinct interactive choices remain               |
| Provider capabilities        | Remove numerical catalog freezes; consolidate Hopper byte-read discovery                                                      | Exact canonical capability identities, admission, mutation effects and detached descriptors                       |
| Evidence ledger              | Merge reordered-key checks into serialized bundle import; remove one-record quota claims                                      | Atomic import, conflicts, residual revisions, actual large collections and byte regressions                       |
| MCP batching and concurrency | Replace maximum concurrency and empty indistinguishable responses                                                             | Every distinct ordered batch result; concurrently gated requests complete in reverse order with matching payloads |
| MCP inventories and graphs   | Remove traversal/inventory call order and redundant catalog/prose checks                                                      | Exact complete cyclic graph, full inline inventories, canonical SDK catalog and all-handler roundtrips            |
| Authority and lifecycle      | Attempt the refused Ghidra mutation; require successful setup, call and switch; close twice                                   | Typed refusal with zero mutation dispatch, restored target calls and exact owned-resource cleanup                 |
| Process and provider output  | Remove incidental environment read and command option order/defaults                                                          | PID/ownership validation, exact disabled-policy failure and complete decoded response above 10 MiB                |
| Conformance and CI guards    | Merge identical replay runs; remove duplicate missing-row fault, trivial hash/self equality and incidental worker/step counts | Distinct faulty evidence, digest order, actual test discovery, file existence and release/runner authority        |
| Pure schemas                 | Remove fabricated comparison-dimension injection and impossible long boundary success                                         | Real artifact comparison and SDK coverage evaluation with returned boundary identity                              |

The removed long boundary selector test only parsed a 1,000-character request;
workspace boundary identities admit at most 200 characters, so that positive
could never represent a successful evaluation. The actual MCP evaluation stays
covered. One unused ledger serialization helper was also retired after removing
its only test consumer; no CLI or MCP contract changed.

No further immediately safe pruning was identified in the final review. Retained
replacement candidates below are coverage gaps, rather than permission to delete
unique tests. Test-only domain scaffolding also stays pending a separate decision
about the corresponding source behavior; deleting those tests alone would leave
unverified code and fail unused-export checks.

## Stronger replacements from the closing pass

Three more synthetic success cases were removed. Native value composition now
runs through the production CLI and a separate stdio MCP subprocess with real
Ghidra, using a source-built native fixture. It checks argument/parameter/return
relationships, the fixture's global operand, authenticated Evidence, upstream
and workflow analysis profiles, identical CLI/MCP graphs, discovery availability
and successful MCP session closure. Ambiguity, cancellation, target changes,
missing flow and bounded-work regressions remain in the focused suite.

That replacement found missing CLI workflow routing for `trace_native_values`
and missing workflow profile classification. The routing and discovery now use
the composed operation's actual provider prerequisites; workflow Evidence commits
to the upstream Ghidra profile.

The lone hand-built client-document equality test is replaced by a real TOML
filesystem transaction: reversed environment keys leave the original bytes
unchanged and create no backup. A real ZIP entry with an application root longer
than 5,000 characters replaces injected schema-only positive data. Inventory
completeness tests partition actual scans into authenticated partial observations
and require exact assembled results and every source citation, including more
than 100 citations. These are consumer merge tests, not provider pagination
claims. Replay aggregation now covers all four statuses and retains actual runner
diagnostics; it does not claim to execute a real sandbox. Retained pixel-metric
fixtures now write correct PNG chunk checksums.

The all-zero screenshot buffer is replaced by a real Chromium PNG of 9,467,940
bytes, transported intact through CLI and stdio MCP and decoded by the production
pixel comparator. The verifier configures the SDK client's receive buffer because
its 10 MiB default is smaller than the inline JSON response. This does not claim
large comparison-request transport coverage. A real SDK initialize request,
captured during a successful production stdio handshake, replaces the JSON-RPC
decoder's field-count-only oracle with exact field/value expectations.

The closing pass also removed assertions tied to internal call order, defaults,
private cache sizes, duplicated polling and fabricated schema extensions. Unique
malformed-input, security-capacity and cleanup regressions remain.

## Real process regression found

The full suite exposed a renderer ordering race. Publishing a terminal output
journal entry could synchronously trigger a reactive resize before the preceding
output was queued for rendering. Queue that output first. The existing real
source-owned interactive PTY test now also requires the first resized frame to
contain the output that triggered the resize, preserving the original event
order rather than sorting or changing timestamps to conceal it.

## Coverage kept

Malformed archives, broken and cyclic references, unsupported metadata pointers,
relative Objective-C method layouts, ambiguous call candidates, digest mismatch,
cancellation, host permission denial, bounded output and owned-resource cleanup
remain covered. These cases provide evidence beyond a successful real-tool run.
The hand-assembled relative method fixture stays until compiler-produced
relative-list fixtures establish equivalent assertions.

## Remaining priorities

1. Extend the real Ghidra CLI/stdio MCP journey from value tracing to dispatch
   and UI handlers before pruning their hand-authored composition success cases.
   Native value tracing now establishes full transport parity.
2. Real binary dispatch and nib → full product transports, with normalized
   semantic goldens. The compiler-backed readers already run in the new Apple
   CI lane; synthetic pointer/layout rejection tests remain useful.
3. An approved interactive macOS runner for native UI capture/actions, including
   stdio MCP scenarios. Hosted runners without permissions cannot supply this
   proof. No arbitrary application's windows should be opened for this lane.
4. Real macOS/Linux Ghidra CI runners with bring-your-own installations. This
   change adds Apple artifact CI without installing Java or Ghidra.
5. Classify fake-runner replay/application acceptance accurately and replace
   repeated happy paths only after real sandbox journeys assert the same claims.
   The replay workflow's allow-unavailable mode must not imply executed replay.
6. Replace repeated-array schema ceiling tests with real producer/transport
   regressions before deleting them. Existing integration tests do not yet
   establish their large-input guarantees.

Some static guards protect irreversible release authority rather than product
behavior. Keep these few guards explicit and separate from E2E evidence.

## Verification after the expanded audit

- `npm run check:pr`: 351 files passed; 1,794 tests passed and two skipped.
  Typecheck, lint, formatting, unused-code and generated-document gates passed.
- `npm run check:fast`: passed; 70 lint warnings and zero errors.
- `npm run verify:browser`: actual Chromium observation and scenario CLI routes,
  retained artifacts, owned/external lifecycle checks and large CLI/stdio MCP PNG
  capture passed.
- `npm run verify:ghidra`: macOS ARM64 with Ghidra 12.1.4/JDK 21 passed, including
  real native value tracing through CLI and stdio MCP: 171 nodes, 298 edges and
  six decompilations.
- `npm run verify:asset-catalog`: real actool/assetutil → CLI and stdio MCP,
  complete records, pagination and malformed input checks passed.
- `npm run verify:keyed-archive`: real Foundation binary/XML → CLI and stdio MCP,
  full graph golden, shared/cyclic identity and malformed scope checks passed.

- `npm run verify:fixtures`: seven source-built host fixtures, source/artifact
  digests and exhaustive inventory checks passed.

No Hopper windows were opened for this audit. The closing pass runs real Ghidra
on macOS ARM64; earlier Hopper evidence remains separate. No new hosted CI success
is claimed.
