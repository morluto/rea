# Measure MCP catalog costs in Codex

Use actual harness usage to evaluate catalog changes. A `tools/list` JSON byte
count measures transport size. It does not establish how many tokens a client
submits to a model, whether it defers schemas, or the total cost of an analysis.

## Run a controlled loading comparison

Build the selected source checkout with the pinned Node and npm versions first:

```sh
npm ci
npm run build:cached
npm run eval:mcp-catalog -- --model gpt-6.1-sol \
  --output "$HOME/.cache/rea-catalog-run" --repetitions 3 --plan
```

Remove `--plan` to execute the matrix. This makes real model requests using the
local Codex authentication. The output directory must not already exist. No
account configuration is changed. The runner copies only authentication into
an external disposable profile and removes that profile after each trial.
Execution stays outside both source checkouts even when results are saved inside
one, so ancestor repository instructions and skills do not pollute the trial.
The npm entrypoint holds the repository's artifact lock throughout the matrix;
do not rebuild the selected runtime concurrently through an unguarded command.
Each trial checks the complete runtime fingerprint again at completion. A changed
or unreadable runtime invalidates the trial while preserving its observations.

This lane requires Linux, Python 3, a working user systemd manager with cgroup v2,
and an installed Codex CLI supporting the recorded flags. It reuses the existing
resource observer: one CPU, 4 GiB hard memory limit, 3 GiB early stop, no swap,
and a 192-task ceiling. Runs are sequential. Unsupported clients, resource stops,
failed startup, missing usage, and unverified cleanup remain failed measurements.
They do not become zero-cost successes.

Each repetition compares no server, all REA tools, and a client-selected subset
(`binary_session` by default), in both direct and client-code modes. Alternate
repetitions reverse ordering. All variants receive the same developer instructions
and exact-response prompt. A valid loading trial completes one turn, returns
`CATALOG_OK`, and performs no tool calls. REA is marked `required` in every
server-enabled configuration. Client-code flags are experimental; the requested
flags and CLI version are retained. Direct mode does not promise eager schema
loading: discovery behavior still belongs to the client.

Useful controls:

```sh
# Compare full input guidance with the default compact input presentation.
npm run eval:mcp-catalog -- --model gpt-6.1-sol \
  --output "$HOME/.cache/rea-catalog-full" --input-profile full --repetitions 3

# Choose exact tool names and one client mode.
npm run eval:mcp-catalog -- --model gpt-6.1-sol \
  --output "$HOME/.cache/rea-catalog-selected" --modes direct \
  --selected-tools analyze_javascript_application inspect_analysis_view
```

`enabled_tools` filters the catalog after client discovery. It does not reduce
the server's original `tools/list` transport. Server tool-family scope is a
separate existing control; do not attribute client filtering results to it.
The output-schema profile remains REA's default in these experiments.

## Read the evidence

`report.json` retains every attempted trial and compares each enabled-server
trial with its same-mode, same-repetition no-server control. It reports valid
pair counts and the median/range of observed input-token differences. Failed
pairs are explicit and excluded from the median. A small or negative delta can
reflect client framing, randomized workspace paths, and measurement variation;
it does not establish a negative schema cost.

Each trial retains its exact prompt, runtime file digests, requested model alias,
Codex version, settings/source hashes, JSONL events, actual usage, answer, cleanup
receipt, and process-family resource receipt. The selected rollout capture keeps
per-response usage and tool exchanges; authentication, ambient environment,
account metadata, and encrypted reasoning are excluded. Tool output and local
paths remain evidence and should be reviewed before sharing the raw files.

The metrics have distinct meanings:

| Metric                              | Meaning and limit                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Catalog bytes and SHA-256           | Built server advertisement, including output schemas; not model input.                                          |
| `turn.completed.usage.input_tokens` | Observed whole-turn usage reported by Codex; includes cached input.                                             |
| Cached/uncached input               | Report both. Cache hits do not remove tokens from the context.                                                  |
| Per-response usage                  | Retained usage records help locate discovery and continuation costs. Do not add cumulative thread counts again. |
| Paired input delta                  | Incremental loading observation including instructions/client framing; not an exact schema-only token count.    |
| Elapsed and family CPU              | Whole guarded trial, including local setup and client/network waits; remote inference CPU is unmeasured.        |
| Family peak memory                  | Kernel cgroup peak at payload exit, including observer and file cache; not final whole-scope counters.          |

These are fresh client/server sessions. OS caches and API prefix caches can
already be warm. No cold-cache claim follows from a new session. The requested
model alias is recorded; a resolved server-side model version is not inferred.
The harness usage is not an independent billing reconciliation.

## Evaluate completed investigations too

A no-tool response can avoid deferred discovery entirely. Before changing the
catalog based on this lane, compare completed tasks through the real harness.
Use `npm run verify:agent` and its known-answer rubric, or run a selected real
artifact through `tests/support/analysis-efficiency/agent-trial.py` under
`resource-run.py --observe-payload-exit`. Use the same task, artifact digest,
model/reasoning, authority, result coverage, and correctness oracle in every arm.
The existing runner accepts exact `--enabled-tools` and direct/client-code modes.
Use `--capture-tool-context` to locate per-response costs. Its task summary
explicitly leaves factual correctness unassessed until an independent oracle or
transcript review establishes the requested facts.

Count discovery, arguments, replies, retries, and continuations. Check the
requested facts against source bytes or another independent oracle, real produced
Evidence IDs and source links, partial/unknown coverage, and cleanup. Preserve
failed attempts. A successful small-package task is a pilot, not proof of broad
application performance or provider compatibility.
