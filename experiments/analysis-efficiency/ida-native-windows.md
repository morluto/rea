# Native IDA MCP verification on Windows

Verification date: 2026-10-13. These runs used **IDA Pro 9.3** (executable
product version `9.3.26.0213`), not Windows IDA Free. Personal paths, raw
observations, and license registration information are excluded.

The native plugin was built from upstream
[`c9d15d98e8a143fc74f6e14037c48f63889b6d6c`](https://github.com/0xshlomil/ida-free-mcp/commit/c9d15d98e8a143fc74f6e14037c48f63889b6d6c)
with MinGW GCC 13 and its pinned public SDK. The only local source change
bound the listener to `127.0.0.1`; the upstream function-navigation fix was
already present. This does not verify the stock 1.1.2 release listener or
its older navigation order.

## Correctness and authority

The public [IDA fixture](../../tests/conformance/ida/inventory.c) contains
two exported functions with distinct bodies. Production CLI/MCP verification
checks matching function Evidence, assembly, a unique second-function marker,
return to the first function, original-input identity, invalid requests, and
connection cleanup. Native verification requires the second procedure and its
unique marker; missing, incomplete and empty arguments are rejected before
connecting. Dossier relationship coverage remains unknown when direct callers
are unavailable, while standalone callee coverage retains its own observed state.
It preserves the attached GUI database.

The later verification follow-up rejects native callee successes without an
explicit truncation marker, checks positive procedure inventory/search and
compares normalized function results. String and xref correctness require
independent positive oracles; runs without those oracles label them unverified.
Earlier reports established contract validity for these operations and did not
by themselves establish string/xref semantic correctness.

The follow-up passed eight production checks with a known CRT literal confirmed
in the unchanged fixture bytes and a reference source address independently
identified from `main` assembly matching the C source. A loopback response-only
proxy in front of the real IDA Pro provider reproduced the earlier verifier
passing empty function inventories and xrefs. The corrected verifier rejected
those replies with positive oracles, empty string results and missing native
callee truncation markers. The comparison used verifier source `d1aaeee40`
with the same current adapter runtime; it is a verifier comparison, not an
engine performance comparison. Only response payloads were modified; the original
input digest stayed unchanged, the target was never executed, and the attached
GUI database was preserved.

The real application was a digest-verified, unchanged copy of Windows
`whoami.exe`: 94,208 bytes, 243 recognized functions, and 314 upstream
C-string observations. The selected 1,741-byte function had 20 resolved
callees. Before and after, the task returned identical pseudocode, callee
addresses, and its one `whoami` string match. The executable was never run.
Other string representations remain unknown in the native profile.

A Windows C++ producer golden checked 24 literal/case combinations and
408 candidate comparisons, including metacharacters, Kelvin sign, dotted I,
sigma, supplementary characters, and null bytes. Adapter tests additionally
cover malformed UTF-16 fallback, candidate pagination, explicit search errors,
and reordered, missing, duplicate, unrelated, or failed lookup replies.
These checks do not establish IDA recognition of every Unicode string format.

## Equivalent completed tasks

Both builds used main `59be86671`. The baseline was `fb34ccbec`, before
the native performance edits; the comparison build added those edits.
Schemas were identical. Each run opened the same analyzed binary, read the
specified function's pseudocode and callees, searched literal `whoami`, and
closed the REA session. The task then repeated on the same MCP connection.

There were two runs per build on a shared host. Node 24.18.0 and IDA were
restricted to one logical CPU with below-normal priority; each Node process
had a 768 MiB heap ceiling. The attached database was already analyzed.
Node compile caching was disabled for the primary comparison.

| Measurement                                         |       Before |        After |
| --------------------------------------------------- | -----------: | -----------: |
| Task response text                                  | 49,139 bytes | 32,546 bytes |
| Task response token estimate                        |       16,618 |       11,509 |
| Callee lookup calls, including selector             |           17 |            2 |
| String-search pages                                 |            4 |            1 |
| String-search Evidence                              | 19,022 bytes |  3,344 bytes |
| Mean task time, warm MCP connection                 |       675 ms |       317 ms |
| Mean task time, fresh MCP process and catalog       |      19.72 s |      20.86 s |
| Mean Node family CPU, fresh and warm tasks together |      17.72 s |      18.62 s |
| Largest Node family peak-RSS upper bound            |    776.8 MiB |    780.0 MiB |
| Mean attached IDA CPU during both tasks             |     226.6 ms |     171.9 ms |

The warm task was about 53% faster and its response estimate about 31%
smaller. Fresh-start, overall CPU, and memory improvements were not
established. Startup and full catalog conversion dominate the fresh task.
Two samples do not establish a general performance guarantee.

Token counts use local `cl100k_base` tokenization of complete serialized
MCP response text and request arguments; they are estimates, not model usage.
Requests added 99 estimated tokens per task. The unchanged full schema
catalog contained 2,422,229 bytes and 613,965 estimated tokens. Including it
once gives first-task estimates of 630,682 before and 625,573 after. A host
may select schemas lazily; actual host injection, prompts, reasoning tokens,
and model-side costs were not measured. No retries were needed.

Node CPU counters were captured at shutdown. The memory figure sums the
two processes' individual OS peak RSS values: an upper bound, not a
simultaneous family peak. Attached IDA is outside that process family; its
unchanged lifetime peak working set was 376.9 MiB, including initial analysis.
Measurement overhead and whole-machine resource use were not measured.

## Reuse and cleanup

Callee queries are deduplicated and batched within an operation. Literal
search fetches a conservative candidate set, including non-ASCII text when
needed, and preserves REA's final Unicode predicate. It examines all candidate
pages and retains full source observations. Regex searches keep the full scan.

Cross-request analysis results remain live because an input digest does not
establish database revision or freshness. An exploratory caller-selected
[Node compile cache](https://nodejs.org/download/release/v24.16.0/docs/api/module.html#module-compile-cache)
did not demonstrate startup improvement: empty-cache and cache-hit MCP starts
were 7.35 s and 7.56 s. It occupied 6.7 MiB and was limited to this experiment;
no new default cache or installation behavior was introduced.

Temporary source, SDK, build, portable runtime, cache, and raw measurement
outputs are test-owned cleanup targets. Attached GUI databases are retained;
REA never saves or closes them.
