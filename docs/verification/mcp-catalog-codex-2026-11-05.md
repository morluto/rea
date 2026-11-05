# Codex MCP catalog observations, 2026-11-05

The supported Codex host path showed no material input-token increase for an
empty response with REA enabled. Completing a real package question still used
hundreds of thousands of cumulative input tokens across discovery and
continuations. Neither raw advertisement bytes nor an empty response measures
that whole-task cost.

REA source baseline: `ec3410998b70290847f930538e57d0af0ac1bffb`. Loading driver:
`5038280f9`; completed-task/default-smoke driver: `61a364210`. The
[machine-readable receipts](mcp-catalog-codex-2026-11-05.json) retain exact usage,
source/runtime hashes, response counts, resource counters, answers, and invalid
profiles. Full local transcripts remain under the recorded `raw_artifact_root`;
they are not committed. See the [evaluation procedure](../mcp-catalog-evaluation.md)
to reproduce with a built source checkout.

Linux x64; Node 24.22.1/npm 11.16.0; Codex CLI 0.165.0; requested model
`gpt-6.1-sol`, reasoning `low`. The resolved backend model version is unknown.
Each guarded trial used a fresh client/server/profile, one CPU, 4 GiB hard memory,
3 GiB early stop, no swap, and at most 192 tasks. OS/API prefix caches could be
warm. Reported input includes cached input. All valid payloads exited normally
and verified cleanup; no resource stops or OOM events were observed.

## Advertisement and empty-response costs

The built default catalog contains 234 tools and 4,029,995 JSON bytes, including
3,681,386 output-schema JSON bytes, 138,747 input-schema bytes, and 148,355
description bytes. This is server advertisement size, not submitted model input.
Production `mcp doctor` independently observed all 234 tools and six prompts,
matched catalog identity, and completed `binary_session` successfully.

Three repetitions per profile, with alternating order; default compact input
schemas and default full output schemas. The client-selected profile exposes
only `binary_session` after discovering the same server catalog.

| Host-enabled profile | Valid samples | Paired input delta, median (range) | Median guarded wall s | Median family CPU s | Median family peak MiB |
| -------------------- | ------------: | ---------------------------------: | --------------------: | ------------------: | ---------------------: |
| No MCP               |             3 |                            control |                14.693 |               1.965 |                  187.9 |
| All tools            |             3 |                       +3 (0 to +3) |                13.490 |               2.685 |                  347.2 |
| Selected tool        |             3 |                      +3 (-3 to +3) |                13.792 |               2.573 |                  336.1 |

Every valid response returned exactly `CATALOG_OK` without tool calls. Input was
11,112–11,121 tokens, including 9,216 cached input tokens, with eight output
tokens. Random workspace paths and client framing remain in the comparison.
These small differences do not establish a schema-only token count. Network
waits dominate elapsed time; no stable latency improvement is established.
The local CPU/memory increase when enabling MCP remains measurable in this setup.
Family peaks are kernel cgroup counters including observer/file cache at payload
exit, rather than final whole-scope counters.

Nine additional host-disabled diagnostic samples emitted:

> Code Mode is unavailable because code-mode host is disabled.

The client also reported that tool dispatch would fail closed. It still returned
the requested marker, illustrating why that marker alone is insufficient.
All nine profiles are **invalid**; their paired deltas remain unknown. This
diagnostic matrix exits nonzero intentionally. It does not establish an eager
or native-dispatch comparison. The final command defaults to the working host
profile; a separate three-cell default smoke run passed.

## Completed real-package pilot

Both arms answered the same question from the installed public `semver@7.8.5`
package, analyzing only `package.json`: declared name `semver`, version `7.8.5`,
and entry `index.js`. Those three fields were checked against the source JSON
independently of REA. Answers cited Evidence references emitted by the actual
tools and stated that dependency modules were unexamined and runtime behavior
was not observed. Both runs retained the same analysis parent Evidence identity.

The selected arm allowed `analyze_javascript_application` and
`inspect_analysis_view`; the other allowed the whole catalog. Both used the
working host, the identical question/instructions, and unchanged target bytes.

| Tool selection | Whole-turn input (cached subset) | Output | Model responses / MCP calls | Guarded wall / family CPU s | Family peak MiB |
| -------------- | -------------------------------: | -----: | --------------------------: | --------------------------: | --------------: |
| All            |                271,084 (228,224) |    699 |                       8 / 3 |              48.952 / 6.532 |           671.7 |
| Selected       |                160,438 (138,496) |    637 |                       7 / 3 |              42.928 / 5.728 |           582.1 |

The first model input was 11,349 tokens in both cases. The subsequent
`exec`/`ALL_TOOLS` discovery, schema reads, replies and context replay account for
the later cumulative input. Per-response input counts sum exactly to the reported
whole-turn input; they must not be added to it again. Counting only the three MCP
calls would miss several model responses.

This is one task per arm. The model chose different follow-up tools and
projections. The numbers demonstrate a completed-task measurement method; they
do not isolate a causal catalog reduction or establish a general advantage for
filtered tools, complex applications, or other clients/providers.

## Verification and exclusions

The new runner separates execution workspaces from artifact output, holds the
shared artifact lock, and checks runtime fingerprints again at completion. Its
named usage parser preserves missing counts as unknown and rejects failed client
profiles, wrong answers, unexpected actions, runtime drift and unverified cleanup.

Exploratory cohorts remain recorded separately: repository-nested workspaces
inherited project instructions/skills; a concurrent artifact rebuild interrupted
two MCP handshakes; and old `code_mode`/`code_mode_only` switches did not establish
distinct dispatch modes. Those cohorts do not support the tables above. The
sibling JavaScript-facts harness already explicitly enables the required host.

Dependency acquisition/build costs, complete dependency-tree byte identity,
remote inference CPU/memory, exact submitted request bodies and independent
billing reconciliation are unmeasured. No REA production contracts, Evidence
semantics, or catalog defaults changed in this work.
