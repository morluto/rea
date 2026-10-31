# Radare2 shared-provider implementation scope

Production integration remains pending the linked REA maintainer scope decision
required by [CONTRIBUTING.md](../../CONTRIBUTING.md#fail-closed-integration).
The review on 2026-10-15 found no decision in #2711, #3521 or #4148; #3521's
current body also explicitly records that decision as pending. A ready PR,
working prototype or successful test does not supply that decision.

The requested outcome is normal `open_binary` provider selection followed by the
same shared CLI/MCP operations supported by the IDA adapter. This document fixes
the proposed boundary and verification scope for that decision. It does not
claim those operations are implemented by this experiment.

## Reuse and ownership

Build the owned r2pipe2 path on #3521's `Radare2SessionManager`, keeping one owner
for framing, serialization, cancellation, process identity and cleanup. Do not
copy that manager into this PR or make #3521 depend on the shared provider.
Its existing arbitrary-command family and this proposed typed adapter have
different admission/effect contracts. A fixed typed operation must never
interpolate a symbol, search pattern or document value as an r2 expression.

The proposed adapter owns native JSON parsing and normalization. The application
continues to own shared workflows, Evidence admission, retention and views.
Use `AnalysisProviderCandidate`, `AnalysisClient`, `createAnalysisExecution` and
existing operation-specific schemas. Initial results use `cachePolicy: "live"`;
file identity alone cannot establish an unchanged live core or analysis revision.

Keep four explicit carrier choices: retained owned r2pipe2, one-shot commands,
named r2mcp tools, and caller-owned HTTP/iaito using POST `/cmd`. A caller's
connection choice must not trigger a silent fallback. HTTP attachment never
reopens its input, sends `q`, or terminates iaito. If the external core cannot be
bound to the admitted target, report typed target operations unavailable while
preserving the separately authorized raw-command path and its uncertainty.

r2mcp is sufficient as a typed transport when its advertised named operation
actually supplies the necessary facts. Inspect `tools/list` by name, validate
each selected input contract and preserve source text when no structured facts
are supplied. Do not parse display text into invented facts or implicitly enable
`run_command`. Its current function listing can run `aaa`; an inventory-only
policy must refuse that behavior rather than quietly changing analysis policy.

## Shared operation mapping

These are proposed native sources, not new REA tool names. The IDA baseline is
the 14 names in `src/ida/IdaProviderCapabilities.ts`; profile restrictions and
unknown facets matter as much as the names.

| Existing operation             | Proposed r2 facts                                                       | Required interpretation                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list_procedures`              | `aflj`, or r2mcp `list_functions`                                       | Analyzed inventory only; an empty uninitialized core cannot prove absence.                                                          |
| `search_procedures`            | Same inventory                                                          | Existing literal/regex search semantics, deterministic order, complete inventory before claiming complete matches.                  |
| `list_strings`                 | Native string inventory, or r2mcp `list_strings`                        | Preserve address, source rendering, encoding/byte-length facts and unknowns; scanning candidates and typed strings remain distinct. |
| `search_strings`               | Same chosen string inventory                                            | Preserve query semantics and exact inventory coverage.                                                                              |
| `procedure_address`            | Exact name inventory / native function identity                         | Resolve a unique canonical entry; reject ambiguous names; never evaluate caller names as commands.                                  |
| `procedure_pseudo_code`        | Explicit `pdg`, `pdc` or `decai` choice; r2mcp `decompile_function`     | Recommend r2ghidra, retain selected producer/profile, preserve failure diagnostics; no silent decompiler switch.                    |
| `procedure_assembly`           | Recovered function graph instructions / r2mcp `disassemble_function`    | Cover recovered noncontiguous blocks; preserve source order and contradictory duplicate-address observations.                       |
| `procedure_callers`            | Typed incoming native references plus containing-function lookup        | Prove direct calls instead of treating every code reference as a caller; report observed-set coverage.                              |
| `procedure_callees`            | Typed outgoing references / decoded call instructions                   | Keep unresolved indirect calls and tail jumps distinct from proven direct callees.                                                  |
| `read_function_instructions`   | Same recovered instruction facts as assembly                            | Existing `functionInstructionWindowSchema`; unknown complete body extent stays unknown.                                             |
| `xrefs`                        | `axtj`, or r2mcp `xrefs_to`                                             | Exact incoming endpoints; do not infer reference completeness from an unanalysed empty result.                                      |
| `analyze_function`             | Join already parsed procedure, text, instruction and relationship facts | Existing `functionDossierSchema`, explicit facet availability; do not fabricate empty unsupported CFG/type/flow/reference facets.   |
| `resolve_containing_procedure` | Native containment and mapped-segment observations                      | Resolve the provider's actual body, including gaps/overlaps; distinguish outside segments, no function and unknown.                 |
| `list_documents`               | Bound core/program identity                                             | Preserve admitted document selection; a local file digest does not identify an external core by itself.                             |

Opening does not imply `aa`/`aaa`. The profile must state its permitted analysis
policy; function recovery and whole-program discovery have different effects
and costs. Inventory-dependent operations must expose unavailable coverage when
that policy cannot supply their contract. Raw analysis or mutation invalidates
dependent typed facts; until a trustworthy generation exists, read them live.

Owned starts disable decoration with `R2_COLOR=0`, `R2_UTF8=0`, `scr.color=0`
and `scr.utf8=0`. Use native `cfg.json.num=string` for structured reads and a
lossless JSON boundary for unquoted numeric literals. Never send addresses
through JavaScript `Number`. Preserve r2pipe2 status, logs, stderr, raw source,
unknown fields and explicit missing values. HTTP cores retain caller settings;
use scoped settings for selected reads rather than mutating their defaults.

## Small compatibility experiment

`shared-session.verify.mjs` consumes a separately built, explicitly selected
#3521 checkout at `16b98bd1f1205564b66f942b9f21e11e925282e8`. It does not vendor
that PR or register a provider. It compiles the existing fixture without running
the target, performs explicit `aa` once, and tests:

- recovered function instructions pass REA's existing instruction schema and
  `createAnalysisExecution`, then produce authenticated experimental Evidence
  linked to the manager's original command Evidence;
- a retained marker survives separate calls, the caller-selected path is
  preserved, and the artifact hash remains unchanged;
- a cancelled queued command never changes the marker, and subsequent reads
  remain usable; owned cleanup must succeed or retain ownership for retry.

Build each checkout with its pinned toolchain, then run from this checkout:

```sh
REA_R2_SESSION_CHECKOUT=/path/to/built-pr-3521 \
REA_R2_COMMAND=/path/to/radare2 \
node --test experiments/radare2-transports/shared-session.verify.mjs
```

The check fails when the selected checkout, build, compiler or engine is
missing. It prints the source pin, exact imported manager-module digest and
fixture digest; it does not persist ambient environment values. The pin alone
does not authenticate the complete compiled dependency graph. These are direct
manager/contract checks, not a public REA CLI/MCP or production Evidence-ledger
test, and they do not establish all 14 mappings or another carrier's behavior.

Observed on macOS arm64 on 2026-10-15: both checks passed against the selected
native development engine. The imported manager module's SHA-256 was
`082e9c0c7dc441131a8c1fec8a63712dcf1425e8de66db24771285d251eacb88`.
An initial run could not compile REA's ownership helper under the filesystem
sandbox; the approved run outside that sandbox passed. The first contract
attempt also exposed a producer-version mismatch: #3521's pinned base omits
null `relationship_coverage` from Evidence hashing, whereas this checkout
includes it. The experiment authenticates original command records using their
producer's parser, preserves them unchanged with the source revision, and
authenticates newly derived Evidence with this checkout's parser. Production
reuse must rebase onto one shared Evidence implementation; this experiment
does not establish cross-version Evidence portability or a manager defect.
No model run or performance comparison was performed for these two checks;
token, CPU and process-family memory costs are unmeasured.

## Completion criteria after the scope decision

1. Add the provider configuration/availability/profile/client boundary with
   read-only typed admission, explicit analysis/decompiler/transport selection
   and target support refusals. Share #3521's lifecycle implementation.
2. Implement and verify the mappings above, then add composition, config,
   doctor, README/setup guidance and generated catalog ownership changes.
   Preserve BYO tools; no installer upgrades or target execution.
3. Run public CLI and MCP investigations with the actual engine. Cover missing
   plugins, malformed JSON, unsafe integers, negative/ambiguous lookup, identity
   changes, externally mutable cores, cancellation before/after dispatch,
   capacity, process exit and failed cleanup/retry. Verify advertised schemas
   after SDK conversion with the actual client.
4. Repeat equivalent completed-task comparisons through the production shared
   contracts, including whole-task input/cached/output/reasoning tokens,
   elapsed/CPU and process-family peak RSS. Separate cold/warm sessions and
   report unsuccessful attempts and unmeasured costs. Existing experimental
   timings do not establish production adapter performance.

CFG, native type layouts and ESIL/r2ghidra value flow already explored by the
separate prototype extend beyond the current IDA adapter baseline. They should
reuse the shared optional facets after the basic provider is admitted. The
native r2ghidra producer commit `fa28745` exports `is_dead` on operation
`seqnum`; this checkout's experimental reader still needs optional consumption
of that metadata, preserving unknown for older producers. That follow-up is
independent of #3521 and does not gate its merge.
