# Selected unknown retrieval

`list_unknowns` now accepts optional paging. Omitted limits still return all
matching heads. Selection happens before payload cloning in the ledger owner;
MCP returns complete selected records and the total matching count.

## Bounded workflow comparison

The task is to retrieve the first ten complete current unknown heads, in stable
ID order, from a session containing 200 heads. The complete-list workflow reads
all heads and selects ten locally. The selected-page workflow requests
`{"offset":0,"limit":10}`. Both use one real SDK MCP call through
`Client`/`InMemoryTransport`, with the same imported session and no provider.
All six executions returned identical selected records and the expected total.

These are two workflows on the candidate implementation, **not** a historical
before/after binary comparison. The candidate was built from `f09bb8a99` plus
the paging changes. Runtime file-table SHA-256 for the preserved complete-list
copy: `06a457dac90912dceba88f945573897372701f6c6b2e0934d7028023b4646648`.
Node 24.18.0, locked MCP SDK 2.3.1, tokenx 1.3.0, macOS arm64.

Flameox 0.2.9 ran three randomized paired blocks, seed 731, with a 30-second
and 1-GiB limit per execution. Each fresh process performed a first read and
five identical warm reads. The semantic oracle checked the selected answer
SHA-256, `c18d718a71323eb53712040b4b09ffebfc3497000d1ff8f58d57665638077310`.
Every execution and oracle passed.

| Measurement                               | Complete list | Selected page |
| ----------------------------------------- | ------------: | ------------: |
| Calls / errors per task                   |         1 / 0 |         1 / 0 |
| Serialized response bytes                 |       646,855 |        32,603 |
| Estimated request tokens                  |            12 |            21 |
| Estimated response tokens                 |       151,097 |         7,647 |
| Estimated full catalog tokens             |       764,512 |       764,512 |
| Median first-read elapsed milliseconds    |      1,084.05 |      1,082.65 |
| Median warm-read elapsed milliseconds     |         3.943 |         0.426 |
| Median first-read CPU milliseconds        |      1,333.23 |      1,328.47 |
| Median warm-read CPU milliseconds         |         5.012 |         0.591 |
| Median whole-process elapsed milliseconds |      1,752.40 |      1,664.42 |
| Median peak process-family MiB            |        598.59 |        554.09 |

Read timings include the MCP call and answer validation. First-read timings
exclude startup, imports, session preparation, handshake and catalog discovery;
the whole-process elapsed measurement includes those, all six reads, token
estimation and cleanup. Whole-process CPU was not measured. Peak RSS includes
preparation and imports; this workload has no child processes. Host caches were
not flushed. Three pairs and fifteen warm reads per workflow describe this
fixture only; they do not establish broad speed or memory improvements.

Token counts estimate serialized request, response and catalog JSON, including
both MCP response representations. They are not measured model tokens. Host
schema injection, prompts, reasoning, retries and actual agent behavior are
unmeasured. The full catalog cost is unchanged between these workflows and can
dominate a first task. Smaller selected delivery does not remove that cost.

Native Flameox evidence was preserved locally as
`14ea4c0ef6595a1b89645299d4e184a582d5e975f7916294d68c1f1b312608d0`,
analysis `f66e125179623591ce00b1ccf0d917c2e90512de55db1061269c042d65e1125d`.
An earlier 512-MiB capture exceeded its memory limit and is excluded from these
measurements. No production provider or model trial was run.
