# EVM descriptor and real-template checkpoint

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the native
checkpoint merged. The internal descriptor binds the existing exact EVM
contract, CLI name and typed service lifetime. Existing complete inputs, output,
provider selection and cleanup remain the baseline. Wiring alone does not establish
token or latency savings.

The descriptor contains only the named contract, existing CLI name and existing
factory. The legacy `createEvmInterfaceService` export remains usable. The MCP
host selects one complete service instance, preserves injection identity, passes
that same instance to registration and retains it for cleanup/retry. No bound
service wrapper, generic registry, automatic dependency acquisition or new pack
selection is introduced.

Five actual in-memory SDK boundary scenarios verify converted schemas, duplicate
registration rejection before use, malformed inputs, explicit unavailable or
incompatible-output failures with a healthy WASM peer, cleanup retry, and request
cancellation followed by recovery. Their injected ports are recording seams, not
real EVMole/WABT claims. Nine service and 26 provider-boundary cases also pass;
two unsupported-host scenarios are skipped on this Linux host. The existing seven
WASM MCP scenarios pass. Full `npm run check` passes; its approximately 3 GiB
sampled peak and `memory.high` events are excluded from performance claims.
Candidate real-artifact/catalog and model observations are recorded below.

## Public inputs and independent checks

[corpus.json](corpus.json) retains the original WETH historical example and adds
Uniswap v3-core 1.0.1 Factory/Pool compiler runtime templates from the official npm
package. Archive integrity, exact regular member, compiler JSON, original carrier
and decoded-byte digests are pinned. The carrier is the original `deployedBytecode`
field plus one trailing LF. No placeholder is rewritten and no contract is executed.

These are compiler templates, not live deployed instances. Their published Hardhat
artifacts omit immutable-reference maps; that metadata remains explicitly unknown.
The recorded empty link-reference maps do not establish absence of immutables.
WETH remains a published historical RPC example, with unknown live authenticity.

Actual control CLI observations infer 7 Factory and 26 Pool functions. The
[independent verifier](verify-evm-template.mjs) hashes each canonical published ABI
signature with caller-supplied Ethereum Keccak and checks the complete ABI-dispatch
selector multiset against the original REA response. Both sets match. This does not
establish inferred argument/mutability equivalence, deployment authenticity or
runtime semantics; all producer unknowns remain visible.

## Latest-main control

Production control: `1770f38cfc6cbe87491d0de8b8730c305c5cf8ea`, Node 24.18.0,
npm 11.16.0, matching locked dependencies and unchanged EVMole 0.9.3.
The frozen `dist/`/`bridge/` file-table SHA-256 is
`7fd6c2c37b4e166df158ec29d48d31f3712b9b087d9807ee019ee997d06ea144`.
Measurement driver SHA-256 is
`f767c0c0232be1e11918e70e3197a6919680d16688076bef28d4320662f712f7`.
Each public SDK run validates the selected named advertised schema and verifies
original carrier and decoded identities, inference/unknown scope and unchanged
input bytes. All three runs return the same complete 2,420,709-byte catalog.

| Question                 | Inferred functions | SDK tool-result JSON bytes | First workflow seconds |
| ------------------------ | -----------------: | -------------------------: | ---------------------: |
| WETH historical carrier  |                 11 |                     26,760 |                 11.432 |
| Uniswap Factory template |                  7 |                    110,424 |                  3.628 |
| Uniswap Pool template    |                 26 |                    110,998 |                 11.211 |

These are initial observations, not paired performance conclusions or model-token
counts. Each workflow includes connection, complete catalog discovery and one
interface query. Full bytecode remains inline. Candidate/control repetitions must
use the same source driver, inputs, provider settings and Node/worker limits.

Preparation against earlier frozen main `b1bf4a70d44191348ca20a91a52fb663da4daed0`
also passed all 59 cases of the existing real CLI/MCP EVM verifier with privately
supplied solc 0.8.30 and strace 6.1. Those cases cover compiler configurations,
raw/hex identity, malformed/unsupported carriers, missing limiter and resource
constraints. Its measured scope took 233.1 seconds, sampled peak 1,192,730,624
bytes and last-observed CPU 181.018 seconds. This is a control, not candidate proof.

All heavy runs are serial under one CPU, 4 GiB hard memory/3 GiB early-stop, no swap
and bounded tasks. Final cgroup counters disappear at scope teardown and remain
unverified; last-observed zero limit events are not substituted for final counters.
Raw replies, tools, compiler artifacts and detailed receipts remain outside Git.

## Reproduction

Build and freeze each pinned runtime using the repository toolchain, then run
`measure.mjs --artifact uniswap-v3.factory.hex` or `uniswap-v3.pool.hex` with the
exact derived carrier, `--schemas selected`, explicit runtime/revision and a fresh
private output directory. Existing `weth.hex` answer fields and invocation remain
unchanged. The same common workflow verifies all three offline carriers.

Run `verify-evm-template.mjs` with `--artifact` selecting the corpus ID,
`--artifact-json` selecting its original published compiler JSON, `--evidence`
selecting the recorded CLI Evidence or SDK structured reply, `--keccak-module`
selecting the absolute `js-sha3/src/sha3.js` module from the private solc toolchain,
and `--output` selecting a new private receipt. It acquires no dependencies and
does not overwrite an existing receipt.

The [template model question](questions/evm-uniswap.txt) requires the same complete
inferred interface facts and explicit unknowns. An ABI-count match is not used as
a model grade.

## Candidate compatibility and real-provider verification

Candidate: `152984da771450048ee9d60db8a410994a125878`, frozen runtime file-table
SHA-256 `725563640c27eb50ddb6f977d2dfbe1bdaddf7e05c02897318bceaa36fa602d7`.
Two repetitions for each EVM input produce six passing paired fact/settings
comparisons with the same driver and explicit limits. Each report preserves both
original Evidence reference maps. The complete actual SDK catalog is byte-identical
on every pair, including order, names, descriptions, schemas and annotations;
catalog SHA-256 is
`8664e42fd5225645cfd910f440f731c67ac198d3d53aa85b5c485374c74cf603`.
Result byte counts remain unchanged. Candidate Factory/Pool selectors also match
the independent published ABI oracle.

| Question | Control seconds, repetitions 1 / 2 | Candidate seconds, repetitions 1 / 2 |
| -------- | ---------------------------------: | -----------------------------------: |
| Factory  |                      3.628 / 3.650 |                        3.708 / 3.605 |
| Pool     |                     11.211 / 3.591 |                        3.749 / 3.581 |
| WETH     |                     11.432 / 3.694 |                        3.572 / 3.677 |

First controls preceded wiring; each second pair ran candidate then control.
Every measurement starts a new MCP process; host cache/page state is not fully
controlled. Slower initial controls do not establish a descriptor speedup.
Second-pair latency and last-observed CPU are similar. Sampled EVM SDK family peaks
range from 510,255,104 to 527,622,144 bytes. No scope abort occurred; final counters
remain unknown, so these measurements are descriptive.

The candidate passes all 59 existing real CLI/MCP verifier cases with solc 0.8.30
and unchanged EVMole 0.9.3. Actual syscall traces report target execution and network
sockets absent for those scenarios, and the verifier reports no remaining
descendants. The scope took 177.456 seconds, sampled peak 1,237,020,672 bytes and
last-observed CPU 144.913 seconds. Different totals from the earlier control are
not attributed to unchanged provider algorithms.

Post-descriptor public MCP regression uses the original pinned shipped corpus:

| Domain / selected question                  | Actual provider / scope                            | Calls | Seconds |
| ------------------------------------------- | -------------------------------------------------- | ----: | ------: |
| SQLite WASM counts / exports                | WABT 1.0.42; selected summary and retained read    |     2 |   5.516 |
| ShareX managed metadata / native boundaries | Static PE/CLI, no assembly execution               |     2 |   3.710 |
| Obsidian manifest / inventory               | Complete inventory retained, no AST claim          |     4 |   5.376 |
| NewPipe package / MainActivity methods      | Real headless JADX 0.7.1                           |     3 |  21.669 |
| OpenWrt regions                             | Real firmware signature scan, no device execution  |     1 |   3.581 |
| jq native entry                             | Ghidra 12.1.4, default analysis, ephemeral Program |     4 | 270.986 |

All six workflows pass named SDK output validation and original digest checks;
input bytes remain unchanged. Maximum sampled family peak is 1,284,648,960 bytes.
They establish those available Linux workflows, not paired performance or
Windows/macOS, IDA/Hopper, Android-device, DOS COM, browser or JavaScript AST
behavior. Browser/AST were not repeated for this narrow migration.

## Real model complete-output calibration

Six serial Codex CLI 0.161.0 trials request `gpt-5.6-terra`, high reasoning, with
isolated temporary profiles pointing to the frozen candidate. Resolved server-side
model identity is not inferred. Only the EVM inspection tool is enabled, matching
the earlier WETH calibration; this is not full-catalog tool selection verification.
Every trial makes one successful call and no failed call.

| Trial     | Total input | Uncached input | Output | Seconds |
| --------- | ----------: | -------------: | -----: | ------: |
| Factory 1 |      66,158 |         36,974 |  1,329 |  43.483 |
| Pool 1    |      65,600 |         36,416 |  2,307 |  69.546 |
| WETH 1    |      54,700 |         25,516 |  1,144 |  56.372 |
| Factory 2 |      65,964 |         36,780 |  1,453 |  26.412 |
| Pool 2    |      65,753 |         36,569 |  1,939 |  74.706 |
| WETH 2    |      54,502 |         25,318 |  1,208 |  35.137 |

Every trial reports 29,184 cached input tokens. Selected fact/reference/lifecycle
grades all pass: original/decoded identities, every inferred selector, offset,
dispatch, argument/mutability string including null, explicit unknowns, no runtime
execution, observed Evidence references, unchanged bytes and removed profiles.
Raw transcripts and grades remain private. Sampled peaks are
594,853,888–776,335,360 bytes; last-observed CPU is 6.181–7.034 seconds. Strict
overall grades remain unverified because final resource counters are unknown;
they are not relabeled as wholly passing resource-qualified runs.

This calibrates the current complete path after compatible wiring, not a paired
model performance experiment. The next token experiment should answer the same
interface question through an explicitly selected precise view, retain full
bytecode/original Evidence under the existing lifetime, and preserve complete
defaults. Discover support before sending new options to an older server. Include
discovery, follow-up, failures and retries in the complete task cost.

## Static contract admission verification

The follow-up from main `c462a4ebd3a10e59253bcf38353a0914b176738b` tests the
pilot's actual static boundary, without adding a dynamic module registry or
changing production code. Complete-project TypeScript checking now verifies
that the inferred descriptor type rejects a WASM operation contract, a WASM
CLI command, a WASM service factory, an unrelated input schema and an unrelated
output schema. These are negative assignability assertions: their guarantee
comes from the compiler, not from executing an incompatible descriptor.
The existing named contract and CLI identity are also checked at runtime;
separate factory calls produce distinct service/provider owners. Invalid target
input remains an application error without launching a worker.

The actual public in-memory MCP SDK test additionally spies on the provider:
duplicate EVM registration throws the named `already registered` error before
any provider call. Converted input/output JSON Schemas validate before the
first valid operation. Invalid client arguments are rejected before execution;
incompatible provider reply data is validated **after** execution and is not
presented as a pre-use contract guarantee. Existing healthy-peer, cancellation,
retained summary/default and cleanup-retry scenarios remain covered.

Full project typecheck passes with the installed compiler's supported single
thread scheduling; it includes all source/test files. The two exact focused
files pass 12 runtime cases. The resource scopes sample 2,057,961,472 bytes for
typecheck and 2,426,290,176 bytes for required build plus focused tests, below the
unchanged 3 GiB early-stop/4 GiB hard ceiling. Final transient-cgroup counters
remain unknown. No new real-provider or performance improvement is claimed by
these compile/SDK checks; the earlier pinned real EVMole/WABT/lifecycle evidence
retains its original scope and source identity.

This proves the one statically composed descriptor's named/schema/factory
compatibility and duplicate-registration guard. It does not implement runtime
admission of arbitrary JavaScript descriptors, third-party plugin ABI/version
negotiation or a general plugin SDK. Those remain deferred by the original plan.
Existing callers, full defaults, provider inputs, owned lifetimes and output
identities are unchanged.
