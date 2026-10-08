# Offline EVM bytecode

`inspect_evm_interface` / `inspect-evm-interface` infers interface candidates
from one explicitly selected local bytecode carrier. The capability is general:
contract investigation, compatibility, audit and CTF showcases use the same
portable primitive. It does not require an active native binary target.

```sh
rea inspect-evm-interface ./runtime.hex hex --json
rea inspect-evm-interface ./runtime.bin raw --json
```

```json
{
  "name": "inspect_evm_interface",
  "arguments": { "path": "/artifacts/runtime.hex", "encoding": "hex" }
}
```

Initial real verification covers flat legacy bytecode on Linux x64 and unchanged
bundled EVMole 0.9.3. EOF-style EF00 containers are explicitly unsupported.
The host must already provide util-linux `prlimit`, normally `/usr/bin/prlimit`;
`REA_EVM_PRLIMIT_COMMAND` can select another absolute executable. REA installs
no system tools and changes no user configuration. [Upstream provenance and
license](../third_party/evmole/README.md) are packaged.

## Evidence semantics

- `encoding` is required: raw bytes or UTF-8 hex, with optional `0x` prefix and
  outer ASCII whitespace. Odd hex, interior separators, BOM, non-ASCII whitespace
  and invalid UTF-8 are rejected. Empty bytecode is valid and has unknown coverage.
- Carrier SHA-256 identifies the exact original file, including prefix/casing
  and whitespace. Decoded-byte SHA-256 identifies actual selected EVM bytes.
  Neither digest is the Ethereum Keccak code hash.
- Full bytecode, upstream function offsets and original producer representation
  are returned inline. Offsets are byte positions in decoded bytecode.
- Upstream also returns terminal metadata during selector recovery. Its reported
  values remain in `raw_result`; integer precision and non-text-key coverage are
  unknown in the JS binding. Full bytecode retains the original encoded metadata.
- Selectors, argument strings and state mutability are **inferences**. Function
  names/signatures are not looked up. Optimized code may produce different
  mutability candidates; recovered types are not a verified source ABI.
- Runtime/init-code identity, deployed authenticity, hardfork and discovery
  completeness remain unknown. Empty candidates do not prove no callable interface.
- Analysis is offline: no target runtime execution, implicit chain/RPC/explorer
  lookup, wallet action, transaction broadcast or network request.

## Resource and lifecycle limits

Inputs are limited to 4 MiB, complete replies to 16 MiB and combined diagnostic
output to 1 MiB. An owned worker has a 256 MiB JavaScript heap, 3 GiB virtual
address-space limit, 30 CPU seconds and a 30-second command deadline. Virtual
address space differs from resident memory. The worker retains inherited tighter
soft/hard limits, reports its configured soft limits inline and leaves hard limits
unchanged. WASM trap reservations are disabled
so the engine can run within that virtual limit; actual memory is not equated to
its 3 GiB allowance. Limits fail without partial success. Stable snapshots,
private files and owned processes are cleaned independently of caller cancellation.
Invalid-input, unsupported, cancellation, timeout and malformed-reply failures
retain bounded stdout/stderr under `details.captured_output`, including whether
diagnostic output was truncated. Cleanup failures preserve the
original error projection and any captured output.
Successful results expose `diagnostics.truncated` from the supervisor as well.
Excess diagnostic output fails the complete-output contract even when the worker
has written a valid reply.
SIGXCPU retains a CPU resource diagnostic and CPU-specific guidance. Observed
file-size write failures (EFBIG) and SIGXFSZ likewise retain a file-size resource
diagnostic. Exact signal/write causes remain unknown. Configured
soft limits are reported separately from unknown effective limits; the received
signal alone does not establish its exact cause.
Reserved file-size exits require a matching private marker written by the
worker's EFBIG branch. Bare launcher exits or unwritable markers retain process
diagnostics with the resource cause unverified.

Source/metadata, proxy resolution, storage/CFG and fork-explicit execution/traces
remain separate increments under #972, with materially different result or
execution authority. This primitive makes no deployment or runtime behavior claim.

The real verification lane traces representative raw/hex CLI workflows and checks
that only declared Node/prlimit launchers and process ownership inspection run.
Socket traces permit local stdio socket pairs and reject attempted network requests.
These observations verify those fixtures; they are not a general network sandbox.
