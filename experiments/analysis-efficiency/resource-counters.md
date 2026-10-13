# Resource counters at payload completion

Continues [#2016](https://github.com/morluto/rea/issues/2016) from merged main
`4f4f6cd7b5d7a400b90772a138d7b9f942c2a556`. A transient cgroup can disappear
before the existing supervisor reads terminal counters. Earlier reports keep
those counters unknown; sampled zero events are not final no-OOM proof.

An optional `resource-run.py --observe-payload-exit -- COMMAND...` adds one small
observer inside the same owned scope. It waits for the direct payload, records
kernel `memory.peak`, CPU and memory/task events, and reports remaining processes
before acknowledging completion to the outer supervisor. The observer remains
alive until receipt acknowledgement, bounded by the existing ten-second cleanup
interval. Payload stdio and process exit status remain observable.

The receipt phase is **payload-exited-observer-alive**. The supervisor validates
the owned-unit token, numeric fields, cgroup identity, live observer membership,
payload exit status and absence of additional processes before marking that
observation verified. Wrong-owner, malformed, missing or inconsistent receipts
stay unknown; lingering actors stay explicit and cannot certify cleanup.
Unexpected metadata is omitted rather than copying an inherited environment.

This is not a final whole-scope counter: the observer still has to exit. Existing
`resource_events_final` and `resource_counters_verified` retain their original
meaning and unknown state. The grader's existing full resource gate is unchanged.
Earlier runs and source/runtime hashes are not relabeled. Observer CPU/memory and
acknowledgement time are included in this new measurement mode; comparable runs
must use the same mode. Default commands do not start an observer or add fields.

One CPU, the unchanged 3 GiB early-stop/4 GiB hard ceiling, no swap, task limits
and host-available-memory safeguards remain in force. No resource limit is raised.
The opt-in mode requires at least two task slots for observer plus payload;
smaller caller-selected ceilings fail before process acquisition. Default mode
continues to accept a one-task ceiling.
Cleanup uses the uniquely owned systemd scope, without signaling a process merely
because a recorded PID exists. Failed scope cleanup retains the named owner.

## Focused verification

Five semantic Python cases cover acquisition-free capacity rejection, nonzero exit/kernel facts, missing or malformed
receipts, wrong ownership, integer types, contradictory cleanup, lingering actors,
foreign symlinks and exclusion of unrelated metadata. They join the existing
Python gate; simulated receipts do not establish actual cgroup behavior.

Actual Linux cgroup/systemd probes additionally verify:

- Default mode keeps its receipt shape and success status.
- Success and exit-code 3 preserve the payload outcome and verify a sole observer.
- A bounded 16 MiB Node allocation yields a kernel peak, including work that the
  100 ms sampler can miss.
- A payload leaving a child reports both actors and refuses verification; the
  supervisor retires the owned scope.
- A caller-selected task ceiling of 4 triggers the existing task-limit early stop
  with exit 125 and an unverified observation.
- Interrupting a confirmed-live owned controller preserves failure and retires
  its scope; missing completion counters are not replaced with zeros.

These are metering/lifecycle probes, not a new model/provider performance claim.
Actual REA workflows and repeated observer-overhead measurements remain necessary
before relying on the new mode for domain comparisons. Raw receipts remain in
the private experiment lab outside Git.

## Actual REA and model observations

Checkpoint `d1f2cfe76df28e6effe973123f2e19313f6d0d4b` repeats real SDK workflows
against the unchanged frozen candidate `8bc1601ca51e417ca472d90ea0367e9418a1a0f2`
(runtime file-table SHA-256
`9e7380f537301bf0cfe2926f5619011af848af7c220750e75189498e65d825e1`).
The resource supervisor changes; the compiled REA/provider algorithms do not.
Managed pairs use default/observer/observer/default order with the same question,
settings, two public calls and identical selected facts. Raw receipts remain
private and new measurements do not replace historical resource unknowns.

| Workflow             | SDK milliseconds | Scope seconds | Sampled peak bytes | Kernel peak at payload exit | Payload CPU microseconds |
| -------------------- | ---------------: | ------------: | -----------------: | --------------------------: | -----------------------: |
| Managed default 1    |        5,168.485 |        11.814 |        525,873,152 |                     unknown |                  unknown |
| Managed observer 1   |        4,156.708 |         5.358 |        527,777,792 |                 535,724,032 |                5,195,457 |
| Managed observer 2   |        3,810.362 |         5.056 |        538,742,784 |                 539,529,216 |                4,818,497 |
| Managed default 2    |        4,263.993 |         5.360 |        526,032,896 |                     unknown |                  unknown |
| SQLite WASM observer |        6,733.216 |         8.087 |        777,199,616 |                 777,199,616 |                7,830,130 |
| NewPipe APK observer |       23,162.195 |        24.600 |      1,286,586,368 |               1,287,548,928 |               23,965,627 |

The WASM and APK runs use actual configured WABT and JADX/Java. Every observer
receipt verifies a sole remaining observer, successful payload exit and the
expected owned group. No guard abort occurs. The initial default scope timing is
an outlier relative to its SDK workflow and later scopes; its cause is not
established. Two managed pairs are insufficient to characterize observer overhead
or establish a speed/memory improvement. Kernel peak and CPU include the observer.

One actual Codex CLI 0.161.0 trial uses the original managed question, exact-name
guidance, context capture and requested `gpt-5.6-terra` high. It passes selected
facts, preserves source bytes, removes its profile and makes three successful MCP
calls (including an additional artifact inspection). Reported usage is 61,173
input, 48,128 cached, 13,045 uncached and 2,678 output tokens; wall time is 125.798
seconds. The payload-exit witness records 812,896,256 kernel peak bytes and
8,566,029 CPU microseconds with only the observer alive and zero recorded
memory/task limit events at that phase. This confirms the completed model/MCP
payload boundary, not a token/time benefit or final whole-scope no-OOM proof.
Its full existing grader remains false for unknown terminal physical counters.

The subsequent review adds supervisor/helper source SHA-256 to opt-in receipts
before process acquisition, without adding those fields to default receipts.
This distinguishes measurement implementations independently of frozen runtime
identity and keeps the observer's phase explicit.
