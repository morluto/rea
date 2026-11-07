# Reconstruction benchmark adapter: exploratory calibration

This is a small, non-production prototype for [#8475](https://github.com/morluto/rea/issues/8475).
It tests the proposed adapter boundary before choosing a benchmark package or scoring policy.
It adds no command, registered tool, provider, target execution, dependency, or release integration.

The issue's open decisions remain open: in-repository versus separate harness, claim versus task
scoring, and whether to contribute or consume external benchmark tasks. This draft does not imply
maintainer approval of any of those decisions. AgentRE-Bench and SRE-Bench compatibility has not
been established.

## What it does

`evaluatePack` accepts explicitly supplied comparison Evidence and claim descriptors, calls the
existing public MCP comparison tool, then calls `verify_reconstruction` in the same session.
It uses the existing input/output contracts rather than inventing another verifier. Only the three
read-only comparison operations are accepted; this adapter cannot dispatch arbitrary tools.

The bundled runner executes three **synthetic calibration cases**, derived from the repository's
existing process-capture contract example:

- Equal complete fixture captures should produce `pass`.
- A changed exit code should produce `fail`.
- An unresolved environment in otherwise equal captures should produce `unknown`.

The inner fixture records use the authority fields required to exercise these contracts. They are
synthetic, not claims that an actual process was captured. No model, agent, real target, external
task pack, or benchmark-quality evaluation runs. The script checks the expected outcomes explicitly;
all-pass is a calibration failure, not success.

## Run

Use the repository's pinned Node/npm toolchain and an already-built runtime. If starting from a
fresh checkout, follow the normal `npm ci` and `npm run build:cached` setup first.

```sh
node --test experiments/reconstruction-benchmark/adapter.test.mjs
node experiments/reconstruction-benchmark/run.mjs > calibration-result.json
```

The runner uses this checkout's runtime and SDK, creates an isolated temporary HOME/XDG directory,
and starts one local stdio MCP server. It does not install or configure a deep provider. It drains
stderr into a bounded raw-byte tail, calls close on the client and transport, and requires the
transport's child-close event before deleting its temporary directory. An unconfirmed close keeps
that directory and marks cleanup incomplete. This observes the MCP child, not a general process-tree
containment guarantee.

The report retains input comparison records, returned comparison and verification Evidence, claim
statuses, limitations, IDs, task-pack digest, server version, and before/after compiled-tree digests.
This allows inspection of the tested local artifact but does not establish that it is a clean build
of a Git commit. Installed dependencies are not fingerprinted by the compiled-tree digest.

Tool/input/transport errors are not failed claims. The adapter stops after a tool error, preserves
completed and partial comparison results, and explicitly lists remaining tasks as unrun. Unknowns
remain unknown; it calculates no success rate. An error, calibration mismatch, changed compiled
runtime, or incomplete cleanup makes the runner exit nonzero.

## Evidence and limits

Local exploration on Linux, Node 24.22.1, used an existing built REA 6.8.0 runtime whose checkout
HEAD was `89317a39fab23df81efa4331311d09d2110377bd`. That checkout contained unrelated JavaScript
analysis edits; this is not a clean-main or current-upstream qualification. The compiled-tree
digest in the output identifies the actual artifact tested. No runtime rebuild or dependency install
was performed for this exploration.

The initial public stdio MCP run returned the expected three statuses. Eleven adapter boundary tests
cover invalid task IDs, disallowed operations, invalid claims, tool errors, malformed success replies,
and preservation of a comparison when verification fails. After the independent read-only review fixes, the same eleven tests and all three public stdio MCP calibration cases passed again; child-close observation and scratch cleanup completed.

Not yet verified: structural-function and structural-artifact task packs, independent scientific
scoring validity, a real agent completing a task, external task-pack formats, real target/provider
behavior, Windows/macOS lifecycle, and repository-wide checks. These are proposal limits, not
passing coverage. A `pass` remains a result for declared finite claims, not global equivalence.

Overflow recovery reads the exact retained Evidence ID once using `get_evidence_bundle` in the same session. It preserves the original execution error even when recovery succeeds. A record that still exceeds the response budget, is missing, or has the wrong operation remains explicitly unavailable; there is no recursive retry or file export. Failed reports retain the complete task and attempted verification request.
