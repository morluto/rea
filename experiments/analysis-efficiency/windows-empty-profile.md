# Windows empty-profile startup verification

Follow-up to [#2345](https://github.com/morluto/rea/pull/2345), including
@gefrezim's diagnosis of the import-time Windows home lookup.

## Source and boundary

Baseline: main `172407787f1842dedbcd27b5385177595f786ce4`. Verification used
the real Windows 11 10.0.22631.0 host, official Windows x64 Node 24.18.0,
locked production dependencies and REA's compiled public CLI / SDK 2.3.1 MCP
server. No IDA or Ghidra engine was used. Runtime copies and compact receipts
live outside the checkout; no account profile path or ambient environment is
recorded here.

The tested dispatcher SHA-256 is
`526105418604cc6e5a202a6275b700814e27450bfaffd45e7510530ba669de8d`.
Only the dispatcher changed in the deployed runtime. It treats an empty Windows
`USERPROFILE` as unset before dependency imports. Nonempty selections continue
to reach the existing home resolver; no additional lookup or fallback owner is
introduced.

## Real Windows observations

With `HOME` empty in each case, the baseline produced:

| USERPROFILE selection       | `--version`             | `--help`                | MCP discovery |
| --------------------------- | ----------------------- | ----------------------- | ------------- |
| Unset                       | Exit 0                  | Exit 0                  | Healthy       |
| Empty                       | Exit 1, `uv_os_homedir` | Exit 1, `uv_os_homedir` | Healthy       |
| Nonempty test-owned profile | Exit 0                  | Exit 0                  | Healthy       |

The corrected CLI passed all six invocations with no stderr. Version output
remained 6 bytes and help output 15,497 bytes. Real setup dry runs with empty
and nonempty profile selections both exited 0, planned their configuration
under the expected home, preserved existing configuration bytes and created no
configuration under the working directory. No installation was performed.

MCP was already healthy in the baseline; this change does not claim to repair
an MCP startup failure. Complete baseline discovery was 187 tools and 2,545,790
serialized bytes, SHA-256
`1e6bbca7f62852134eb703ea098f5a302d1fe333b8433475429f6fc1b1aba18f`.
All three corrected MCP controls also passed with no stderr and the same
catalogue bytes and digest.

The existing `homeDirectoryFallback` acceptance test exercises the import-time
failure through the public setup dry run. Adding it to the Windows curated lane
makes that regression execute on the affected platform. No duplicate startup
test was retained. Nine related tests passed, including the existing MCP doctor
and curated-lane path checks; Linux passing alone does not prove Windows behavior.
Review caught a missing package-scope registration for the newly listed test;
the original CI shard failed that ownership invariant. The path is now also
registered in `scripts/ci/scopes.mjs`, and all 84 scope checks plus the two
curated-path checks pass. Runtime source and its tested digest are unchanged.

## Efficiency and resource limits

Heavy host probes ran serially at BelowNormal priority, with one CPU and a
512 MiB CLI/server heap setting (256 MiB for the probe parent). Heap settings do
not bound total process memory. An exit-time `process.resourceUsage()` observer
recorded individual corrected CLI invocations: CPU time ranged from 7.968 to
9.874 seconds and peak working set from 299,956 to 301,852 KiB. These figures
exclude the probe parent and any observer overhead outside the CLI process.
The six observed wall times ranged from 8.656 to 10.961 seconds.

The baseline did not use that resource observer, and cold/warm caches were not
normalized. These observations establish functional behavior and bounded probe
scope; no CPU, memory or latency improvement is claimed. The fix adds one
constant-time environment check, no filesystem lookup, engine call, retry or
cache. Output bytes are not model tokens; actual model usage was not measured.
