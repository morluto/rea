# Controlled JavaScript replay

`run_controlled_replay` executes only operator-selected extracted modules. It
does not launch or drive the original application. Static inference, passive
browser/Electron observation, isolated replay, and real application behavior
remain different authorities.

## Enable the ceiling

Replay is disabled by default. Configure exact source roots before REA starts:

```sh
export REA_JAVASCRIPT_REPLAY_ENABLED=true
export REA_JAVASCRIPT_REPLAY_ROOTS_JSON='["/absolute/extracted/modules"]'
```

The default trusted executables are the current Node.js runtime,
`/usr/bin/bwrap`, `/usr/bin/systemd-run`, `/usr/bin/systemctl`, and
`/usr/bin/bash`. Override them only with the corresponding
`REA_JAVASCRIPT_REPLAY_*_PATH` variable. Configuration creates the
administrator ceiling; it does not replace per-call approval. `rea doctor`
reports disabled, available, and exact sandbox-probe failures without running
module code. REA setup never installs these host components.

## Plan, review, execute

Call the same CLI command or MCP tool twice. The first request uses
`mode: "plan"`. Its response commits module paths and digests, closed dependency
aliases, cases, deterministic providers, runtime/backend identities, resource
limits, no-network policy, private filesystems, and a `plan_digest`.
Runtime commitments include the exact worker, seccomp filter, Node executable,
ELF loader, and shared-library source/destination paths and SHA-256 digests.

The execute request must repeat the same manifest and include:

```json
{
  "mode": "execute",
  "approved": true,
  "plan_digest": "<exact digest returned by plan>"
}
```

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

Optional `reproducer_export` is committed by the plan and requires both
`approved: true` inside that object and separate `evidence_write` authority.
The owner-only manifest is written only after complete sandbox cleanup. Source
bytes are excluded unless `include_sources: true` was explicitly approved.
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
