# Radare2 transport proposal

Status: draft proposal and isolated experiment. Radare2 is not registered in
REA's runtime, setup, doctor or tool catalog by this change. Integration requires
the maintainer scope decision described in [Contributing](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#fail-closed-integration).
Related work: [feature request #2711](https://github.com/morluto/rea/issues/2711)
and [provider PR #3521](https://github.com/morluto/rea/pull/3521). Coordinate the
owned command/session work with that PR instead of shipping two implementations.
This is complementary follow-up work: #3521 does not depend on this proposal,
HTTP attachment, typed r2mcp mapping, or the separate upstream fixes. The review
feedback on #3521 is informational and does not request waiting for this PR.

## Analyst question and proposed boundary

An analyst should be able to inspect and decompile a selected local binary with
their installed radare2, or continue analysis in their existing local r2 session,
without installing Hopper or a Java-based analysis provider. Rizin's command
adapter does not establish compatibility with radare2's protocols or plugins.

Preserve the provider PR's proposed one-shot and session operations. Extend the
session target with an explicit transport selection; do not add four duplicate
analysis tool families. These names describe the proposed contract, not currently
available REA commands:

| Operation                 | Intended input                                                        | Result                                                                                         |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `execute_radare2_command` | Local path, caller-selected r2pipe2 request                           | Inline command Evidence and owned cleanup outcome                                              |
| `start_radare2_session`   | Discriminated owned-path, existing HTTP endpoint, or r2mcp connection | Session identity, transport, observed capabilities, ownership and launch/connection provenance |
| `radare2_command`         | Session ID and `{cmd,json?,trim?}`                                    | Requested result inline, native status/logs, raw response Evidence and coverage                |
| `radare2_session_status`  | Session ID                                                            | Fresh lifecycle observation, retained cleanup and target-identity uncertainty                  |
| `close_radare2_session`   | Session ID                                                            | Release REA's connection; stop only resources it owns                                          |

The domain owns these contracts, the radare2 adapter owns r2pipe2 parsing and
transport state, and the application owns Evidence, session admission and
retention. CLI and MCP use that shared workflow. Transport-specific protocol
objects stay in the adapter. Preserve caller-selected executable, path, endpoint,
command, analysis settings, output format and decompiler; never select an
operation by catalog position or command-name suffix.

For provider-neutral analysis, reuse r2mcp's named tools through a thin adapter
to REA's existing operations instead of creating another typed radare2 API.
The command/session operations above serve the separate unrestricted-command
use case. Typed r2mcp calls do not require enabling `run_command`.

## Transport choices

| Transport         | Use and effects                                                                                                                 | Ownership and performance                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Command execution | One owned `r2 -N -q -e scr.color=0 -e scr.utf8=0 -c REQUEST ABSOLUTE_PATH` process; plugins remain available                    | Independent invocation; useful for a single question, with repeated loading/analysis for independent requests      |
| r2pipe2           | Owned `r2 -N -q -e scr.color=0 -e scr.utf8=0 -0 ABSOLUTE_PATH`; JSON requests and NUL-framed JSON replies                       | Reuse the same analysis state; serialize commands, bound frames and preserve cleanup ownership                     |
| r2pipe over HTTP  | POST an r2pipe2 JSON request as the body to the exact caller-selected loopback `/cmd` or `/cmd/` endpoint                       | Reuse a caller-owned r2/iaito session; never reopen its file, terminate the server or send `q` on disconnect       |
| r2mcp             | Discover and bind named advertised tools on a caller-selected local connection; raw access needs upstream `run_command` support | Retain the upstream MCP session/catalog; preserve its permission settings, tool errors, paging and server identity |

The prototype exercises owned r2mcp stdio with `-r -N`, where `-r` deliberately
enables raw commands and `-N` disables prompts. These flags differ from radare2's:
r2mcp `-n` also disables plugins, including decompilers. A production connection
must preserve caller-selected upstream arguments and must report unavailable
raw access rather than silently change permissions. r2mcp's own MCP HTTP mode
is a distinct protocol from r2's `/cmd` HTTP endpoint; it remains unverified here.

For a caller-started server, the upstream equivalents are:

```sh
# Start r2's webserver without opening a browser; the selected r2 owns its state.
r2 -N -q -e http.bind=127.0.0.1 -c '=h 9090' ./program

# Submit once. --data-binary preserves the JSON request body exactly.
curl --data-binary '{"cmd":"aflj","json":true}' http://127.0.0.1:9090/cmd/
```

These are upstream commands, not new REA entrypoints. The prototype pins
`localhost` to loopback, preserves the original endpoint separately, refuses
userinfo/remote endpoints and does not follow redirects or retry submissions.
Optional transport authorization is supplied separately and is not recorded.
The installed r2 6.2.5 emits LF-only HTTP response headers. The experiment uses
Node's HTTP compatibility parser for this explicit loopback peer, retaining raw
header values; it does not repair response bytes with string replacements.

iaito already exposes this attachment path: its **Start Web Server** action
starts `=h&` on the existing core. POST the r2pipe2 request to `/cmd` or `/cmd/`
to use that session's loaded file and analysis. A separate iaito GUI automation
bridge is unnecessary for command access. REA must treat the session as
externally owned and live; releasing its connection must not close the file or
server. The prototype accepts loopback endpoints, including a caller-established
local tunnel; it does not currently admit arbitrary remote hosts.

## Reusing typed r2mcp calls

The installed r2mcp 1.8.8 advertises named tools including `list_functions`,
`list_strings`, `decompile_function`, `disassemble_function`, `xrefs_to`,
`show_info`, and decompiler selection. Its `-u URL` HTTP-client mode can route
supported named tools to an existing r2/iaito `/cmd` endpoint. Its core plugin
can instead expose MCP on the existing `RCore`. These paths avoid duplicating
r2 command construction in REA. Discover the actual catalog because the exposed
tools differ between local, HTTP-client, restricted and plugin configurations.

The adapter still owns conversion into REA's function identities, address
strings, relationship coverage, tagged errors and Evidence. Typed inputs do
not imply structured result facts: a local run returned function-list lines,
and `-C structured` returned pseudocode as a `structuredContent.content` string.
The inspected catalog advertises input schemas without per-tool output schemas.
Prefer upstream structured-result improvements where facts are missing rather
than duplicating fragile text interpretation across REA consumers.

Preserve analysis policy as well as tool arguments. The inspected
`list_functions` implementation runs `aaa` when its initial inventory is empty;
it is not an observation-only operation in that state. Decompiler choice and
mutation readback also need explicit semantics. The transport probe only uses
`open_file` and `run_command`. The separate
[task benchmark](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/BENCHMARK.md) exercises direct
upstream named tools. Mapping them into REA, `-u`, core-plugin MCP and their
REA CLI/MCP parity remain unimplemented and unverified here.

## r2pipe2 results and failure ownership

Use [r2pipe2](https://github.com/radareorg/radare2-book/blob/master/src/scripting/r2pipe2.md)
for every carrier, including HTTP POST bodies and r2mcp `run_command`. Retain
`res`, `error`, `code`, `value`, `logs` and unknown envelope fields alongside the
original response. Parse once at the adapter boundary. Explicit `json:true`
requests native JSON; text commands use `json:false`. Never rerun a command to
change its output mode after a parse failure.

`cfg.json.num=string` is supported. Native JSON addresses and the r2pipe2 `value`
can arrive as exact decimal strings; retain those strings and never convert
64-bit values through JavaScript `Number`. For a provider-selected JSON read,
`{"cmd":"aflj @e:cfg.json.num=string","json":true}` scopes the encoding to the
command instead of changing a caller-owned session's global setting. Preserve
caller-selected output choices on the unrestricted-command surface.

The setting does not rewrite arbitrary printed JSON: `?e 9007199254740993`
still emits an unquoted number. The experiment therefore also uses the existing
`lossless-json` dependency at native and MCP decoding boundaries. Unsafe numeric
literals become exact strings with JSON Pointer, original spelling and
`producer_type: "json-number"` in separate `numeric_literals` metadata. Native
strings remain strings without that annotation; safe numbers remain numbers.
Raw replies remain available. This addresses numeric correctness without making
an encoding mode a prerequisite for caller-selected commands.

Keep process stderr separate from per-command r2pipe2 logs. A session-wide stderr
observation cannot prove which command caused every byte. Retain byte counts,
truncation, decoding loss, partial frames, startup diagnostics and cleanup
failures. Invalid JSON must preserve its original frame and uncertainty.

Observed on the original local engine: an invalid subcommand returned
`error:false`, `code:0` and an `ERROR` log; `json:true` on non-JSON output emitted
malformed JSON. These are producer defects, not reasons for REA to erase logs,
silently retry, or infer success from a single flag. Corrections are developed in
the separate radare2 checkout. REA must still preserve results from older engines.

The r2mcp raw-command implementation executes the command before applying
pagination. A subsequent cursor call can execute it again. Preserve the full
upstream tool result and paging metadata; do not follow pages by replaying an
arbitrary command. The experiment requests the advertised 10,000-item/line page
maximum when supported and does not promise completeness beyond that page.

## Decompiler choice

Recommend [r2ghidra](https://github.com/radareorg/r2ghidra) for native local
decompilation. It embeds Ghidra's C++ decompiler and does not require the full
Ghidra application or Java. Plugins and tools remain bring-your-own; this proposal
does not install software or change user configuration.

| Explicit choice | Upstream use                                                                  | Interpretation                                                                                                              |
| --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| r2ghidra        | Analyze the selected function, then `pdg @ main`; `pdgj` supplies plugin JSON | Engine-derived pseudocode; preserve warnings and unavailable-plugin failures                                                |
| pdc             | `pdc @ main`, with the session's `cmd.pdc` selection preserved                | Built-in pseudocode backend when selected; quality and structuring differ from r2ghidra                                     |
| decai           | Caller-configured `decai -d`                                                  | Model-generated interpretation; retain selected model/provider and source evidence, without presenting it as an observation |

r2mcp supports explicit decompiler selection, for example `r2mcp -r -N -d pdg`,
and advertises `list_decompilers` / `use_decompiler`. Preserve the actual selected
backend instead of switching on failure. `cmd.pdc` can redirect `pdc`; a command
name alone does not prove which decompiler ran. See the
[decai guide](https://github.com/radareorg/r2ai/blob/master/decai/README.md) for its
local model configuration. Never select a cloud endpoint, transmit target
content, install a model or invoke decai implicitly. A loopback transport does
not constrain what caller-selected commands or plugins can do.

## Proposed defaults informed by the task runs

These are recommendations for the pending integration, not new runtime defaults.
The [measured tasks](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/BENCHMARK.md) support
reducing unnecessary analysis and agent calls. They do not establish a universal
engine or transport ranking. Explicit provider, transport, commands, decompiler
and analysis choices always take precedence.

| Decision                     | Proposed policy                                                                                                                                                                     | Evidence and limits                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Selected r2 decompiler       | Recommend installed r2ghidra / `pdg`; use assembly directly when it answers the question. Keep pdc/decai explicit.                                                                  | All r2 task lanes used r2ghidra successfully; pdc/decai were not comparatively benchmarked. The raw SQLite agents needed no decompilation.                                                                                                                                                 |
| Initial analysis             | Opening an owned core does not imply `aa` or `aaa`. Read known instructions/bytes first; request function-scoped analysis when needed, and basic `aa` for discovery when justified. | The raw SQLite agents answered from short instruction/literal reads; the typed agent chose `aa` and analysed 2,765 functions. `analyze(level:0)` means `aa`, not no analysis. Empty basic-analysis xrefs do not prove references absent.                                                   |
| Existing connection          | Reuse the caller-selected session and its validated analysis; preserve external ownership and disclose unresolved target identity/freshness.                                        | Reuse avoids discarding useful work. HTTP/iaito performance and live freshness were not benchmarked; do not discover or attach to endpoints automatically.                                                                                                                                 |
| New bounded command question | Prefer a one-shot batch of the required reads when no selected session exists.                                                                                                      | One-shot used fewer total tokens than the retained REA lane in all three agent tasks and finished those tasks sooner in this cohort. This is workflow guidance, not an automatic rewrite of caller commands.                                                                               |
| New continuing investigation | Prefer an owned retained r2pipe2 core, reused across related reads.                                                                                                                 | Fixed SQLite repeats took a median 15.80 ms through retained REA versus 13.45 s with one-shot reload/analysis. Those fixed reads still needed a version-string dereference; agent task completion is a separate measure.                                                                   |
| r2mcp use                    | Reuse an explicitly selected upstream connection and its named tools for shared analysis; keep raw r2pipe2 access available only when enabled by the caller.                        | Typed discovery solved the task without raw access, with 20 calls / 189,830 tokens versus raw's 8 calls / 217,772 tokens. Neither interface wins every cost metric. Direct upstream results do not measure a future REA adapter.                                                           |
| Other analysis providers     | Preserve the selected provider and expose r2's CFG, type and value-flow facts through the same analyst questions.                                                                   | The original three tasks did not compare these capabilities. The [capability follow-up](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/CAPABILITIES.md) adds executable experiment tools and real SQLite cases; production admission and Evidence remain pending. |
| Display and metadata         | Owned defaults remain `scr.color=0`, `scr.utf8=0`. Preserve debug information and caller output choices.                                                                            | Clean display is already implemented and checked; token savings were not isolated. The benchmark's `asm.dwarf=false` prevented source-line shortcuts and is not a general recommendation to discard useful source/debug evidence.                                                          |

The [capability task runs](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/CAPABILITY-BENCHMARK.md)
add one concrete requirement: expose focused byte reads beside references.
All four original limit answers left a requested value unresolved; enabling
byte reads resolved it in every corrected-profile run. Keep native status and
structured diagnostics intact when an import is denied. Explicitly provided
inline types can answer that question without granting file access, with their
caller-supplied origin preserved. Those profile changes improve answer coverage;
they do not establish a universal fastest carrier or decompiler default.

Named tools must honour the same analysis policy. Upstream `list_functions` can
currently run `aaa` on an empty inventory; expose that effect or report that a
requested inventory-only read is unavailable. Do not silently enable raw access
to work around it. When discovery needs references, request the relevant
analysis coverage and report its limits rather than treating an empty xref list
as absence or dumping every function body.

The application workflow should minimise agent round trips while preserving
explicit target admission and cleanup. Reuse `procedure_assembly` and
`procedure_pseudo_code` for focused reads, or `analyze_function` when several
facets are actually needed. Its existing input is `{procedure}`; do not invent
an unsupported `detail` parameter. For already retained function Evidence,
`inspect_analysis_view` supplies native facets without repeating analysis.
Close owned resources when the investigation is complete, after pending
follow-ups; the typed SQLite run closed and reopened before its final lookup.

For the proposed r2 mapping, those existing inputs should return the existing
Evidence envelope and requested normalised facts: procedure/address identity,
assembly or pseudocode, addressed string values and the available relationship
coverage. The radare2 adapter owns protocol/analysis policy, and the application
owns retention and Evidence views. Unsupported facets remain explicit unknowns.
Where typed r2mcp returns only text, prefer upstream structured, address-bearing
results before duplicating parsers in REA. A pointer-returning function needs
the referenced value to answer a string question; returning only its pseudocode
does not establish completion. Batch homogeneous reads within the existing
workflow where useful, preserving item outcomes and serial execution per core.

Use compact inline facts with the necessary provenance and limitations, retaining
complete source Evidence for requested detail. Reuse successful observations
instead of repeating identical calls solely for confidence; the Ghidra branch
trial repeated two complete dossiers. A cache hit saves computation but still
returns context to the model. Do not prune the advertised catalog, hide missing
coverage or return only an Evidence ID to achieve a smaller response. The
benchmark's common instructions did not load REA's packaged skill; evaluate the
recommended workflow with that skill before attributing agent choices to
production defaults.

Do not memoise arbitrary raw commands by default. Reusable typed facts need
target identity, provider/decompiler profile, requested scope and analysis
generation in their key; unknown completion or mutation retires that generation.
Externally changed iaito state cannot be reported as fresh without a validated
change signal. Read retained output pages from REA's Evidence, never by replaying
an unrestricted upstream command. Keep the existing lossless decoder and scoped
`cfg.json.num=string` handling; do not change global encoding on an external core.

Evaluate candidate defaults with completed-task A/B runs, equivalent Evidence
and correctness coverage, counterbalanced order and multiple trials. Include
known-address reads, stripped discovery, repeated function questions and a
post-mutation freshness case. Report total and uncached/cached tokens, calls,
time, CPU and sampled family RSS. For example, SQLite used fewer total tokens
with one-shot REA than retained REA, but more uncached input (24,087 versus
16,741). Total tokens alone do not establish billing cost. Profile REA's startup,
schema and Evidence work before attributing the direct-r2mcp gap to the pipe
implementation or changing bindings. Improvement from the combined policy
remains unmeasured.

## Authority, Evidence and integration decision

The [concrete IDA-parity scope](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/IDA-PARITY.md)
maps all 14 existing shared operations, defines reuse of #3521's session owner,
and lists the required production verification. Its small session/contract
compatibility check remains isolated; no runtime provider is registered.

The proposed raw-command surface is unrestricted. It can execute scripts and
shell commands, launch/attach targets, mutate files/memory/configuration and
contact services, including through plugins. The maintainer decision must cover
those effects and the final transport defaults. Existing Rizin authority does not
approve this provider. No dedicated debugging, injection, protection recovery,
evasion or bypass workflow is proposed.

For owned static workflows, preserve the caller path, resolved launch path,
executable and artifact digests before/after, without claiming these prove the
exact bytes consumed. For external sessions, launch path and caller-supplied file
names do not prove the current target. Record observed engine facts separately;
keep unresolved identity unknown. Shared external commands need the existing
external-mutation admission/analysis retirement boundary. Existing Ghidra
analysis must be closed explicitly first.

The experiment returns protocol observations, **not REA Evidence**. It deliberately
reports target identity as unverified. Production Evidence creation, persistence,
authentication redaction, session admission, resource accounting and CLI/MCP
schema validation remain integration work after approval.

## Verification and performance decision

Local verification on macOS arm64 used Node 24.18.0/npm 11.16.0, r2mcp 1.8.8,
and radare2 6.2.5 development commit `679075d13e` with local r2pipe2 producer
fixes applied. The original eight explicit transport checks passed with installed
r2ghidra. REA's `build:cached`, `check`, `docs:check` and `verify:test-discovery`
also passed. The TypeScript client's separate URL-encoding regression and fix
are tracked in [upstream PR #187](https://github.com/radareorg/radare2-r2pipe/pull/187).
The Python async client's separate `quit()` lifecycle correction is tracked in
[upstream PR #188](https://github.com/radareorg/radare2-r2pipe/pull/188).
The TypeScript client's shutdown correction from
[upstream PR #196](https://github.com/radareorg/radare2-r2pipe/pull/196) is published
in [r2pipe-ts 0.4.0](https://www.npmjs.com/package/r2pipe-ts/v/0.4.0): `quit()`
waits for child closure, escalates to SIGKILL after the grace period, and retains
the child for retry when shutdown cannot be confirmed. The published tarball's
SHA-512 matched npm's integrity metadata. Two separate package smoke checks passed
on macOS arm64 with Node 24.18.0: normal radare2 shutdown and SIGKILL escalation
for a synthetic child that ignores SIGINT and stdin EOF. REA's experiment uses
its own r2pipe2 adapter and does not depend on `r2pipe-ts`; an upstream client
release does not change this branch's runtime or its recorded measurements.

The [isolated experiment](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/README.md) compiles a
disposable source fixture and exercises actual local r2/r2mcp processes and a
loopback r2 webserver. Its verifier requires installed r2ghidra and also checks
pdc output, native JSON, logged command errors, malformed native JSON, HTTP
command-byte preservation, cancellation, redirects and owned cleanup. It never
runs the fixture executable or invokes a model.

Prefer a retained r2pipe2 session for multiple related questions; use an existing
HTTP/r2mcp session when the caller already has useful analysis. Run only the
requested analysis once, preserve its settings and generation, and invalidate
after mutations or unresolved command completion. Do not add a global cache
keyed only by file path. Scope selection and retained full Evidence should avoid
returning raw output plus duplicate JSON/summary copies to the agent.

The transport verifier's durations do not establish performance improvements.
The separate [task comparison](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/BENCHMARK.md)
measures actual Codex investigations and fixed cold/warm MCP queries through
PR #3521, direct upstream r2mcp and Ghidra 12.1.4. It records model tokens,
elapsed time, local CPU and sampled process-family RSS with finite correctness
oracles and explicit measurement limits. Direct r2mcp bypasses REA's Evidence
and catalog work; these results do not isolate transport overhead or select a
production default. HTTP/iaito performance, Linux, Windows, older radare2,
r2mcp MCP-over-HTTP, broad decompiler quality, live-target detach and production
failure/limit semantics remain unverified.

## Implementation review

The [capability follow-up](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/CAPABILITIES.md)
supersedes the earlier experiment's missing CFG/type/flow surface. Its explicit
CLI and separate MCP entrypoint now expose recovered CFG and instructions,
database struct layouts, native access-pattern type synthesis, ESIL lifts and
r2ghidra SSA dependencies, plus independently verified byte reads. The
[SQLite capability comparison](https://github.com/morluto/rea/blob/main/experiments/radare2-transports/CAPABILITY-BENCHMARK.md)
records exact answers and partial coverage, whole-task tokens and resources
before and after correcting the byte-read/type-import profile. This demonstrates
r2 capabilities without registering a runtime provider. Ghidra's p-code contract currently requires metadata absent
from r2ghidra XML (`is_dead`), so the prototype preserves that unknown rather
than inventing compatibility. Native ESIL and Ghidra-derived p-code remain
distinct representations.

This review examined the prototype at `67eee62fa3`, the existing provider
adapters in this checkout, and the separate command/session PR #3521 at
`16b98bd1f1`. These are REA integration comparisons, not rankings of the engines.

| Integration             | Implemented surface                                                                                                                                       | Material limits                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This radare2 experiment | Four r2pipe2 carriers plus explicit analyst tools for CFG, signatures, struct layouts, inferred types, ESIL and r2ghidra value dependencies               | No runtime provider registration or production Evidence; owned batches reopen between tool calls; HTTP core identity remains unverified; interprocedural binding is pending         |
| Radare2 PR #3521        | One-shot commands, persistent owned pipe sessions, command Evidence, doctor and real-provider verification lane                                           | Separate command/session family rather than an `AnalysisProvider` registered for shared native operations; no HTTP/iaito or r2mcp connection in the inspected diff                  |
| Ghidra                  | Shared inventories, decompilation, instruction reads, typed references, CFG, bounded p-code value flow, types, byte reads/search and metadata annotations | Ephemeral headless Program, waits for default auto-analysis, no attached GUI; cancellation discards the database; Windows P0 excludes mutation                                      |
| IDA                     | Shared inventories, pseudocode, assembly, xrefs and partial dossiers through upstream MCP; attached and headless profiles                                 | Read-only; no complete body ranges, typed references, referenced data or basic blocks; direct callers unavailable in modern/native profiles; live results are not snapshot-replayed |
| Hopper                  | Shared analysis/dossiers, byte reads, file mappings, GUI position/navigation and names/comments/bookmarks through its bridge                              | Depends on completed GUI analysis; masked byte search is explicitly unavailable; string inventory and reference metadata have documented limits                                     |

Two prototype defects were reproduced during review:

1. **High priority: unsafe JSON integers silently change.** Sending
   `{"cmd":"?e 9007199254740993","json":true}` through the real owned r2pipe
   transport retained native `res:9007199254740993` but emitted parsed
   `res:9007199254740992`. `JSON.parse` at the common reply boundary loses
   precision before finite-number validation. The follow-up fixes the decoder
   using lossless numeric literals and accepts `cfg.json.num=string` envelopes.
   Nine real transport checks now pass, including exact numeric decoding over
   exec/pipe/MCP and native string mode over pipe/MCP/HTTP. The installed r2 was
   6.2.5 development with the producer corrections now committed as `bf69061a99`;
   these checks still used the installed r2mcp 1.8.8.
2. **Medium priority, unresolved: expected failures lose their category.** An already-aborted
   HTTP request, before any dispatch, projected as `unreadable_output` with
   completion `unknown`. The outer catch wraps cancellation and other expected
   failures in `AnalysisOutputError`. Preserve tagged cancellation, deadline,
   capability, input and capacity failures while retaining partial observations;
   distinguish a request never submitted from unknown completion after dispatch.

Further integration limits are source-derived: owned pipe/MCP state survives
only within one `probe()` batch, while exec starts a new process per command;
raw and parsed replies are duplicated in the transcript; decompiler selection
has no retained provider profile; and external GUI changes have no identity or
freshness checks. Arbitrary commands are available, but their results cannot yet
feed REA's shared function dossiers or value/call tracing as typed provider facts.

The review ran the two defect reproductions against the prototype and a local
r2mcp named-tool workflow covering file open, analysis, function inventory,
r2ghidra decompilation, xrefs and close. An initial DSL invocation passed numeric
arguments as strings and was rejected; the successful run used default analysis
and inventory options. iaito attachment was confirmed from its webserver source,
not by operating a running GUI. IDA and Hopper comparisons remain source-derived.
The separate benchmark runs real Ghidra and r2 engines on its declared tasks;
it does not establish the other integration capabilities in the table.

The separate upstream r2mcp review reproduced signed JSON integers becoming
unsigned during pagination (`-1` became `18446744073709551615`).
[Upstream PR #83](https://github.com/radareorg/radare2-mcp/pull/83) preserves the
parsed sign without converting the integer through a double. Its real MCP
regression passes across four content modes; the HTTP response test also passes.
The full upstream suite stops at a macOS `sym.*` versus `dbg.*` fixture-name
assertion that also reproduces with the unchanged installed r2mcp.
That correction is independent of this decoder and #3521, which does
not use r2mcp. Structured output expansion, typed-tool mapping and other r2mcp
enhancements remain follow-up work, rather than prerequisites for #3521.

The next implementation should reuse r2mcp for named analysis calls, retain direct
r2pipe2/raw HTTP access, and attach to iaito through its existing server. Add
shared provider registration, Evidence and lifecycle semantics around those
boundaries. Measure equivalent completed tasks before choosing transport defaults
or claiming an engine, token, latency, CPU or memory advantage.
