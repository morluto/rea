# ADR-0002: Controlled JavaScript replay authority and sandbox policy

- Status: Accepted
- Date: 2026-07-16
- Implementation status: Not implemented. This record is the required design
  gate for the isolated replay worker; no JavaScript replay tool or execution
  path ships at the time of acceptance.

## Context

REA can reconstruct JavaScript and Electron artifacts, observe an existing
browser or Electron page through passive CDP, capture an explicitly approved
process scenario, and correlate those observations without executing bundle
code in the REA server. The next research workflow needs to execute selected,
extracted JavaScript modules with controlled inputs and deterministic stubs so
that parsers, sanitizers, serializers, and similar pure logic can be compared
across versions.

That workflow crosses a qualitatively different boundary. Source recovered
from an application is untrusted code. It can intentionally or accidentally
read files, contact services, spawn processes, exhaust resources, corrupt the
analysis process, forge protocol output, or interact with another same-user
process. A JavaScript realm or Node.js `vm` context is useful for constructing
an API surface, but it is not a security boundary. Node.js also documents its
permission model as protection against accidental access by trusted code, not
as containment for malicious code.

Existing authorities cannot be widened to cover this behavior:

- `browser_observe` and `electron_observe` authorize passive attachment to an
  already-running, operator-owned target. They do not authorize evaluation,
  navigation, input, or target lifecycle changes.
- `process_capture` authorizes one declared host process scenario and explicitly
  states that it is not a sandbox. It cannot silently become permission to run
  recovered code.
- static artifact reads authorize inspection of bytes, not execution of those
  bytes.
- the Evidence authority `controlled-replay` already describes observations
  from an approved process experiment. Reusing that epistemic authority is
  correct, but reusing the process permission capability is not.

The implementation following this ADR must fail closed on hosts where REA
cannot establish the promised operating-system boundary. It must not copy the
research `vm.runInContext` scripts into the production server and call that
isolation.

## Decision drivers

1. Passive observation must never imply authority to execute application code.
2. The exact code, inputs, stubs, runtime, sandbox policy, and limits approved
   by the operator must be the ones executed.
3. Recovered code must not run in the MCP server, CLI adapter, or any provider
   process.
4. A sandbox failure must make the capability unavailable, not select a weaker
   execution mode.
5. The default policy must provide no host network and no writable host path.
6. Time, memory, process count, temporary storage, protocol, and output must be
   bounded independently.
7. Results must distinguish an observed return, an observed exception or
   termination, a derived comparison, and an unresolved application-level
   claim.
8. A reproducer must commit enough provenance to detect every relevant change
   without committing proprietary application source to the repository.
9. CLI and MCP must expose the same plan, approval, execution, cancellation,
   failure, and Evidence semantics.

## Terminology

- **Passive observation**: bounded reads from an existing browser or Electron
  target without evaluating code, driving input, navigating, or controlling
  its lifecycle.
- **Controlled replay**: execution of operator-selected code in a declared,
  isolated environment with committed inputs and limits. This is an Evidence
  authority, not a claim that the real application behaved identically.
- **Extracted-module replay**: the only admitted JavaScript replay mode in v1.
  REA evaluates a finite manifest of module bytes and explicit stubs without
  launching the application.
- **Application interaction**: launching or driving the original application,
  browser, renderer, or Electron main process. This is not extracted-module
  replay and is not authorized by this ADR.
- **Replay plan**: the canonical, content-addressed description of one proposed
  run before execution.
- **Replay worker**: the disposable Node.js process inside the OS sandbox. It
  is never the REA server process.
- **Sandbox backend**: the OS mechanisms and adapter that establish namespaces,
  resource controls, filesystem visibility, and owned cleanup.

## Threat model

### Protected assets

The boundary protects:

- the REA MCP/CLI process, its memory, credentials, sockets, and Evidence
  ledger;
- user files outside the approved source reads and all host files from writes;
- other same-user processes and their control interfaces;
- host network interfaces, loopback services, Unix sockets, and external
  services;
- process, memory, CPU, temporary-storage, output, and protocol capacity;
- the integrity of the replay plan, result, Evidence provenance, and exported
  reproducer; and
- proprietary module bytes, which remain local and are never repository
  fixtures.

### Adversaries and failure sources

REA treats all of the following as untrusted:

- recovered module source, including transitive modules and source maps;
- caller-provided JavaScript stubs;
- structured test inputs and generated fuzz cases;
- returned values, exceptions, console data, and worker protocol messages;
- source paths, symbolic links, and files that can change between planning and
  execution; and
- a worker that crashes, hangs, forks, allocates aggressively, or exits while
  descendants remain alive.

An operator-controlled sandbox executable, kernel, Node.js runtime, and REA
installation are trusted computing base. A hostile host administrator, kernel
or sandbox vulnerability, hardware side channel, and denial of service by an
already-compromised same-user process are out of scope. These exclusions do not
permit REA to omit the per-run resource controls in this decision.

### Required mitigations

The implementation must address:

| Threat                           | Required control                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Server-process compromise        | Separate worker process inside the OS sandbox; no in-process fallback                                           |
| Host file reads                  | Empty sandbox root; only a minimal read-only runtime closure; module bytes enter over a private bounded channel |
| Host file writes                 | No writable bind mounts; size-limited private tmpfs only                                                        |
| Network access                   | Separate network namespace with no host or external connectivity; no allowlist mode in v1                       |
| Host process control             | PID/user/IPC/UTS isolation, no inherited control sockets, new session, dropped capabilities                     |
| Kernel escape/inspection surface | Architecture-checked seccomp denial policy in addition to namespaces, capabilities, and cgroups                 |
| Fork, memory, or CPU exhaustion  | Per-run cgroup v2 task, memory, swap, and CPU limits plus an outer wall-clock deadline                          |
| Output/protocol exhaustion       | Independent byte/message/depth limits enforced by the parent before parsing or retaining output                 |
| Symlink and file-change races    | Canonical authorization, descriptor-backed reads, digesting, staging, and exact plan revalidation               |
| Undeclared dependencies          | Closed module manifest; exact imports only; missing/dynamic imports fail rather than use host resolution        |
| Nondeterministic globals         | Versioned clock, PRNG, locale, timezone, platform, and API stubs; undeclared globals are unavailable            |
| Orphan descendants               | Owned PID namespace and cgroup kill followed by an observable empty-cgroup cleanup check                        |
| Forged result claims             | Framed worker protocol, strict schemas, parent-computed commitments, and bounded stderr kept separate           |
| Secret leakage                   | Empty environment, no credential inheritance, bounded local results, and existing genuine-secret redaction      |

## Decision

### 1. Add a distinct `javascript_replay` permission capability

JavaScript replay receives a new permission capability named
`javascript_replay`. It does not inherit, imply, or satisfy
`process_capture`, `browser_observe`, `electron_observe`, artifact-read, or
workspace permissions. Grants for any of those capabilities do not satisfy a
JavaScript replay request, and a JavaScript replay grant does not authorize
them.

The administrator ceiling is disabled by default. Its eventual configuration
must commit:

- canonical roots from which module and optional stub files may be read;
- the exact Node.js and sandbox-backend executables;
- filesystem mount authority needed only to construct the private sandbox;
- network mode `none`; and
- no inherited environment names.

Configuration establishes only the maximum authority. Every execution also
requires an active permission grant and literal per-call approval bound to the
exact replay plan. Project, session, and administrator grants may satisfy the
permission-policy layer, but none replace that per-run approval.

Reproducer export is a separate host write after the sandbox has stopped. It
uses the existing bounded `evidence_write` authority and a separate export
approval; `javascript_replay` alone never writes a host file.

### 2. Admit extracted modules only

The v1 mode executes a finite, closed manifest of JavaScript modules. The
manifest identifies one entry module and every admitted dependency by a stable
sandbox alias and SHA-256 digest. Imports resolve only to another manifest
entry or to an explicitly declared, versioned stub. Bare package lookup,
ambient `node_modules`, import maps from the host, network imports, native
addons, WASI, FFI, child processes, workers, inspector activation, and implicit
dynamic import are unavailable.

Modules and stubs are read and hashed by the authorized parent, then copied as
bytes through a bounded private channel. Original host paths are not mounted
into the sandbox. The worker cannot reopen the operator's source path.

Source maps may supply locations, but source-map source code is not executed
unless its bytes are separately present in the approved manifest. A source-map
name or Webpack module ordinal is never execution authority.

REA does not launch, attach to, navigate, click, type into, or terminate the
user's application under this capability. A full application process remains
an independently approved Process Capture experiment; browser and Electron
targets remain passive. Any future mode that drives an application or permits
host/allowlisted network requires a new ADR and a distinct permission scope.

### 3. Use a two-phase, content-bound approval flow

One public replay surface supports a plan phase and an execute phase with the
same schema through CLI and MCP.

The plan phase:

1. validates all caller input and hard limits before file access;
2. obtains authority to read every selected module or stub path;
3. canonicalizes and opens each file without following an unapproved identity;
4. reads bounded bytes, computes digests, and closes the source descriptors;
5. resolves and probes the exact runtime and sandbox backend without running
   application code;
6. normalizes stubs, inputs, generator settings, and limits; and
7. returns the complete proposed effects and a canonical `plan_digest`.

The plan must disclose at least:

- module aliases, canonical local paths, byte counts, and SHA-256 digests;
- input and stub identities, provenance, and digests;
- runtime and sandbox executable paths, versions, and executable digests;
- sandbox policy version and digest;
- network `none`, visible read-only runtime paths, and private writable tmpfs
  size;
- time, CPU, memory, swap, task, temporary-storage, input, output, protocol,
  case-count, and serialization limits;
- deterministic clock, PRNG seed/algorithm, locale, timezone, and platform
  projection; and
- expected Evidence and cleanup behavior.

Execution requires both `approved: true` and the exact `plan_digest`. REA
rebuilds the plan immediately before admission. Any changed file, runtime,
sandbox executable, policy, stub, input, limit, or environment commitment
returns `plan_stale` before application code starts. Approval is not transferable
to a different plan and cannot be represented by a bare Boolean alone.

Interactive CLI may print the plan and ask for confirmation. Non-interactive
CLI and MCP must perform the same explicit plan/execute exchange; they may not
auto-approve because the caller requested JSON output or because permission
elicitation is supported.

### 4. Require an OS sandbox; fail closed elsewhere

The first production backend is Linux-only. It must combine:

- an empty mount namespace rooted in private tmpfs;
- a new user namespace with all capabilities dropped and further nested user
  namespaces disabled;
- new PID, network, IPC, UTS, and cgroup namespaces;
- a new terminal session and parent-death behavior;
- no host D-Bus, agent, browser, Docker, Wayland/X11, SSH, GPG, audio, device,
  or application sockets;
- a minimal, read-only runtime closure rather than `/`, the user's home,
  working directory, or host `/tmp`;
- a fresh `/proc` for the sandbox PID namespace and a minimal private `/dev`;
- a parent-generated, architecture-checked seccomp policy that denies at least
  namespace or mount changes, `ptrace` and cross-process memory inspection,
  BPF/perf access, kernel keyring and module control, reboot/swap controls, and
  the `TIOCSTI` terminal injection path;
- cgroup v2 `memory.max`, `memory.swap.max=0`, `pids.max`, and bounded CPU
  controls owned for the one run; and
- an outer REA supervisor that can kill the complete cgroup and verify it is
  empty.

The seccomp program is passed by descriptor, has a version and digest committed
to the replay plan, validates the syscall architecture before the syscall
number, and never permits `ptrace`-based mediation. Seccomp reduces exposed
kernel surface; it is not described as a complete sandbox by itself.

The reference backend for the implementation PR is Bubblewrap for namespace,
mount, and seccomp construction plus a delegated cgroup v2 manager for resource
enforcement. REA must feature-probe the actual required operations; version
text alone is insufficient. A setuid Bubblewrap installation, a backend that
silently skips a requested namespace or filter, unavailable user namespaces,
missing cgroup delegation, or inability to prove cleanup makes the capability
unavailable. REA setup must not install or upgrade Bubblewrap, systemd, Node.js,
or kernel components.

macOS, Windows, Linux hosts without every required feature, containers that
block the required namespaces, and alternative backends are unavailable in
v1. They must return precise diagnostics and remediation, not a process-only or
`vm`-only degraded mode.

Node.js runs with its permission model enabled and without grants for network,
filesystem, child processes, workers, native addons, WASI, FFI, or inspector.
That layer is defense in depth. It is never cited as the OS security boundary,
because Node.js explicitly does not promise containment of malicious code.

### 5. Make the worker disposable and deterministic by construction

Each approved run receives a new sandbox, runtime root, worker process, module
loader, and deterministic state. No module cache, realm, timer, file, global,
or child survives into another run. Within a multi-case run, every case gets a
fresh realm and fresh module instances; case order and generator state are
committed.

The worker exposes a small versioned set of language primitives and explicitly
selected stubs. It does not expose `process`, `require`, host `console`, timers,
`fetch`, sockets, filesystem APIs, `Buffer`, worker APIs, native bindings, or
ambient environment variables. Date/time, randomness, locale, timezone, and
platform values come only from committed deterministic providers. An
unsupported global or import produces an observed exception; REA does not
substitute a convenient host implementation.

Caller-provided stubs are executable untrusted code and receive the same
sandbox treatment as recovered modules. Built-in stubs have stable IDs,
versions, canonical source digests, and documented semantics. No undeclared
fallback stub is allowed.

Inputs are bounded canonical JSON. Results are projected without invoking
getters, proxies, `toJSON`, or arbitrary coercion: only admitted primitives,
arrays, and plain data properties are serialized. Cycles, accessors, functions,
symbols, unsupported prototypes, excessive depth, excessive nodes, and
oversized values become explicit serialization outcomes. Worker stdout is the
framed protocol only; bounded diagnostic stderr and bounded, opt-in console
observations remain separate.

### 6. Enforce independent resource ceilings

Every limit has a conservative product default and a caller value may only
narrow it. At minimum the plan and result commit:

- wall-clock startup, per-case, total-run, and cleanup deadlines;
- cgroup memory, swap, task, and CPU ceilings;
- Node/V8 heap ceiling as defense in depth;
- private tmpfs bytes and file-count ceiling;
- module count, module bytes, import depth, input bytes, input depth, case
  count, and generated-case bytes;
- stdout, stderr, console, exception, stack, result, protocol-message, and
  aggregate retained-output bytes; and
- structured-result depth and node count.

The parent enforces protocol and output limits while bytes arrive, before JSON
parse or Evidence retention. The worker cannot request wider limits. A limit
hit terminates the complete run cgroup and is an observed termination, not a
partial successful return.

### 7. Preserve exact provenance and the right Evidence authority

A run that reaches worker admission produces Evidence v2 with:

- provider `rea-javascript-replay` and a concrete implementation version;
- operation `run_controlled_replay`;
- authority `controlled-replay`;
- confidence `observed` for the exact returned value, thrown exception,
  sandbox denial, limit termination, signal, exit, or crash that REA directly
  observed;
- environment isolation `container`, the host platform/architecture, runtime
  identity, sandbox-backend identity, and sandbox-policy digest;
- the replay plan digest, module and stub digests, canonical input or generated
  case digests, deterministic providers, and every effective limit;
- bounded raw input, output, and exception data when retained, plus their
  canonical digests and truncation state;
- start/admission/termination/cleanup states; and
- explicit limitations for incomplete output, nondeterminism not checked,
  sandbox diagnostics, or cleanup that could not be proven.

The host module path remains an actionable local diagnostic and Evidence
subject location, while the worker sees only a stable alias. Module source is
not embedded in ordinary Evidence. A separately approved reproducer may copy
module/stub bytes or may retain path-plus-digest references; its manifest says
which mode was used. Repository tests use source-owned fixtures, and real-app
verification stores only digests and expected structural facts.

Derived differential results use confidence `derived` and link every source
run Evidence ID. A repeat with the same commitment can establish
`repeat-confirmed` for those runs; a single deterministic plan is only
`committed-not-confirmed`. Neither state proves behavior in the original
application.

When replay observations are added to the JavaScript Application Graph, their
graph-fact authority is `controlled-replay`. A claim that the real renderer,
preload, main process, or remote service behaves the same remains inferred or
unknown until compatible runtime authority exists. Static inference, passive
CDP observation, controlled replay, and real application interaction are never
promoted into one another.

### 8. Treat post-admission failures as observations

Pre-admission failures return a typed error and create no claim that module code
ran. Once the worker is admitted, REA retains a bounded execution record even
when the requested function does not return normally.

| Condition                                        | Caller result and Evidence semantics                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Disabled capability or missing grant             | `permission_required`/`capability_unavailable`; no worker admission and no replay observation              |
| Sandbox/runtime probe failure                    | `capability_unavailable` with exact failed feature; no module execution                                    |
| Plan digest mismatch or changed source           | `plan_stale`; no module execution                                                                          |
| Sandbox setup fails before worker admission      | `execution_failure`; no controlled-replay claim about the module                                           |
| Module returns admitted data                     | Observed return value with complete or explicitly limited coverage                                         |
| Module throws or result serialization rejects    | Successful replay observation with outcome `exception` or `serialization_error`; application claim unknown |
| Node permission or sandbox denies an operation   | Observed denial/termination when attributable; no claim that all attempted side effects were enumerated    |
| Timeout, memory, CPU, task, tmpfs, or output hit | Observed limit termination; requested functional result unknown                                            |
| Signal, runtime crash, or malformed protocol     | Observed termination plus bounded diagnostics; functional result unknown                                   |
| Caller cancellation after admission              | Kill full cgroup, record cancellation/cleanup if possible, and project the public cancellation contract    |
| Cleanup proves an empty cgroup and removed root  | `cleanup: complete`                                                                                        |
| Cleanup cannot prove emptiness or removal        | `cleanup_incomplete`, name every residual resource, and do not report success                              |

An exception is data, not an adapter failure. A sandbox setup error is not
evidence that the module crashed. A timeout is not evidence that the function
would never return. An output limit is not evidence that the truncated prefix
equals the full result. These distinctions are part of the public contract.

Cancellation and cleanup must be idempotent. REA first stops admission and
input, kills the owned cgroup, waits for an empty-cgroup observation, removes
the private runtime root, closes protocol descriptors, and releases timers.
Failure at one cleanup step does not skip the remaining steps.

### 9. Keep replay records reproducible without overstating determinism

The canonical replay manifest commits:

```text
schema and policy versions
REA/provider/runtime/sandbox executable identities and digests
module aliases, dependency graph, bytes digests, and source references
stub IDs, versions, source digests, and caller-provided stub digests
canonical inputs or generator algorithm, seed, case order, and case digests
clock, PRNG, timezone, locale, platform, and exposed-global commitments
all resource and serialization limits
network and filesystem projections
expected entry export and invocation convention
```

The result manifest adds canonical output/exception/termination digests,
coverage, dropped-data counts, cleanup state, and source Evidence links.
Canonical digests are computed by the trusted parent; worker-provided digests
are ignored.

Reproduction requires exact manifest compatibility. A runtime, sandbox policy,
built-in stub, module byte, generated case, limit, architecture, or platform
change is a different experiment. Cross-environment comparison may still be a
derived investigation, but it is never an exact replay.

### 10. Expose availability and policy truth before execution

`rea doctor`, capability inventory, and the planning response must report the
JavaScript replay capability without executing application code. Diagnostics
name the exact missing executable, unsupported host, failed namespace feature,
cgroup delegation failure, setuid rejection, runtime mismatch, or cleanup-probe
failure. Genuine secrets remain redacted; local executable paths, versions,
digests, and kernel feature failures remain visible.

The capability must be absent from executable tool routing until implemented.
Accepting this ADR does not increase the current tool count and does not add a
hidden experimental flag.

## Required implementation and verification gate

The implementation PR cannot merge until all of the following are true:

1. `javascript_replay` exists in configuration, permission policy, project
   grants, policy explanation, CLI, MCP, docs, and capability inventory with
   fail-closed defaults.
2. Plan and execute phases have schema-identical CLI/MCP behavior and an exact
   plan-digest stale check.
3. No replay-disabled static, browser, Electron, session, setup, doctor, or
   application workflow can reach module execution.
4. The worker never imports into the REA server process and no adapter offers a
   `vm`-only fallback.
5. The Linux backend feature-probes every required namespace, read-only runtime
   closure, seccomp denial, cgroup limit, parent-death, cgroup-kill, and cleanup
   property on every admitted architecture.
6. Source-owned hostile fixtures cover host file reads/writes, symlink changes,
   environment reads, external and host-loopback network, Unix sockets, child
   processes, workers, native addons, inspector activation, fork pressure,
   memory pressure, busy loops, tmpfs exhaustion, output flooding, malformed
   protocol, exceptions, crashes, cancellation, and orphan attempts.
7. Tests prove no host write, no host/external network connection, all limits,
   bounded diagnostics, and empty-cgroup/private-root cleanup.
8. Evidence tests cover return, exception, denial, timeout, OOM, task limit,
   crash, cancellation, truncation, comparison, repeat confirmation, and
   unknown application-level claims.
9. Packaged verification exercises the real Linux sandbox backend. Unsupported
   CI platforms prove truthful unavailability rather than silently skipping
   the policy.
10. A real operator-local Notion-like parser or sanitizer benchmark can run
    without committing its source, and exports only approved local reproducer
    material.

## Rejected alternatives

### Reuse `browser_observe`, `electron_observe`, or `process_capture`

Rejected because those grants authorize different effects. Reuse would turn a
passive or unsandboxed process permission into recovered-code execution.

### Execute in the MCP server with `vm.runInContext`

Rejected because a VM context is not a security boundary and a crash, resource
attack, or escape would compromise the long-lived session and its credentials.

### Use only the Node.js permission model

Rejected because Node.js documents it as a seat belt for trusted code and
explicitly does not guarantee containment of malicious code. It remains a
defense-in-depth layer inside the OS sandbox.

### Ship a process-only fallback on unsupported hosts

Rejected because it changes the security claim while preserving the same tool
name. Unsupported hosts return unavailable.

### Permit network allowlists in v1

Rejected because DNS, redirects, proxies, credentials, service identity, and
response nondeterminism would substantially expand the threat and Evidence
model. The v1 namespace has no host or external network.

### Mount the approved project root read-only

Rejected because one approved module does not imply authority to disclose
every file in its project. The parent stages only exact, digested bytes.

### Treat exceptions, crashes, or limit hits as ordinary tool errors only

Rejected because that discards the principal behavioral observation and makes
negative results impossible to reproduce. Post-admission termination is
retained with explicit functional uncertainty.

## Consequences

- JavaScript replay is Linux-only at first and may be unavailable on containers
  or distributions that disable user namespaces or cgroup delegation.
- The implementation requires more host probing and lifecycle code than a
  simple Node worker, but the public security claim remains stable.
- Plans require two calls in non-interactive environments and become stale when
  any committed input changes.
- Network-dependent modules and full application interactions are excluded;
  their absence is explicit rather than emulated implicitly.
- Results are reproducible for the committed isolated experiment, not proof of
  production behavior.
- Adding another sandbox backend, network mode, or application-interaction mode
  requires a separate reviewed decision and conformance suite.

## References

- [Node.js permissions](https://nodejs.org/api/permissions.html) documents that
  the permission model does not protect against malicious code and describes
  its known filesystem and cross-process limitations.
- [Bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)
  describes its namespace construction and makes clear that the caller's
  arguments, not Bubblewrap alone, define the sandbox security model.
- [Linux seccomp filter documentation](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)
  explains that syscall filtering reduces kernel surface but is not a complete
  sandbox by itself.
- [ADR-0001](0001-provider-selection-and-analysis-profiles.md) establishes the
  existing rule that provider selection, Evidence provenance, and capability
  unavailability remain explicit and never silently fall back.
