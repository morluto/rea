# Controlled JavaScript replay

`run_controlled_replay` executes only the extracted modules named in the request. It
does not launch or drive the original application. Static inference, passive
browser/Electron observation, isolated replay, and real application behavior
remain different authorities.

## Host prerequisites

Replay requires the current Node.js runtime,
`/usr/bin/bwrap`, `/usr/bin/systemd-run`, `/usr/bin/systemctl`, and
`/usr/bin/bash`. Override executable paths only with the corresponding
`REA_JAVASCRIPT_REPLAY_*_PATH` variable. Configuration creates the
runtime configuration; REA setup never installs these host components. Check
availability with `rea doctor`, which reports exact sandbox-probe failures
without running module code.

## Plan, review, execute

Call the same CLI command or MCP tool twice. The first request uses
`mode: "plan"`. Its response commits module paths and digests, closed dependency
aliases, cases, deterministic providers, runtime/backend identities, resource
limits, no-network policy, private filesystems, and a `plan_digest`.
Runtime commitments include the exact worker, seccomp filter, Node executable,
ELF loader, and shared-library source/destination paths and SHA-256 digests.

The execute request repeats the same manifest and includes the exact digest
returned by the plan request:

```json
{
  "mode": "execute",
  "plan_digest": "<exact digest returned by plan>"
}
```

The execute request directly selects that content-bound operation. There is no
separate REA grant or approval field.

REA rebuilds the plan. Any changed module, stub, case, runtime, backend, limit,
or export commitment returns `plan_stale` before worker admission.

Modules use `esm` or `commonjs-factory`. The latter accepts extracted Rspack
factory syntax such as `123(module, exports, require) { ... }` and implements
the bounded `require.d`, `require.r`, `require.n`, and `require.nmd` helpers.
Every import or require must map to a declared alias. There is no ambient
package resolution.

Explicit cases can be combined with deterministic `parser-boundaries`,
`sanitizer-boundaries`, or `clipboard-boundaries` generation. Supplying a
`right` manifest runs both sides with fresh realms per case and reports
`equal`, `changed`, or `unknown` comparisons.

## Boundary and Evidence

The worker receives module bytes over bounded stdin and runs under a fresh
Bubblewrap user/PID/network/IPC/UTS namespace, an architecture-checked seccomp
filter, an empty mount root with a descriptor-backed read-only Node closure,
private tmpfs, and a transient systemd user cgroup. Host and external network,
host writes, process spawning, workers, native addons, inspector access, and
ambient environment are unavailable. Wall time, memory, swap, tasks, CPU,
case input, worker-protocol input, output, stderr, depth, and node counts are
independently bounded. The parent also requires an exact worker response shape
and authenticates every returned case ID, order, and input digest. Values are
projected through own data descriptors only; Proxy values and accessors are
rejected without invoking their traps or getters.

Returns, exceptions, serialization failures, denials, timeouts, OOMs, crashes,
protocol failures, and cleanup state are observations with provider
`rea-javascript-replay` and authority `controlled-replay`. An observation does
not prove that the original renderer, preload, main process, browser, or remote
service behaved identically.

Each left/right run is retained as its own `observed` source Evidence. A
differential envelope is `derived` and links those source Evidence IDs, so the
comparison never erases the underlying observations.

Optional `reproducer_export` is committed by the plan and writes to its
caller-supplied path after the sandbox has stopped.
The owner-only manifest is written only after complete sandbox cleanup. Source
bytes are excluded unless `include_sources: true` was selected in the request.
An export failure is retained in the result and does not erase a completed
replay observation.

## Local real-artifact verification

`npm run verify:replay` uses source-owned parser and hostile fixtures. An
operator can additionally supply a local ESM or Rspack/CommonJS-factory
manifest without copying module source into the repository:

```sh
REA_REPLAY_INPUT_PATH=/absolute/replay-manifest.json npm run verify:replay
```

The verifier canonicalizes the manifest's module paths and prints only plan,
module, and Evidence digests, case/comparison summaries, and cleanup state.
This is the intended seam for local Notion-like parser/sanitizer benchmarks.
