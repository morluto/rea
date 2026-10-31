# Offline EVM bytecode

`inspect_evm_interface` / `inspect-evm-interface` infers interface candidates
from one explicitly selected local bytecode carrier. The capability is general:
contract investigation, compatibility, audit and CTF showcases use the same
portable primitive. It does not require an active native binary target.

```sh
rea inspect-evm-interface ./runtime.hex hex --json
rea inspect-evm-interface ./runtime.bin raw --json
rea inspect-evm-interface ./compiler-output.json solc-json --source-unit contracts/Example.sol --contract-name Example --bytecode-kind deployed --json
```

```json
{
  "name": "inspect_evm_interface",
  "arguments": { "path": "/artifacts/runtime.hex", "encoding": "hex" }
}
```

Initial real verification covers flat legacy bytecode on Linux x64 and unchanged
bundled EVMole 0.9.3. EOF-style EF00 containers return `unsupported_target`,
with the selected path and format reason. Selected-path resolution errors
`ENOENT`, `ENOTDIR`, `ELOOP`, and `ENAMETOOLONG` are `invalid_request` path
issues. Permission, resource, cancellation, provider, and cleanup failures retain
their distinct classifications.
The host must already provide util-linux `prlimit`, normally `/usr/bin/prlimit`;
`REA_EVM_PRLIMIT_COMMAND` can select another absolute executable. REA installs
no system tools and changes no user configuration. [Upstream provenance and
license](https://github.com/morluto/rea/blob/main/third_party/evmole/README.md) are packaged.

## Evidence semantics

- `encoding` is required: `"raw"`, `"hex"`, or an exact compiler-selection object
  with `kind: "solc-json"`. Hex permits an optional `0x` prefix and
  outer ASCII whitespace. Odd hex, interior separators, BOM, non-ASCII whitespace
  and invalid UTF-8 are rejected. Empty bytecode is valid and has unknown coverage.
- Carrier SHA-256 identifies the exact original file, including prefix/casing
  and whitespace. Decoded-byte SHA-256 identifies actual selected EVM bytes.
  Neither digest is the Ethereum Keccak code hash.
- Full bytecode, upstream function offsets and original producer representation
  are returned inline by default. Offsets are byte positions in decoded bytecode.
- Upstream also returns terminal metadata during selector recovery. Its reported
  values remain in `raw_result`; integer precision and non-text-key coverage are
  unknown in the JS binding. Full bytecode retains the original encoded metadata.
- `bytecode.metadata` independently interprets a plausible terminal CBOR root
  map from the selected bytes. Integers use decimal strings; byte strings use hex,
  and scalar keys retain their types. The recorded offset/length addresses the
  original bytecode, so summary delivery does not copy an opaque CBOR payload.
  Nested containers have partial scalar coverage; map keys are still checked for
  duplicates throughout nested maps and arrays. Unsupported or malformed
  candidates report `not-decoded` with a diagnostic. Decoding is bounded to 64
  container levels and the terminal payload's encoded size.
- An unavailable trailer does not prove metadata absence or Solidity origin.
  Compiler-version bytes/text are metadata declarations, not verified compiler,
  source-file or deployed-contract identity. Historical omission parses as a null
  unknown facet without changing the original Evidence record. Metadata/source
  URLs are not fetched.
- Selectors, argument strings and state mutability are **inferences**. Function
  names/signatures are not looked up. Optimized code may produce different
  mutability candidates; recovered types are not a verified source ABI.
- Raw/hex runtime/init-code identity remains unknown. Compiler selection records
  creation/deployed kind from the selected artifact; it does not establish deployment.
  Deployed authenticity, hardfork and discovery completeness remain unknown.
  Empty candidates do not prove no callable interface.
- Analysis is offline: no target runtime execution, implicit chain/RPC/explorer
  lookup, wallet action, transaction broadcast or network request.

## Exact Solidity compiler artifacts

Select an existing solc Standard JSON output with:

```json
{
  "path": "/artifacts/compiler-output.json",
  "encoding": {
    "kind": "solc-json",
    "source_unit": "contracts/Example.sol",
    "contract_name": "Example",
    "bytecode_kind": "deployed"
  }
}
```

All three selection identities are required within `encoding`;
use `creation` to select `evm.bytecode`, or `deployed` for `evm.deployedBytecode`.
Source-unit keys are exact compiler identities, not filesystem paths. REA does
not match basenames, choose another contract or run a compiler. Selection is
invalid with raw/hex encoding. The CLI uses positional `solc-json` with
`--source-unit`, `--contract-name` and `--bytecode-kind` as shown above.

`compiler_artifact` retains the exact source/contract identities, selected bytecode JSON pointer and
contract/bytecode/object source ranges, exact object text, diagnostics, link/immutable references and
recorded metadata. Ranges count UTF-16 code units in the UTF-8-decoded JSON text
and include JSON syntax. Duplicate properties, malformed objects and invalid
reference spans fail precisely. Recorded compiler/settings metadata remains
unauthenticated; source paths and URLs do not trigger reads or acquisition.

Concrete selected hex enters the existing EVMole inference engine. Missing
objects and unresolved library placeholders retain compiler evidence with
`inference_status: "unavailable"`, null decoded hex/digest and an unknown byte
count when absent. REA does not substitute library addresses. Compiler errors
and warnings remain visible alongside selected bytecode or unavailable inference.
Legacy fixed-width placeholders retain opaque source-qualified names, including
absolute, relative and package source prefixes; REA does not resolve those names.
Their width and bytecode offsets use UTF-8 bytes; JSON source coordinates remain
UTF-16 code units, including when source names contain Unicode.

## Selected interface delivery and retained views

Existing CLI calls and MCP calls with omitted or `complete` detail keep the
complete inline result. On a retaining MCP server, select `detail: "summary"`
when the question needs every inferred function and its identity/uncertainty,
without bytecode text or duplicated raw stdout:

```json
{
  "name": "inspect_evm_interface",
  "arguments": {
    "path": "/artifacts/runtime.hex",
    "encoding": "hex",
    "detail": "summary"
  }
}
```

The result is distinct view Evidence linked to its complete parent. Like the
parent, it has `confidence: inferred`; projection never strengthens inferred
candidates. Its `normalized_result.summary` preserves every producer-returned
selector, decoded
byte offset, dispatch, argument/mutability string including null, carrier/decoded
identities, original limitations and explicit unknowns. Payload `evidence_kind`
remains `inferred`. It preserves stderr/truncation and records stdout text length.
Complete-within-view coverage covers returned candidates; discovery completeness
remains unknown even for an empty or exhausted collection. Analysis still runs;
delivery selection does not save interpreter work or change source parameters.
Compiler-artifact summaries retain exact selection, diagnostics and reference
facts. They omit the object bytecode text and raw metadata text, recording
`object_code_units` and metadata `raw_code_units` instead (null means absent).
Parsed compiler version/settings and metadata parse status remain visible.
Access exact omitted source fields from the complete parent Evidence through the
normal ledger/export workflow using `parent_evidence_id`; views do not reacquire
or reinterpret the compiler output. When inference is unavailable, summary/function coverage is `unknown`,
with null total/exhaustion; an empty candidate list does not establish zero
functions. A `bytecode_hex` page returns a typed input error when decoded bytes
are unavailable.

Use `normalized_result.parent_evidence_id` with `inspect_analysis_view` source
kind `retained-evidence`. EVM view kind `evm` pages `functions` by original row
order, or `bytecode_hex`, `stdout`, `stderr` by UTF-16 code units. Hex pages preserve
the original lowercase text without a prefix; two characters represent one decoded
byte. A text-page offset differs from a function's decoded-byte offset. Complete
parent Evidence remains accessible through the normal ledger/export workflow;
reading views does not rerun analysis or change its identity. Existing record
retention and close semantics are unchanged.

Portable historical complete EVM Evidence can use source kind `inline` without
a provider. A fixed server without Evidence retention rejects selected summary
delivery before starting analysis and continues to support complete delivery.
Discover the actual advertised schema before sending `detail` to an older server;
use its complete operation when an equivalent workflow is required. The one-shot
CLI keeps its existing complete result.

## Resource and lifecycle limits

Compiler JSON is preflighted to 128 nesting levels and 65,536 AST nodes before
recursive tree allocation. A conservative 512-byte node estimate reserves about
32 MiB per tree within the worker heap; this is an allocation estimate, not a
measured memory guarantee. Oversized nested metadata keeps its raw text with
`resource-limited` parse status and unknown compiler/settings. Recorded compiler
diagnostics survive selection and downstream inference failures under
`details.diagnostics.compiler_diagnostics`, bound to the original carrier digest
and exact selection.
Reply encoding accounts for repeated reference names and escaped UTF-8 JSON in
bounded parts before allocating a complete reply. Reply-budget failures retain
the carrier identity, exact selection and compiler diagnostics when they fit.
If diagnostics alone exceed the reply budget, the failure explicitly reports
`compiler_diagnostics_omitted: "reply-budget"`.

Inputs are limited to 4 MiB, complete replies to 16 MiB and combined diagnostic
output to 1 MiB. An owned worker has a 256 MiB JavaScript heap; its profile
maxima are 3 GiB virtual address space and 30 CPU seconds, with tighter inherited
limits retained. The worker command deadline is
`timeout_ms` (default 30000 ms, integer 1 through 2147483647) on the next call,
or `--timeout-ms` on `rea inspect-evm-interface`. Omission keeps 30000 ms.
Those byte, address-space, and CPU ceilings have no runtime override, and
`timeout_ms` does not raise them. An oversized selected carrier returns a
non-retryable `resource_constraint` with resource `file-size` and its fixed
input allowance in `reported_limits.maximum_input_bytes`.
Complete-reply allowance refusals use the same non-retryable resource family,
with `reported_limits.maximum_reply_bytes`; malformed JSON remains unreadable
output. This refusal leaves no complete report to retrieve through another
delivery channel. Virtual address space differs from resident memory. The worker retains inherited tighter
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

Proxy resolution, storage/CFG and fork-explicit execution/traces
remain separate increments under #972, with materially different result or
execution authority. This primitive makes no deployment or runtime behavior claim.

The real verification lane traces representative raw/hex CLI workflows and checks
that only declared Node/prlimit launchers and process ownership inspection run.
Socket traces permit local stdio socket pairs and reject attempted network requests.
These observations verify those fixtures; they are not a general network sandbox.

For the independent metadata parser, `npm run verify:solidity:metadata` uses an
existing caller-selected solc 0.8.30 module:

```sh
REA_VERIFY_SOLC_MODULE=/absolute/path/to/solc/index.js npm run verify:solidity:metadata
```

It compiles the owned fixture with unoptimized, viaIR, content-hash-free and
CBOR-free settings, verifies the observed trailer facts and reports local decode
timings. No contract is executed. This lane does not establish the complete
Linux EVM provider's CLI/MCP, resource-limit or cleanup behavior.
Verify compiler-artifact selection through actual CLI and stdio MCP with an
owned solc 0.8.30 fixture:

```bash
REA_VERIFY_SOLC_MODULE=/absolute/path/to/solc/index.js npm run verify:solc:artifacts
```

The verifier compiles its source-owned fixture only; the inspection operation
never invokes a compiler. It checks exact source/contract/kind selection,
raw/hex engine equivalence, original JSON coordinates, diagnostics, unlinked and
absent objects, converted advertised schemas, summary retention and cleanup.
