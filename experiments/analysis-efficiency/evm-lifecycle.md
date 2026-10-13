# EVM descriptor lifecycle acceptance

Continues [#2016](https://github.com/morluto/rea/issues/2016) after
[#2349](https://github.com/morluto/rea/pull/2349) merged. The
[public verifier](verify-evm-lifecycle.mjs) exercises actual compiled CLI and
stdio MCP workflows with unchanged EVMole 0.9.3/WASM. This increment adds
verification only; production contracts, factories, algorithms and defaults
remain unchanged. It does not introduce a plugin SDK or database cache.

## Runtime and public artifacts

The verified runtime is explicitly frozen from
`67f817e3653efad35f7044e68fbd6f163b86864b`, built with Node 24.18.0 and the
matching locked dependencies. Its `dist/` and `bridge/` file-table SHA-256 is
`cf03167870ac9def929cfaab536d6bd791089031660d1b35bff20672ac07cbbf`.
The table is checked again after each workflow; source and target bytes must
remain unchanged before a success receipt is published.

Inputs are the digest-pinned [corpus](corpus.json): published historical WETH
and official Uniswap v3-core 1.0.1 Factory/Pool compiler runtime templates.
They are not independently authenticated live deployments. Their deployment,
hardfork, immutable-reference and inferred-interface limitations remain as
recorded in [the descriptor checkpoint](evm-descriptor.md). The healthy peer
is the shipped SQLite WASM 3.53.4-build1 module, inspected by real WABT 1.0.42.
No contract, native target, chain/RPC query or transaction is executed.

## Actual cancellation and retained cleanup

The verifier supplies a private test launcher through the existing explicit
`REA_EVM_PRLIMIT_COMMAND` setting. It passes the original arguments to real
`/usr/bin/prlimit`, runs the unchanged Node/EVMole worker, then briefly gates
launcher completion after that worker exits and writes its complete reply.
This controls a real lifecycle boundary without replacing the analysis engine.
It adds process overhead and is not a performance comparison.

Before cancellation or permission changes, production inspection primitives
verify the live launcher's run token, parent/group relationship and native
start identity. The complete worker reply must match the original selected
bytecode and producer facts. Filesystem changes apply only to the verified,
non-root user's temporary runtime directory.

Three scenarios are verified:

- **Late cancellation:** the real worker has completed, while the public SDK
  request remains pending. SDK cancellation reports `REQUEST_TIMEOUT` locally;
  token sweeps and directory removal independently confirm provider cleanup.
  A subsequent complete request returns identical analysis facts.
- **Successful analysis followed by cleanup failure:** removing write permission
  produces actual `EACCES`. MCP reports `cleanup_incomplete` and retains the
  original resource path. A retry before permission repair fails on that same
  resource. Real SQLite WASM analysis still succeeds. Restoring permission lets
  the provider retire the old resource and perform a fresh complete EVM query.
- **Format failure followed by cleanup failure:** a deliberately malformed
  odd-nibble carrier reaches the unchanged worker. The cleanup error preserves
  its original `invalid_input` category and exact producer diagnostic rather
  than overwriting the failure. The same repair/retry and healthy-peer checks
  succeed.

The existing CLI `inspect-evm-interface PATH hex --json` produces the same
complete normalized facts, parameters and subject as MCP. Fresh Evidence IDs
are not equated. Final verifier lineage is checked after client/transport close;
an empty descendant list is a point-in-time observation, not proof that the
workflow never launched children. Cleanup callbacks always run and preserve
verification and cleanup failures together.

This proves cancellation after actual analysis, not interruption inside
EVMole's synchronous WASM computation. Server-shutdown cleanup retry still has
the separately labeled injected-owner SDK tests from the descriptor checkpoint.
These Linux x64 observations do not establish Windows/macOS provider behavior.
Earlier real CLI/MCP malformed/unavailable/capacity checks remain linked in the
descriptor checkpoint; they are not silently rerun or attributed to this script.

## Measurements and compatibility scope

Initial three-carrier verifier source SHA-256 is
`2fec069b53324ef82070d323b26dd613b6da0caa7f18100adbeb39b045cf98dc`.
All three carriers pass all three scenarios and CLI parity with this same source.

| Carrier | Seconds | Sampled peak family bytes | Last-observed CPU seconds |
| ------- | ------: | ------------------------: | ------------------------: |
| WETH    |  25.595 |             1,116,884,992 |                    23.926 |
| Factory |  23.979 |             1,132,994,560 |                    23.419 |
| Pool    |  24.589 |             1,141,415,936 |                    24.043 |

Runs are serial under the existing one-CPU quota, 4 GiB hard memory, unchanged
3 GiB early-stop, no swap and 192-task ceiling. Resource receipts, complete
producer replies, derived malformed input, launcher and runtime copies stay in
the private lab outside Git. Final cgroup counters disappear at scope teardown
and remain unknown; sampled zero events do not prove final no-OOM/no-limit
results. This is compatibility and recovery evidence, not a model-token,
whole-task latency or CPU saving claim.

Latest main `81cca2e0e3ebd98c21f41d7ad63d6a00e4cbc3f9` could not build during
setup: its shared partial-error handler passes three arguments to an interface
requiring four. Independently completed main CI at
`fdd8f826023c568937d237c2f97d855de283a9b8` reports the same TypeScript failure
([run 38309578208](https://github.com/morluto/rea/actions/runs/38309578208)).
The unrelated regression is recorded in the maintainer-requested private bug
handoff; this change does not repair it. The maintainer independently corrected
the producing caller in main `8fc2043eb8bcedbf34dce064f977e455438635d6`.
The frozen-runtime observations above remain pinned to their original revision;
synchronizing the branch does not relabel them as latest-main verification.

After rebasing, a fresh build and all 10 focused EVM MCP boundary tests pass.
The same unchanged source verifier also passes all three real Factory scenarios,
CLI parity, healthy SQLite WASM checks and final cleanup on the newly built
runtime `b3eadf147221a2fa997ac26667a183ca5bccb1f4` (parent is corrected main
`8fc2043eb8bcedbf34dce064f977e455438635d6`). Its `dist/`/`bridge/` file-table
SHA-256 is `7a4cec0fa4f7e929356b50a6b13472f80bd6f526221e427125370cca3ef98d00`.
This related rerun takes 24.285 seconds, samples 1,146,167,296 peak family bytes
and records 23.662 last-observed CPU seconds. The older failed build and earlier
cohort receipts are preserved; wider domain/model matrices are not repeated.

Static composition continues to bind one named canonical contract and one
typed factory. Existing SDK checks reject duplicate registration before use
and reject malformed inputs before invoking the provider. Producer contract
violations are detected when the producer returns a result; they cannot be
validated in advance without that result. A dynamic third-party module ABI
preflight is not implemented or claimed. The corresponding broader acceptance
item remains open rather than creating the deferred generic plugin registry.

## Final launcher review

A missing gate marker while gating is disabled cannot establish absence of a
new launch. The fixture now appends a launch record before starting the actual
worker; both permission-failure retries must leave that log byte-identical.
This independently verifies that retained cleanup failure stops a new EVM
launch, while preserving the original resource and healthy WASM peer.

Final verifier source SHA-256 is
`fc9a50e2e54e4c8eede4b8a19283e11ddaa1faadea52eebc390b55b5a1902668`.
All three related real Factory scenarios, CLI parity and final cleanup pass
again on the corrected-main runtime: 23.579 seconds, 1,163,685,888 peak sampled
family bytes and 23.110 last-observed CPU seconds. The earlier three-carrier
receipts remain pinned to their earlier source; wider artifacts/models are
not repeated for this review fix.

## Reproduction

Build and freeze the explicit source revision as documented in the measurement
README. Supply an object of explicit string-valued provider settings, including
the caller-installed WABT paths. As a non-root Linux x64 user, run under the
existing resource wrapper:

```bash
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/verify-evm-lifecycle.mjs \
  --runtime-root /absolute/frozen-runtime \
  --revision 67f817e3653efad35f7044e68fbd6f163b86864b \
  --path /absolute/UniswapV3Factory.runtime.hex \
  --peer-path /absolute/sqlite3.wasm \
  --providers /absolute/explicit-providers.json \
  --output /absolute/new-private-receipt-directory
```

The verifier checks the carrier and SQLite module against the committed corpus,
creates an owner-only receipt directory without overwriting existing receipts,
and acquires no dependencies. Preserve failed attempts separately. A shorter
reply or a successful cleanup verifier does not establish an agent-cost gain.
