# Test suite audit

## Scope and priority

Inventory on 2026-10-04: 354 Vitest files, with 82 domain/contracts, 44 service,
48 adapter, 12 composition, 84 filesystem/process/provider/browser/CLI boundary,
44 MCP boundary, nine process boundary, nine acceptance, four process-global,
17 conformance and one evaluation file. These counts describe configuration,
not how many tests use real providers. The detailed review covered the native
additions in PR #500, generic contract checks, setup acceptance, representative
schema and prompt tests, real verifier scripts and CI wiring.

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
| Package failure classifier under acceptance                                                     | Move to process boundary              | Preserve all malformed/unrelated-failure rejection cases; do not call them E2E                                                       |
| Native value graph checks conditional on success                                                | Strengthen                            | Require success before pagination/ambiguity assertions; unexpected errors can no longer pass                                         |
| Native UI verifier treating permission denial as a positive pass                                | Separate outcomes                     | Default lane requires real capture/action success; opt-in permissions lane explicitly reports no positive E2E proof                  |

Ten previous test cases were removed or consolidated; three replacement
Vitest cases cover the captured goldens and release guard. The two real artifact
E2E scripts add product-level evidence outside the deterministic Vitest count.

## Coverage kept

Malformed archives, broken and cyclic references, unsupported metadata pointers,
relative Objective-C method layouts, ambiguous call candidates, digest mismatch,
cancellation, permission approval, bounded output and owned-resource cleanup
remain covered. These cases provide evidence beyond a successful real-tool run.
The hand-assembled relative method fixture stays until compiler-produced
relative-list fixtures establish equivalent assertions.

## Remaining priorities

1. Real Ghidra → CLI and stdio MCP value/dispatch/UI-handler journeys before
   pruning hand-authored composition success cases. Current Ghidra verifier
   proves provider behavior but not every new workflow's transport parity.
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
