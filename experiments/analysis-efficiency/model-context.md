# Observe the client boundary before claiming token savings

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the managed
summary [PR #2413](https://github.com/morluto/rea/pull/2413) merged as
`82cfcee19f18b0eeae9a330ba04e0411cdf85225`. That opt-in view has verified smaller
delivery and complete-default migration, while its original real-model cohort
does not establish token savings. This follow-up measures why raw reply bytes
and aggregate model usage cannot be treated as interchangeable observations.

## Concrete diagnostic observation

An individual real Codex CLI 0.161.0 control uses frozen runtime
`ae8051302b5834322fa00cfa31c968ae74ab6ed9`, the unchanged ShareX identity question,
requested `gpt-5.6-terra` high and the same two enabled REA tools. A private
diagnostic copy removes the original runner's explicit `--ephemeral` flag.
Authentication/profile cleanup still runs; only selected tool/usage items are
retained after filtering the owned rollout. Its source rollout SHA-256 is
`d4df41d6187880d177f00b7533d85ad032c9c4ec502a39e7d5a566180e10461b` and the retained
filtered-item SHA-256 is
`0d5b4fb67c5674d1ba14ac32ae37e9a72b0368f4d9f5f9f81eb4d13193cda260`.
The original whole-copy is removed; account metadata, world state, messages and
internal passthrough are not retained in the filtered receipt.

Despite the requested `direct` configuration label, the observed client uses
three JavaScript `exec` calls. First it filters `ALL_TOOLS` with a broad
`/REA|reverse|artifact|managed|assembly|metadata/i` expression and prints matching
metadata. The client reports truncation of a 164,005-token original output.
This is the client's output measurement, not billed input or a complete inventory.
Next it invokes complete managed inspection but selects requested normalized
identity/classification fields before printing. Finally it invokes native-boundary
inspection and prints selected fields. The actual original complete MCP replies
remain available in the separate public-event transcript.

The persisted custom-tool output values are 41,704 / 2,154 / 13,489 UTF-8 bytes.
These are the serialized recorded output **values**, not raw wire bytes or exact
submitted model requests. The trace reports four per-response usage observations:

| Response |  Input | Cached input | Output |
| -------- | -----: | -----------: | -----: |
| 1        | 10,400 |            0 |    132 |
| 2        | 19,992 |        9,984 |    456 |
| 3        | 21,242 |       19,200 |    251 |
| 4        | 24,799 |       20,224 |  1,535 |

Their totals match public turn usage: 76,433 input, 49,408 cached, 27,025 uncached
and 2,374 output, with 61.436 seconds observed wall time. Two MCP calls alone do
not describe the client's discovery/execution rounds. This proves the observed
control can project a complete result before printing it; it does not establish
that every earlier control/candidate did the same, or attribute every token
difference to discovery. The earlier `direct` label specifies requested client
configuration, not a verified absence of an executor.

Initial transcript-capture attempts retained empty source lists because the
original runner intentionally passed `--ephemeral`. A first private flag-removal
edit missed its newline and failed; that candidate remains an unsuccessful
capture attempt. The later corrected control is an individual diagnostic,
not a comparable pair with that candidate. Other exploratory aggregates remain
private and are not silently folded into the original four-trial cohort.

## Reproducible optional capture

`agent-trial.py --capture-tool-context` omits `--ephemeral` only for that explicitly
selected temporary trial. Its default is unchanged. The profile still disappears
in `finally`, including when capture fails. The capture reads only its owned
`sessions/*.jsonl` records, rejects symlink sources, and retains:

- Custom/function tool calls and replies, preserving call IDs and exact values.
- Per-response token counts and cumulative counts, with original response IDs.
- Client token-count events, retaining explicit unknown `info: null`.

It excludes session/account metadata, world state, user/developer messages,
encrypted reasoning, internal passthrough and unknown nested usage fields. It
does not copy authentication, configuration or the ambient environment. Receipts
record source/retained digests, event counts, malformed-line failures and missing
rollouts as unavailable. Capture is an observation of persisted client items,
not proof of the exact request accepted by a remote model service.

Run the same frozen runtime, question, tool selection and capture mode on both
sides. Preserve source/settings hashes and separate requested versus observed
behavior. Use the existing resource wrapper with unchanged one CPU, 4 GiB hard
memory, 3 GiB early-stop, no swap and task/host safeguards. Final physical counters
remain unknown when transient cgroups disappear; this instrumentation does not
repair that measurement limitation.

The focused Python tests run through the existing CI `test:python` gate.
They cover account/ambient exclusion while preserving caller data, malformed and
missing records, foreign symlinks, and capture failure without copied-credential
leakage. The cleanup test simulates a CLI and establishes only cleanup semantics;
it is not real-model/provider evidence.

## An explicit discovery-guidance experiment

`--guide-enabled-tools` is another opt-in experiment flag. It requires a nonempty
`--enabled-tools` list and adds the exact corresponding `mcp__rea__...` function
names to the temporary developer instructions, requesting only exact-name
metadata discovery. It preserves the analyst question, operation order, tool
selection and provider inputs. The default instruction is unchanged. Missing or
invalid selected tools fail before creating an output/profile. The test gate
also verifies the new prerequisite without acquiring a profile.

Compare guided and unguided runs on the **same** frozen REA runtime with matching
capture mode and requested facts. A smaller discovery response or additional
hint is not itself a task/token success: grade answers, count all response usage,
preserve failed/truncated runs and repeat both orders before recommending this
guidance. This is a caller-side experiment, not a new REA tool or provider preset.

## First committed capture pair

Checkpoint `9ebdcc458c399b9bdecaaca2ef47422888231181` runs the unchanged question
against frozen control `ae8051302b5834322fa00cfa31c968ae74ab6ed9` and candidate
`8bc1601ca51e417ca472d90ea0367e9418a1a0f2`, both with capture enabled and no tool
guidance. Both captures succeed with 10 retained events, unchanged source bytes,
removed profiles, two successful MCP calls and passing selected factual checks.
Full grader gates remain false because final physical resource counters are
unavailable; factual subsets do not override that limitation.

| Side              |  Input | Cached | Uncached | Output | Wall seconds |
| ----------------- | -----: | -----: | -------: | -----: | -----------: |
| Complete control  | 52,656 | 27,136 |   25,520 |  2,015 |       57.736 |
| Summary candidate | 56,655 | 29,184 |   27,471 |  1,534 |       55.055 |

Both clients make two executor calls and three response-usage observations.
First they print broad discovered metadata, with truncation. Then each executor
sequentially performs both MCP operations, preserving selected-target dependency
order. The control prints a 2,086-byte output value; the candidate prints 22,770
bytes. Their discovery output values are 41,723 and 41,675 bytes. These are
recorded serialized values and remain distinct from raw MCP envelopes, billed
tokens and exact submitted requests. Both requested modes are `direct`; the
actual executor use is separately observed.

The candidate's smaller raw metadata reply does not result in a smaller printed
client value in this pair. Candidate input/uncached tokens remain higher. The
observed projection and round counts are useful constraints for the next
experiment; this one pair does not attribute all usage differences to either
formatting or discovery, or establish a reliable speedup.

## Same-runtime guided discovery, repeated in both orders

Checkpoint `e20bd0e2a905f06bc8c56fe04b0e61f3da88636a` runs four actual Codex trials
in unguided/guided/guided/unguided order. All use the **same** frozen candidate
runtime, artifact, original question, requested model/reasoning, two selected
tools, provider settings and capture mode. Only the explicit discovery-guidance
treatment changes. Every trial selects artifact summary and makes the same two
successful MCP calls in dependency order; source bytes stay unchanged, captures
succeed and profiles are removed.

| Trial      |   Input | Cached | Uncached | Output | Seconds | Observed responses |
| ---------- | ------: | -----: | -------: | -----: | ------: | -----------------: |
| Unguided 1 |  77,251 | 50,432 |   26,819 |  1,931 |  62.066 |                  4 |
| Guided 1   |  39,175 | 23,040 |   16,135 |  1,763 |  55.658 |                  3 |
| Guided 2   |  58,336 | 38,144 |   20,192 |  1,626 |  50.685 |                  4 |
| Unguided 2 | 103,301 | 72,704 |   30,597 |  1,983 |  60.336 |                  5 |

Both guided discovery output values repeat at 12,336 bytes without truncation,
versus 41,709 bytes with truncation on both unguided trials. The recorded
executor/output usage explains observable discovery and round differences; it
does not certify exact remote request contents or attribute every token to the
hint. CPU samples are 6.303–6.554 seconds and peak family memory 684,519,424–
712,028,160 bytes, with no guard abort. Final resource counters remain unknown.
These samples do not establish a memory or CPU improvement.

Unguided 1 omits `classification.container` and fails the selected factual gate;
it is not a fully acceptable comparison answer. Guided 1 and Unguided 2 pass
that gate. Guided 2 initially fails exact coverage-object equality because it
adds `module_ref_count: 0` and `pinvoke_import_count: 0` to the explicitly named
native scope. Both numbers exactly match the producer's returned arrays. The
grader now explicitly verifies only these two known additional counts, including
integer type, while still requiring all original coverage facts. Unknown extra
claims, conflicting aliases, wrong counts, boolean/string counts and omitted
issues continue to fail. Source coverage remains unchanged; returned-row counts
do not establish global absence. Original failure receipts remain preserved;
the regrade separately records its new source hash. Guided 2 then passes selected
facts, but every **full** gate still fails unknown final physical resource checks.

The second comparison has two factually acceptable answers: observed guided input
falls about 43.5%, uncached input about 34.0%, and wall time about 16.0%. The first
comparison has an incomplete unguided answer and is reported without counting it
as equivalent completed work. Two trials per treatment on one question/application
remain a preliminary signal, not a general default recommendation. The hint stays
opt-in; wider questions/domains, count/coverage representation and client round
behavior need further verification before promoting it into general guidance.

## Real Android follow-up: the primary outcomes are mixed

Checkpoint `22834c7d73056e2480b426848f58c31af0c307bc` checks the pinned real
NewPipe 0.29.1 APK using actual configured JADX 0.7.1/Java, the original Android
question and the same frozen candidate runtime. First a fresh SDK workflow
validates three live advertised operations and produces the comparison facts:
package/version identity, every case-sensitive MainActivity match and all
reported onCreate entries, preserving signatures, overload indices and null DEX
descriptors. It takes 26.961 seconds; the owned scope samples 1,234,735,104 bytes.

Both subsequent actual Codex trials use the same three selected tool names,
capture mode, model/reasoning, question and provider settings. Only discovery
guidance changes. Each makes three successful MCP calls and five observed model
responses, passes selected facts against the fresh actual producer, preserves
source bytes and removes its temporary profile. No APK execution is requested.

| Trial    |  Input | Cached | Uncached | Output | Wall seconds | Sampled peak bytes |
| -------- | -----: | -----: | -------: | -----: | -----------: | -----------------: |
| Unguided | 99,913 | 80,640 |   19,273 |  1,527 |       66.797 |      1,405,829,120 |
| Guided   | 89,220 | 62,464 |   26,756 |  2,142 |       76.936 |      1,345,576,960 |

Total input falls about 10.7%, but uncached input increases and wall time is
longer. One pair does not demonstrate improved Android performance or memory.
No guard abort occurs; final counters remain unknown and full resource gates
remain false. This second domain is a concrete counterexample to generalizing
the favorable managed comparison. Keep both flags optional and continue
task-specific experiments before changing installed/default agent guidance.
