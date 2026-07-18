# Process Capture v4

Process Capture records one approved command as deterministic Evidence. It is
intended for authority-versus-reconstruction checks where terminal behavior,
child lifetime, filesystem state, or dependency timing matters.

The harness records both raw PTY chunks and terminal states rendered by xterm.
It also records scripted input, resize and signal delivery, sampled process
metadata, named filesystem checkpoints, command-shim invocations, loopback
HTTP/WebSocket exchanges, and process exit ownership. Missing or bounded
observations remain explicit; a truncated capture is never treated as
equivalent to another capture.

Every v4 capture includes a run manifest with canonical SHA-256 commitments for
the secret-safe full scenario projection, comparison contract, executable,
normalization rules, command-shim plan, and replay plan. The manifest also
records the REA/provider versions, platform, architecture, PTY backend, and UTC
start/completion timestamps. Capture creation, Evidence import, and comparison
recompute the self-contained commitments and reject invalid lifecycle data.

## Enable the capability

Process execution is disabled until the operator supplies policy roots and
approves host networking:

```bash
export REA_PROCESS_CAPTURE_ENABLED=true
export REA_PROCESS_EXECUTABLE_ROOTS_JSON='["/usr/bin","/absolute/project/bin"]'
export REA_PROCESS_WORKING_ROOTS_JSON='["/absolute/project"]'
export REA_PROCESS_ALLOWED_ENV_JSON='["PATH"]'
export REA_PROCESS_ALLOW_EXTERNAL_NETWORK=true
```

By default, enabling process capture also installs an administrator-lifetime
grant for the configured boundary. Set
`REA_PROCESS_CAPTURE_AUTO_GRANT=false` to install the same boundary only as an
administrator ceiling. Captures then fail with a structured permission-required
result until a narrower grant is established; this is the prerequisite mode for
connection-scoped MCP elicitation. It does not itself authorize a capture.
Each MCP connection owns its elicited once and session grants. A grant accepted
on one connection is not visible to another connection, and disconnect cleanup
removes only the grants owned by the connection that closed. Reloaded
administrator ceilings and persisted grants still apply immediately to every
live connection.

REA offers the once-or-session grant form only after the connection negotiates
an MCP revision with multi-round tool results and advertises form elicitation.
Older connections keep returning the structured
permission-required result and never wait for an unsupported elicitation
response. The MCP SDK runtime currently pinned by REA negotiates the older
protocol path, so the interactive flow remains fail-closed until its runtime
protocol support is available.

Every scenario must also contain `"approved": true`. Executables, working
directories, filesystem roots, and requested environment variables are checked
against operator policy before launch. Process Capture is an observation tool,
not a security sandbox: the target runs with the current user's permissions.

## Capture a scenario

`rea capture-process` reads a JSON scenario and writes Process Capture v4
Evidence to stdout:

```bash
rea capture-process ./scenario.json > capture.json
```

A representative scenario is:

```json
{
  "approved": true,
  "executable": "/absolute/path/to/node",
  "arguments": ["./signup.mjs"],
  "working_directory": "/absolute/project",
  "filesystem_roots": ["/absolute/project/state"],
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
byte-count placeholder. Environment values listed in `secret_aliases` are also
redacted from recorded text. The command-shim directory is placed first in the
captured process `PATH`; any remaining `PATH` must be explicitly supplied or
inherited under operator policy.

## Checkpoints and deterministic shims

Checkpoint triggers may use an elapsed time, a terminal literal and occurrence
count, root exit, or settlement. REA always includes `before` and
`after_settlement` snapshots. Snapshot effects are relative to the preceding
checkpoint, so transient files remain visible even when the final tree matches
the initial tree.

Each command shim matches an exact argument array. Routes can emit timed stdout
or stderr chunks and then exit or receive `SIGINT`, `SIGTERM`, or `SIGKILL`.
Unmatched and exhausted calls are recorded. Shim observations are bounded by
the scenario protocol-event limit; exceeding it marks the whole capture
truncated while replay continues.

## Compare captures

Compare two saved Evidence records with:

```bash
rea compare-process-captures authority.json reconstruction.json
```

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
