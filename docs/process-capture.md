# Process capture

Process Capture runs one caller-selected command and records bounded evidence
about its terminal behavior, scheduled interactions, process lifetime, and
selected filesystem state. Use it to compare two direct runs of the same
scenario, such as an authority build and a reconstruction. It does not replay a
previous execution or emulate dependencies.

The command runs with the current user's permissions and inherits the host
environment before applying the scenario's explicit overrides. This is not a
sandbox. Filesystem observation paths select what REA snapshots; they do not
restrict what the process can read or write. The inherited environment is not
recorded, so its influence may remain unknown.

## Host support

Capturing a new scenario currently requires Linux or macOS and a working
native PTY backend. Native Windows capture is unavailable because the PTY
adapter does not yet verify descendant cleanup. The native Job Object controls
used by other REA providers do not establish PTY capture support. Reinstalling
the Windows PTY binary does not enable this workflow.

For Linux commands, use Linux REA inside WSL. Adapt the scenario to that host;
this does not establish capture of a native Windows process tree. Comparing
existing capture Evidence through the CLI or MCP remains available on Windows
and does not launch a PTY or the captured target.

On supported capture hosts, a missing or incompatible native PTY binary has a
different recovery: reinstall REA for the active platform, architecture, and
Node.js version with optional dependencies enabled. Capability diagnostics
distinguish this from the Windows capture-adapter limitation.

macOS also requires Apple's Swift compiler through `xcrun` for process
ownership inspection. REA compiles its packaged, narrow process-inspection
helper into a private temporary directory before a capture or owned provider
process starts; the same prerequisite applies to owned provider-process
supervision on macOS. REA removes that directory when it exits. REA does not
install Xcode, Command Line Tools, or other software. Capability checks prepare
this helper before reporting macOS capture as available.

## Capture a command

Write a JSON scenario and pass its path to the CLI:

```sh
rea capture-process ./scenario.json --json > capture.json
```

`--json` is required when saving input for JSON consumers; the default terminal
format is TOON. The file contains the complete capture Evidence record.
Choose an output file distinct from the scenario input: shell redirection opens
and truncates the output before REA reads the scenario.

For example:

```json
{
  "executable": "node",
  "arguments": ["./signup.mjs"],
  "working_directory": ".",
  "environment": { "APP_MODE": "test" },
  "filesystem_observation_paths": ["./state"],
  "terminal": { "columns": 80, "rows": 24, "scrollback": 1000 },
  "events": [
    {
      "type": "input",
      "at_ms": 250,
      "data": "user@example.test\r",
      "sensitive": true
    },
    { "type": "resize", "at_ms": 500, "columns": 100, "rows": 30 },
    { "type": "signal", "at_ms": 1000, "signal": "SIGINT" }
  ],
  "timeout_ms": 30000,
  "idle_timeout_ms": 30000,
  "settle_ms": 100
}
```

`executable` is required. `arguments`, `working_directory`, `environment`,
`filesystem_observation_paths`, terminal settings, timed `events`, timeouts,
resource limits, and normalization settings have defaults; see
`processScenarioSchema` for the exact contract. Event times are milliseconds
from launch, must be ordered, and must fall within `timeout_ms`. Inputs marked
`sensitive` are sent to the process but persisted as a byte-count placeholder.
Environment overrides are recorded in the scenario commitment; inherited
values are not copied into Evidence.

The capture contains raw PTY output chunks and rendered terminal states,
interaction dispatch outcomes, exit reason, sampled process-tree observations,
and settlement status. When filesystem paths are selected, REA records
`files_before` and `files_after`, then classifies observed entries as created,
deleted, modified, or unchanged. These are bounded snapshots, not a syscall
trace; short-lived changes between snapshots may be missed. With no selected
paths, filesystem effects remain unknown.

A missing entry proves creation or deletion only when the corresponding
observation root's path enumeration was exhausted. Otherwise its effect has
`status: "unknown"`, the available before/after state, and a reason; a null
state in this variant means unobserved. Paths below symlinks that REA did not
follow also remain unknown. Partial enumeration of one root does not erase
known effects in another, and unavailable content hashes do not by themselves
make path absence unknown.

Terminal frame `data` is the comparison text after the selected normalization.
New captures also preserve `raw_data` when normalization changes a PTY chunk;
otherwise `data` is already the original text. Older captures may lack the
original text for changed chunks. Both values participate in Evidence identity,
while comparisons and trace assertions use the normalized text. Retaining the
original adds at most `limits.output_bytes` of text, because it comes from the
same admitted PTY chunks rather than a second unbounded stream.

Port normalization recognizes explicit `port`, `tcp_port`, `udp_port`, and
`listen` fields, URL authorities, IP endpoints, and `localhost` endpoints, with
ports from 0 through 65535. A port may end a sentence, as in `port: 8080.`;
a period followed by a letter or digit continues a decimal, version, or host
name instead. Each PTY chunk is normalized on its own, so a port whose period
ends the chunk is left unchanged because its continuation is not yet known. It preserves ordinary counters, dimensions, file line numbers,
and ambiguous bare host labels. Use explicit literal `patterns`
for a different application-specific spelling. Set `ports: false` to preserve
all endpoint numbers in comparison text. Captures commit the port-normalization
version so older broad numeric normalization cannot silently compare as the
same contract.

Output retention, file count, aggregate file-hashing bytes, process sampling, filesystem depth, total
runtime, idle time, and post-exit settlement are bounded by the scenario's
limits. The result marks truncated observations and residual unknowns rather
than treating missing data as proof of equivalence. Cancellation and timeout
run the same owned-process cleanup path. Settlement reports whether the
sampled process group quiesced or whether cleanup was needed or unverifiable;
sampling cannot prove that every short-lived or detached descendant was seen.

Every capture requires `truncation_details`, with separate accounting for:

- `raw_terminal`: original UTF-8 PTY chunk bytes and observed/retained chunk
  counts. A chunk that does not fit `limits.output_bytes` is omitted whole;
  a later smaller chunk can still fit.
- `rendered_terminal`: cumulative UTF-8 serialized-state and visible-line
  bytes, plus observed/retained frame counts. This is independent of the raw
  chunk budget and does not count JSON encoding. Repeated screen snapshots can
  exhaust it even when all raw output fits. Rendered states use retained PTY
  input, so raw omissions also limit rendered coverage.
- `filesystem_before` and `filesystem_after`: file-count/depth limits,
  enumeration failures, whole-file hash budget and bytes successfully hashed.
  Each retained regular file without a digest has an aliased path, size,
  remaining budget and reason: `file_bytes_budget`,
  `file_changed_or_short_read`, or `file_unavailable`. Its `system_code` is
  null unless an OS file operation failed, in which case it preserves the
  reported error code. A file too large for the remaining budget is
  skipped; a later smaller file can still be hashed. Hash omissions do not
  imply incomplete path enumeration.
- `process`: sampling limit and whether sampling ended partially. Coverage
  remains `sampled`, including when that limit was not exhausted.

The aggregate `truncated` flag summarizes these observations. Comparisons retain
results for unaffected dimensions and mark affected dimensions unknown; an
incomplete capture cannot locate the first divergence across all dimensions.
Trace assertions use coverage for the sources they select, so an assertion
about complete raw terminal output need not fail because rendered snapshots
were omitted. Older truncated captures without these details retain the
conservative comparison behavior. These diagnostics use the existing scenario
budgets; they do not introduce a separate file-hashing budget.

When the host withholds an unrelated process’s ownership token, REA leaves that
process untouched and records its PID and reason in `cleanup.unverified_processes`
and process residual unknowns. Successful cleanup verifies the owned group;
it does not attribute those unrelated processes. Related or otherwise unexplained
unreadable processes still prevent successful cleanup.

On macOS, changing a Node process's `process.title` can make its run token
unreadable. Node documents that [setting the title overwrites argv memory](https://nodejs.org/download/release/v24.18.0/docs/api/process.html#processtitle).
With the pinned toolchain, a live child retained a readable start identity
while its token became unavailable after this change; npm changes its title
as well. A newly started unreadable process can prevent verified cleanup even
after the selected command exits. REA preserves this uncertainty and leaves
that process untouched.

## Compare two captures

Compare saved capture Evidence with:

```sh
rea compare-process-captures authority.json reconstruction.json
```

The comparison checks terminal, interaction, exit, filesystem, and
process observations under a shared comparison contract. It reports observed
differences with their locations, while residual unknowns or truncated
observations prevent a complete-equivalence claim. Matching scenario
commitments do not reveal whether redacted sensitive inputs were equal.

For scenarios where independent scheduling can change event order, the CLI
also accepts an optional trace-specification JSON file as the third argument.
That specification must state the exact events and ordering constraints to
accept; it does not discard unmatched observations or make timestamps into
causal evidence. Trace comparison returns `unknown` when a capture lacks the
required complete event journal or contains relevant residual unknowns.

Each capture carries commitments for the selected scenario, executable,
comparison contract, and normalization rules. The comparison contract covers
the working directory, explicit environment, filesystem observation paths,
terminal size, scripted events, timeouts, limits, and normalization; the
executable and its arguments may differ. Comparison rejects captures whose
comparison contracts differ and names the differing fields, so run both
scenarios from the same absolute working directory and observation paths.
Captures are local Evidence files; keep
their source artifacts and invocation context available when interpreting a
difference.
