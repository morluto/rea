# Runtime analysis settings verification

Historical report added in
[commit f3ed1657f82188fb90914f745a08849537342a23](https://github.com/morluto/rea/commit/f3ed1657f82188fb90914f745a08849537342a23)
on 2026-10-25. The exact source revisions used for the initial checks and
measurements were not recorded here. Those results do not establish current
verification. The initial checks describe the runtime-settings introduction;
dated follow-ups below preserve their own receipts and coverage limitations.
Rebasing the implementation does not requalify a later runtime against these
historical measurements.

The initial verification used macOS with Node 24.22.1, Java 21.0.12.1 and
Ghidra 12.1.4. That implementation added two MCP tools and 11 runtime defaults
without a new dependency.

## Behavioral checks

- Built stdio MCP: a valid ASAR with an index above 16 MiB is refused. Updating
  `asar.max_header_bytes` to 32 MiB allows the unchanged full-archive inventory
  and JavaScript analysis on the same connection. Both source files are parsed.
  Reset refuses the same archive again; target close preserves the revision.
- An Electron header cached under a higher admission remains denied after a
  decrease. No bulk extraction or source selection bypasses admission.
- Store and deferred MCP handler tests retain the accepted snapshot across an
  overlapping update. Atomic rejection, duplicate keys, revision conflicts,
  idempotence, reset, isolation and explicit WABT argument precedence are covered.
- The real Ghidra verifier reaches a natural one-second decompile timeout, raises
  the runtime deadline to 60 seconds, and obtains pseudocode for the same slow
  function without replacing the Program. Initial and final session run IDs
  match; subsequent analysis succeeds and cleanup completes. Its generated
  6,000-branch fixture is compiled but never executed.
- The focused suite passed 459 tests across 22 files, with 10 platform-specific
  skips. Typecheck/lint, bridge source compilation, runtime build and generated
  documentation checks passed.

## Review follow-up

Invalid provider-local launch settings remain typed configuration failures rather
than preventing MCP startup. Inspection reports `source: "invalid"`, omits
`value` and `launch_value`, and includes `configuration_error`; a runtime
replacement supplies a usable value, while reset restores the invalid launch
state. JADX availability and execution resolve the same admitted timeout, so
repair and reset also update capability guidance. The availability regression
uses a fixture JAR and simulated JDK; it does not establish real JADX behavior.
Update history omits an unknown old or new value instead of using null
(the explicit unbounded Ghidra value).

Regex controls apply to IDA, Hopper and Kuna's supervised ECMAScript matcher.
Ghidra uses its own Java matcher and is excluded from these controls. IDA's bound
client and capability descriptions consume the same accepted configuration.
WASM passes its effective deadline separately from caller parameters, preserving
omitted arguments in both successful and partial Evidence. Shared error copying
retains structured limit recovery through attribution and explicit redaction.

## Representative task costs

Measurements below precede the review follow-up; task costs were not remeasured.
One measurement per scenario, using the built stdio server and a valid ASAR with
an index just above 16 MiB and one small JavaScript module. Each scenario ends
with successful full application analysis delivered as a summary. Discovery,
failed calls and recovery are included. Fixture creation, build and tokenizer
work are excluded. Filesystem caches were uncontrolled.

| Recovery workflow                                                      | Elapsed | Sampled server-family CPU | Sampled peak server-family RSS |
| ---------------------------------------------------------------------- | ------: | ------------------------: | -----------------------------: |
| Fresh server: fail, runtime update, retry                              |  3.68 s |                    1.81 s |                        680 MiB |
| Warm server: fail, runtime update, retry                               |  0.25 s |                    0.49 s |                        625 MiB |
| Launch-environment recovery: fail, close, restart with override, retry |  6.02 s |                    2.85 s |                        674 MiB |

The restart comparison uses the same current build to model the previous
recovery workflow; it is not a benchmark of the previous commit. CPU and RSS
are 100 ms `ps` samples of the server and descendants. Short-lived processes and
unsampled peaks can be missed; CPU estimates exclude the client and sampler.
These observations do not establish a general speedup or performance guarantee.

Tokenized with `cl100k_base` / tiktoken 0.12.0, not billed model usage. Catalog
projections include tool name, description and input schema. The two new tools
add 1,181 tokens; the full 229-tool projection is 59,734 tokens. The runtime
recovery task uses 5,880 tokens for all requests and complete tool replies, plus
1,710 for its selected tools (7,590 total), or 65,614 including full discovery.
Warm recovery reuses discovery. The restart workflow uses 5,492 request/reply
tokens plus two full discoveries (124,960 total). A host that caches discovery
or loads only selected tools has a different context cost. System instructions,
reasoning and client-specific presentation overhead are unmeasured.

## Coverage limits

The archive fixture isolates header admission; it is not the original Loom
archive. Real engine coverage here is Ghidra on macOS. Hopper, JADX, capture
and regex setting integration have source/boundary coverage, not a new real
provider run for every setting. Linux/Windows engines and Bun are unverified
for this change. Client deadlines and receive buffers remain externally owned;
active worker values are explicitly unobserved in the settings inspection.

## Ghidra budget recovery — 2026-11-09

The existing
[`verify-real-ghidra-decompile-timeout.mjs`](https://github.com/morluto/rea/blob/main/scripts/verify-real-ghidra-decompile-timeout.mjs)
now covers p-code projection budgets and native payload admission in the same
real Program as deadline recovery. It replaces the branch fixture in that lane
with 5,400 straight-line volatile statements. A preliminary 1,800-statement
calibration completed under one second, so it did not reproduce deadline
exhaustion; this was fixture calibration, not a failed provider result.

The retained lane ran once on macOS arm64 with Node 24.22.1, Ghidra 12.1.4 and
Homebrew OpenJDK 21.0.12.1. It compiled its own Mach-O dylib using
`cc -dynamiclib -fPIC -O0`; the target was never executed. The lane requested
a 1 GiB JVM heap, bounded compiler execution to 30 seconds, native recovery
decompiles to 20 seconds, and the overall run to 180 seconds. The JVM request
does not bound the separate native decompiler's memory.

Reproduce after the runtime build with an existing Ghidra/JDK installation:

```sh
GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.4_PUBLIC \
JAVA_HOME=/path/to/jdk-21 \
node scripts/verify-real-ghidra-decompile-timeout.mjs
```

`REA_DECOMPILE_TIMEOUT_STATEMENTS` selects another source-bounded fixture size
when calibrating a different host. The verifier refuses a scenario that does
not naturally exhaust the selected allowance instead of claiming a reproduced
timeout or payload failure.

The [compact receipt](https://github.com/morluto/rea/blob/main/docs/verification/runtime-analysis-settings-ghidra-2026-11-09.json) retains
the source/target hashes, profile digest, exact setting facts, native failure
diagnostics, timings and cleanup lineage. Observed results were:

| Selected control          | Observed failure or omission                                                                                                                          | Recovery in the same Program                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P-code operations: 1      | One operation retained, omitted-operation lower bound 1                                                                                               | Raising to 3000 returned eight operations without truncation; lowering to 2 subsequently returned two                           |
| Inputs per operation: 1   | Five known inputs omitted                                                                                                                             | Restoring 64 returned complete input coverage for the selected function                                                         |
| Def-use edges: 1          | One edge retained, five omitted                                                                                                                       | Restoring 12000 returned six edges without truncation                                                                           |
| Native payload: 1 MiB     | Ghidra reported `Response buffer size exceeded`                                                                                                       | Raising to 64 MiB returned 261131 bytes of pseudocode                                                                           |
| Native deadline: 1 second | The dossier retained 49912 assembly lines and one basic block with unavailable decompiler facets; direct pseudocode returned typed `provider_timeout` | Raising to 20 seconds and selecting payload `null` returned 261131 bytes of pseudocode; the next small function also decompiled |

The complete lane took 16.07 seconds. Initial and final authenticated session
run IDs both equal `c03f277d-d679-4e85-965b-690474ec4e9c`; the target SHA-256
remained `4004126020cc5517d75c47cacabc68422a12b3260ccd19c105f9a7df087c69d1`.
Provider close succeeded, token-verified lineage reported no live descendants,
and the fixture workspace was removed. Ghidra may replace its native decompiler
after a timeout; this check establishes Program/session continuity, not native
child-process continuity.

This lane uses the real provider and authenticated loopback bridge with the
shared runtime setting store. It does not exercise public CLI or MCP transport
recovery, Windows, another Ghidra release, or every parameter-use edge boundary.
The successful payload-null call does not measure the installed default's
effective ceiling. Timings are observations, not a before/after performance
comparison. CPU time, peak process-family memory and agent token usage were not
measured in the retained run.

## Native capture qualification — 2026-11-09

The installed Frida Node SDK and system LLDB also exercised the new capture
controls through their real application service/provider boundaries on macOS
arm64. The [compact receipt](https://github.com/morluto/rea/blob/main/docs/verification/native-capture-budget-qualification-2026-11-09.json)
records the selected/effective policies, observations and cleanup.

Frida's existing local-spawn verifier observed its marker and reported no cleanup
error. Additional controlled runs selected session allowances of 1 byte, 4 KiB
and 256 KiB. They respectively retained no event, a tagged payload-truncated
event, and the complete marker. The 4 KiB case exposes conservative accounting:
the existing fixed 128 KiB metadata reservation leaves no payload allowance.
This is explicit truncation, not evidence that the nominal 4 KiB is filled with
retained bytes. Its first marker assertion failed for that explained reason;
the subsequent larger-budget experiment does not recover discarded observations.

The production LLDB tracer ran a newly compiled arm64 C fixture with one known
function entry and a 20-byte stdout line. With `output_bytes: 2`, it retained
`re`, reported 20 drained bytes and truncation. A new run of the same unchanged
binary with `output_bytes: 64` returned the complete line, one expected event and
normal exit. Both targets were confirmed terminated and tracer cleanup succeeded.
An initial one-second observation elapsed during startup before any event; the
ten-second-window rerun isolated output retention. No caller target was run.

These checks establish real local producer behavior and cleanup, not public
MCP/CLI recovery, full AgentEnv execution, remote Frida, Windows/Linux behavior,
or optimal default sizes. Group cleanup observations are not whole-family peak
memory measurements. The live Ghidra lane above separately establishes same-Program
recovery for read-only static analysis.

## Main integration qualification — 2026-11-09

After integration onto main `8dfc47b107afc0cf4b53322a10b94c666fe9e18b`, the
retained Ghidra lane ran again against the integrated feature code. Its
[integration receipt](https://github.com/morluto/rea/blob/main/docs/verification/runtime-analysis-settings-ghidra-integration-2026-11-09.json)
records the new source/target identities and observations. Payload and deadline
recovery again used one Program with unchanged target bytes, and owned cleanup
completed. This is a fresh correctness qualification, not a new performance
comparison or a replacement for the historical measurements above.
