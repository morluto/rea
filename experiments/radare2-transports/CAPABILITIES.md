# Radare2 analyst capabilities experiment

This extends the transport draft with executable analyst operations. It is an
isolated prototype, absent from REA's runtime composition and published package.
Production provider admission, session Evidence and a maintainer scope decision
remain pending. It complements PR #3521 and does not block that PR.

## Exposed capabilities

| Analyst question                                         | Experiment operation                         | Native owner and interpretation                                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which branches and calls exist?                          | `analyze_function`                           | `agfj`: exact block extents, jump/fallthrough/switch edges, instructions, ESIL and references. Shared CFG shape uses exclusive block ends; external edges remain separate.                                                     |
| What parameter and local types exist?                    | `analyze_function`                           | `afsj`/`afvj`: database observations. Automatically inferred signatures can disagree with original C or the selected decompiler.                                                                                               |
| What fields can accesses reveal?                         | `analyze_function` with `recover_types:true` | `aftsj`: native pointer-argument/allocator access-pattern synthesis, including nested inferred structs. Explicitly applies analysis types; does not modify executable bytes. Observed extents are not complete source layouts. |
| What is a named struct layout?                           | `inspect_native_data_type`                   | `tsj`: stored field offsets and complete member widths, mapped through REA's existing `nativeDataTypeSchema`. Origin must be established separately; total alignment, trailing padding and packing stay unknown.               |
| Which values depend on a parameter?                      | `trace_native_values`                        | `pdgx`: actual r2ghidra SSA references, def-use edges, parameters and memory/call effects. Missing dead-state metadata stays unknown.                                                                                          |
| What feeds one register in a short instruction sequence? | `trace_native_values` with `ir:"esil"`       | `aoj` plus native `aegf`: decompiler-free ESIL DFG reduction over explicitly selected straight-line instructions. Conditional arms, backward traversal and warnings remain partial/unknown.                                    |
| How can an agent inspect a smaller result?               | `view_radare2_observation`                   | Retained CFG/instruction/ESIL/p-code pages, original status/logs and raw JSON text pages. No producer rerun. Observations have their own IDs and are not represented as REA Evidence.                                          |

`read_bytes` additionally resolves constants behind native references. It uses
`iSj`/`p8j` and independent selected-file verification. Native padding does not
prove initialized coverage; overlays, ambiguous mappings and external-core
identity remain explicit unknowns. The hexadecimal payload can be paged through
the retained `byte_hex` facet. Its 1 MiB request bound accounts for expansion
under the existing 16 MiB capture budget.

These are named tools with validated inputs. Their experimental output envelope
does not advertise a complete typed output schema. Function queries accept an
exact hexadecimal entry address; struct queries accept an exact identifier.
Union/enum/address type selectors and cross-function argument/return graph
composition are not implemented in this adapter. Those are adapter gaps, not a
claim that radare2 lacks the underlying capabilities.

## Run it

Build REA with the pinned toolchain, then use a target and address you selected:

```sh
node experiments/radare2-transports/analysis.mjs '{"connection":{"transport":"r2pipe","path":"/absolute/program","settings":{"bin.relocs.apply":true}},"operation":"analyze_function","arguments":{"procedure":"0x1000","recover_types":true}}'
```

The explicit MCP server takes a JSON configuration file:

```json
{
  "connection": {
    "transport": "r2pipe",
    "path": "/absolute/program",
    "settings": { "bin.relocs.apply": true }
  }
}
```

```sh
R2_COLOR=0 R2_UTF8=0 node experiments/radare2-transports/analysis-server.mjs /absolute/experiment.json
```

`exec`, `r2pipe` and `r2mcp` use owned batches and close them before returning.
The pipe/MCP carriers reuse one core within a batch, then reopen on the next
tool call; they are not a persistent production provider. `http` instead takes
the exact existing loopback `endpoint` and preserves external ownership. No
external file is reopened or server terminated. Requests are serialized within
the experiment, dispatched once and never automatically replayed.

Optional `prelude` is an explicit array of caller-selected commands. Its effects
and failures are retained. File imports such as `to /absolute/provided-types.h`
require the selected core's file-access authority; r2mcp can refuse them under
its sandbox. An explicitly supplied declaration can instead use a quoted `td`
command without changing those permissions. Neither form establishes that a
type was recovered from the binary.
Load-time settings are applied before opening; use `settings` for relocation
application rather than changing that setting after loading. r2ghidra is the
recommended decompiler and SSA provider; `pdc` and decompiler-free/ESIL-only
reads remain explicit alternatives. `decai` remains available through caller
commands, with its separate model provenance; it is not invoked implicitly.

For a native ESIL slice, use `trace_native_values` arguments
`{"ir":"esil","address":"0xf7c4","instruction_count":5,"register":"x3"}`
on the SQLite build identified below. Its five decoded instructions reduce to
`x23,x3,=`: the caller buffer register feeds the sink argument register. This
selection stops before the indirect call and does not establish the callee's
behavior. It works without r2ghidra. Native conditional ESIL reduction follows
one arm; the prototype reports that partial coverage rather than claiming a
complete path-sensitive dependency graph.

## Coverage and provenance

Target hashes are read before and after owned observations. This establishes
the selected file's unchanged bytes; it is not universal process/core identity
proof. An external HTTP core's selected target remains unverified. The prototype
does not memoize live analysis across calls. Complete observations are retained
under a 64 MiB session budget with explicit release. A retention-capacity failure
returns the completed observation, including native replies, in the error's partial
observation. Paged views preserve the result's own coverage, partial reasons and
target-consistency facts. Each transport capture is
bounded to 16 MiB.

P-code extraction retains at most 3,000 operations, 64 inputs per operation and
12,000 edges per relation, with omission counters. Parameter traces preserve
missing bindings as unknown. Dependencies do not establish alias-sensitive
memory flow, feasible execution paths, call side effects or runtime behavior.
r2ghidra can expand tail callees/stubs beyond the native function's CFG; those
addresses and the scope difference remain explicit. Missing XML `is_dead` is
`null`, not a fabricated boolean in REA's current Ghidra-specific flow schema.

## Real cases and native fixes

The follow-up uses the installed ARM64 SQLite 3.54.0 library, unchanged SHA-256
`cbd373e61913b2990f6e5eb2cf06a9ad7e33b8192948297152dbf1a10bcc0205`:

- `sqlite3_limit` at `0x16474`: database/category guards, lower/upper clamps,
  conditional slot update and previous-value return. Both engines recovered
  11 local blocks and 15 edges during scouting.
- `sqlite3_str_append` at `0x4e24`: buffer/source/length to `memcpy`, the capacity
  guard and enlargement-helper boundary. Release-code observations remain
  distinct from the supplied nonnegative-length API precondition.
- First seven `sqlite3_vfs` fields: explicit caller-provided header prefix for
  r2 versus Ghidra's existing type archive. Compiler-only assertions establish
  offsets 0/4/8/16/24/32/40 and widths 4/4/4/8/8/8/8. Neither is labeled as
  recovery of original source from the binary.

Scouting per-call times are not completed-task measurements. Completed answers,
whole-task model tokens, elapsed/CPU time and sampled process-family memory are
reported in the [capability task comparison](CAPABILITY-BENCHMARK.md), separately
from the [original cold/warm benchmark](BENCHMARK.md). The original partial and
failed attempts remain visible alongside the corrected-profile runs.

Verified producer fixes are committed individually in the user's radare2
checkout; executable and linked-library identity must be recorded for any run,
because its embedded version banner can lag a local rebuild:

The earlier transport/status corrections were already committed as
`bf69061a99` (`Fix command status propagation and r2pipe2 JSON replies ##shell`).
The capability follow-up has eight further commits:

| Commit       | Fix                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `d3576e85c1` | `afsj` explicit-address selection, explicit zero and missing-function failure status.                                             |
| `553fc1632d` | Canonical Darwin type offsets for the selected word size.                                                                         |
| `ae2de41ead` | Aggregate JSON/views/xrefs and member extents use stored offsets, including padding gaps and arrays.                              |
| `a89649caed` | Nested function-pointer member signatures and overlapping union callbacks.                                                        |
| `a52a9e45d7` | Type-import and lookup failures propagate nonzero status; parse-result ownership is shared and failed edits preserve prior types. |
| `231253046d` | Named ESIL function/block access scans use byte extents and release owned block-list references.                                  |
| `28603ffce3` | Sandbox-denied type-file imports report failure without changing sandbox permissions.                                             |
| `575f104005` | Noninteractive input requests report failure in command status and JSON2.                                                         |

The layout fix does not invent aggregate tail alignment metadata. Full SQLite
header import still encounters another unsupported parser construct after the
fixed nested callback; the benchmark's explicit prefix is not a claim that the
entire header imports successfully.

Native validation used root builds and focused gates: 292 type/status cases,
15 ESIL/status cases, 32 sandbox/type/status cases, and 31 input/help/status
cases passed at their respective fixes. These overlapping gates are not a full
native test-suite result. The final prototype verifier passed 13 transport and
analyst checks, including real exec/pipe/MCP/HTTP workflows, plus 24 separate
parser/boundary checks.

The separate [r2mcp JSON2 logging PR #84](https://github.com/radareorg/radare2-mcp/pull/84)
lets native JSON2 retain structured diagnostics while keeping one stderr copy.
The benchmark selects its production change at `4019246f4e`; the upstream PR
also has a test-only compatibility adjustment for older native status behavior.

These measurements use the listed development commits. Stable users need builds
containing the corresponding fixes to reproduce the corrected native behavior;
the prototype does not impose a new production compatibility floor. It uses
neither the TypeScript nor Python r2pipe library. An r2mcp logging correction
preserves whatever status its native r2 reports and is independent of upgrading
that status producer.
