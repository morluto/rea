# Process capture

Process Capture records one caller-selected command as Evidence. It is
intended for authority-versus-reconstruction checks where terminal behavior,
child lifetime, filesystem state, or dependency timing matters.

The harness records both raw PTY chunks and terminal states rendered by xterm.
It also records scripted input, resize and signal delivery, sampled process
metadata, named filesystem checkpoints, command-shim invocations, loopback
HTTP/WebSocket exchanges, and process exit ownership. Missing or bounded
observations remain explicit; a truncated capture is never treated as
equivalent to another capture.

Every capture includes a run manifest with canonical SHA-256 commitments for
the caller-selected scenario projection, comparison contract, executable,
normalization rules, command-shim plan, and replay plan. The manifest also
records the REA/provider versions, platform, architecture, PTY backend, and UTC
start/completion timestamps. Capture creation, Evidence import, and comparison
recompute the self-contained commitments and reject invalid lifecycle data.

## Request and host behavior

The scenario names the command and arguments, with optional working-directory,
environment overrides, and filesystem observation paths. An omitted working
directory uses the invocation's current directory. The process inherits the
host environment, then applies any declared overrides. Filesystem observation
paths select what REA records; they do not constrain what the child process can
read or write. Process Capture is not a security sandbox: the target runs with
the current user's permissions.

Local output, arguments, environment overrides, URL query values, shim results,
and replay bodies are preserved without credential-name or text-pattern
redaction. Inputs explicitly marked `sensitive` use placeholders in Evidence.
The inherited environment is not copied into the manifest; its unrecorded
influence remains an explicit limitation.

## Capture a scenario

`rea capture-process` reads a JSON scenario and writes process capture
Evidence to stdout:

```bash
rea capture-process ./scenario.json > capture.json
```

A representative scenario is:

```json
{
  "executable": "node",
  "arguments": ["./signup.mjs"],
  "filesystem_observation_paths": ["./state"],
  "terminal": { "columns": 80, "rows": 24, "scrollback": 1000 },
  "events": [
    {
      "type": "input",
      "at_ms": 250,
      "data": "user@example.test\r",
      "sensitive": true
    },
    { "type": "resize", "at_ms": 500, "columns": 100, "rows": 30 }
  ],
  "checkpoints": [
    {
      "name": "signup_ready",
      "trigger": { "type": "terminal_literal", "value": "All set!" }
    },
    { "name": "root_exited", "trigger": { "type": "root_exit" } }
  ],
  "command_shims": [
    {
      "name": "codex",
      "routes": [
        {
          "arguments": ["--version"],
          "outputs": [
            { "at_ms": 0, "stream": "stdout", "data": "codex 1.2.3\n" }
          ],
          "termination": { "type": "exit", "code": 0 },
          "max_calls": 1
        }
      ]
    }
  ]
}
```

Input events marked `sensitive` are dispatched to the PTY but stored only as a
byte-count placeholder. The command-shim directory is placed first in the
captured process `PATH`; command lookup otherwise uses the inherited or
scenario-overridden `PATH`.

Scenario arguments, environment names, timed interactions, shim routes and
output chunks, filesystem checkpoints, and static HTTP/WebSocket scripts are
accepted without fixed item-count ceilings. The run still obeys its timeout
and the configured output-byte, process, filesystem, protocol-event, body-byte,
and connection budgets; each filesystem checkpoint uses those same
bounded snapshot limits.

## Reactive process scenarios

Set `reactive` to a process reactive scenario declaration when interaction
must follow observed output instead of guessed delays. The graph declares an
initial state, absolute scenario and state deadlines, explicitly prioritized
transitions, caller-chosen use and visit counts, trigger predicates, ordered
actions, and either a next state or `passed` outcome.

The admitted runtime slice matches decoded UTF-8 terminal literals and exact
`terminal_raw`, `interaction`, `process`, `filesystem`, `http`, `websocket`, or
`shim` journal events. Process events are sampled observations, not an
event-complete lifecycle. Filesystem events identify named checkpoints; shim
events identify a command and route. Live predicates receive the same normalized
and redacted payload later persisted in Evidence. Predicates may compose with
`all`, `any`, `sequence`, and `repeat` nodes and may select a frontier at
scenario start, state entry, a prior checkpoint, or an exact event ID. Actions
can write PTY input, resize it, signal the root process, or capture a named
filesystem checkpoint. `terminal_rendered`, `lifecycle`, and `replay_transition`
event triggers and non-root signal selectors fail during preflight before the
target launches.

Reactive results are recorded in `reactive_run`, including the terminal outcome,
active state, matched event IDs, action evidence IDs, and deterministic
transition journal. The reducer retains and evaluates every admitted
observation through the scenario deadline; it has no fixed state, transition,
predicate, action, repeat, or history-count ceilings. Recursive input depth has
a stack safety guard. Terminal controls also commit the last admitted
observation order, so later output cannot be moved ahead of a timeout,
cancellation, or target loss during validation. If the process exits before the graph finishes,
the outcome is `target_lost`; state/scenario deadlines remain distinct
`predicate_timeout`/`scenario_deadline` outcomes. Timed `events` remain
available for fixed schedules, but they are not silently translated into the
reactive graph.

## Checkpoints and deterministic shims

Checkpoint triggers may use an elapsed time, a terminal literal and occurrence
count, root exit, or settlement. REA always includes `before` and
`after_settlement` snapshots. Snapshot effects are relative to the preceding
checkpoint, so transient files remain visible even when the final tree matches
the initial tree.

Each command shim matches an exact argument array. Routes can emit timed stdout
or stderr chunks and then exit or receive `SIGINT`, `SIGTERM`, or `SIGKILL`.
Unmatched and exhausted calls are recorded. Shim observations are included in
the capture without a separate fixed count ceiling. Other configured
observation and byte budgets remain explicit in the capture result when they
affect completeness.

## Run a replay machine directly

Use `rea run-replay-machine ./run.json` to validate a finite replay machine
against an ordered `events` array without launching a process or opening a
socket. MCP clients use `run_replay_machine` with the same `{ machine, events }`
input. The result retains one decision per offered event, a transition journal
with capture alias metadata, and one redacted action-table entry per used
transition. It never returns request bodies, request headers, or captured
values. It also reports the initial and final states, whether the final state is
terminal, configured limits, and committed usage.

The direct evaluator has no fixed state, transition, event, guard, capture,
action, or action-byte count ceiling. It indexes transitions by protocol and
path, evaluates events in order, and returns a decision for each offered event
plus actions for used transitions. Caller-declared `max_uses`, `max_visits`,
`max_transitions`, and protocol budgets determine the finite run; there is no
upper schema cap on those values. Result size follows the input and is not
truncated by an arbitrary item quota.

Refused events remain data rather than aborting the run. Outcomes distinguish
unmatched events, invalid states, failed guards, exhausted transitions, invalid
captures, unexpected reconnects, and exhausted limits. This direct runner
evaluates the same domain runtime used by loopback Process Capture, but performs
no network or target execution.

## Compare captures

Compare two saved Evidence records with:

```bash
rea compare-process-captures authority.json reconstruction.json
```

Pass an optional third path, `rea compare-process-captures authority.json
reconstruction.json trace.json`, when valid executions may differ in declared
concurrent ordering. MCP callers pass the same object as `trace_spec` to
`compare_process_captures`. A trace specification declares exact named events
and chooses one language:

- `partial_order` requires every event pair to be related by a
  `happens_before` edge (including transitive edges) or an explicit
  `unordered_groups` declaration. `not_before` expresses negative ordering
  constraints without inferring causality. Optional `prefix` and `suffix`
  arrays remain exact.
- `finite_traces` lists the complete accepted variants. An `unordered` token
  accepts permutations of exactly its declared event multiset; it does not
  drop or broadly sort events.

Each event uses one source family (`terminal_raw`, `terminal_rendered`,
`interaction`, `lifecycle`, `process`, `filesystem`, `http`, `websocket`,
`shim`, or `replay_transition`), an exact JSON payload, and a discriminated
cardinality: `required`, `optional`, `exact`, or `range`. Specifications with
duplicate or overlapping predicates, unknown references, cycles, implicit
ordering gaps, ordered/unordered conflicts, or finite variants that violate
cardinality are rejected before comparison.

Event payloads are exact by default. To compare schedules whose recorder
metadata necessarily changes, an event may explicitly list top-level
`ignore_fields` from the bounded set `sequence`, `at_ms`, `scheduled_at_ms`,
`dispatched_at_ms`, and `elapsed_ms`; its `exact` object must omit those fields.
All predicates for one source use the same ignore set, so relaxed metadata
cannot create declaration-order matching ambiguity. Other payload fields are
never dropped or normalized by trace comparison.

Process Capture records a monotonic `event_journal` at observation time. Trace
comparison uses only this capture order for cross-source causality; timestamps
are retained as event data but never promoted into happens-before evidence.
Older captures without a complete journal, truncated captures, and relevant
residual unknowns return a trace verdict of `unknown`. A passing result retains
each side's raw journal locations and identifies either the matched finite
variant or the complete satisfied constraint set. A failure returns the first
declaration-ordered predicate, cardinality, edge, prefix, suffix, or language
violation with its relevant event locations.
If both captures have the same invalid declared trace, the nested verdict is
`nonconforming` while the top-level capture comparison remains unchanged. Side
statuses and the diagnostic distinguish conformance from pairwise difference.

The result classifies terminal, interaction, exit, filesystem, protocol,
process, and shim behavior. `first_divergence` points to the earliest observed
difference. Residual unknowns prevent a claim of complete equivalence, but they
do not hide an observed difference in another dimension.

Captures must have equal comparison-contract commitments, but may identify
different scenarios and executables. MCP callers may set `max_capture_age_ms`;
the application clock then rejects stale captures before comparison.

## Limits and lifecycle behavior

Scenarios bound output bytes, frames, files, file bytes, process observations,
protocol/shim events, connections, filesystem depth, total runtime, idle time,
and settlement time. Process trees are sampled rather than syscall-traced, and
short-lived descendants may be missed. Filesystem observations are snapshots,
not filesystem event streams.

REA tags launched processes with a private run identifier. During cleanup it
revalidates that identifier before signaling sampled process groups, including
groups detached from the original parent. Temporary HOME, replay, shim,
terminal, checkpoint, and sampling resources are released on success, failure,
timeout, and cancellation.

After root exit, REA checks token-owned process groups every 50 ms. Two
consecutive empty observations establish `quiesced`; the settlement deadline
otherwise produces `alive_at_deadline`, while inspection or identity failures
produce `unverifiable`. Sampling can still miss short-lived or early-detached
descendants, which remains a residual unknown.
