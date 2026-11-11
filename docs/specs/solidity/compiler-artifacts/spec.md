# Exact Solidity compiler artifact selection

Issue: [#2389](https://github.com/morluto/rea/issues/2389).

## Analyst question

Which exact creation or deployed bytecode object did this recorded solc Standard
JSON output supply for my selected source unit and contract, and what interface
candidates can REA recover from those bytes?

## Contract

Extend `inspect_evm_interface` with `encoding` equal to `raw`, `hex`, or a
self-contained object `{kind: "solc-json", source_unit, contract_name,
bytecode_kind}`. Compiler kind is `creation` or `deployed`, and every compiler
selector is required by both the advertised schema and the handler. The CLI
uses positional encoding `solc-json` with `--source-unit`, `--contract-name` and
`--bytecode-kind`. Raw and hex inputs keep their current defaults and result
fields; compiler-selection CLI options are invalid with those encodings.
Source-unit keys are opaque compiler identities, not filesystem paths; basename
matching and implicit contract selection are not supported.

The selected object is `contracts[source_unit][contract_name].evm.bytecode` or
`evm.deployedBytecode`. Preserve the original file digest, JSON pointer, selected
contract/bytecode/object source ranges, exact object text, compiler diagnostics,
linkReferences, immutableReferences, and recorded selected-contract metadata.
Ranges count UTF-16 code units in the strictly decoded UTF-8 JSON text and include
JSON syntax. Pointer segments use RFC 6901 escaping. Duplicate properties and
malformed JSON fail before selection, including duplicate contract identities.
Unknown diagnostic/metadata values remain accessible as exact JSON text; omitted
facets remain unknown rather than empty. Recorded compiler/settings metadata is
not independently authenticated or evidence of deployment.

Concrete hex objects enter the existing unchanged EVMole inference engine.
Creation/deployed kind is a recorded compiler-artifact fact. Missing objects or
fixed-width unresolved link placeholders return compiler evidence with unavailable
interface inference, null decoded hex/digest (and null byte count when absent),
and explicit limitations. No addresses are substituted and no placeholders are
zeroed. Malformed object representations and invalid reference spans fail
precisely. Missing selections and contracts fail without basename fallback.
Compiler diagnostics are retained when present even alongside selected bytes.

Summary delivery retains compiler selection and availability facts; complete
Evidence retains exact source text/object and diagnostics. Unavailable inference
must not produce a complete empty-function claim. Historical raw/hex Evidence
continues to parse unchanged.

## Authority and resources

Only the explicitly selected local output file is read. No compiler, source URL,
RPC, filesystem import resolver, wallet or chain execution is invoked. Use the
existing owned EVM worker, cancellation, 4 MiB input, 16 MiB reply, 256 MiB heap,
30-second deadline and inherited process resource limits. Bound JSON nesting
before recursive tree allocation: 128 levels and 65,536 AST nodes. The node
budget uses a conservative allocation estimate of 512 bytes per node (32 MiB
per tree), leaving room within the worker heap for source text, metadata and
inference. This estimate is not a measured process-memory guarantee. Nested
metadata that exceeds those limits remains recorded with `resource-limited`
parse status; it is not reported as malformed JSON. Account for retained syntax
and representation expansion. Encode replies in bounded UTF-8 parts, admitting
each part before retaining it and joining only replies within the 16 MiB budget.
Count repeated reference identities at every serialized occurrence. Capacity
failures retain the carrier digest and compiler diagnostics within the same
budget; explicitly report diagnostics omitted for reply capacity. A new provider
or target execution is outside this feature.

## Acceptance

- Own solc 0.8.30 multi-contract fixtures select creation/deployed objects exactly.
- Preserve warnings/errors, metadata, link/immutable references and unlinked text.
- Test escaped/Unicode identities, duplicate members, absent objects, ambiguous
  basename requests, malformed JSON, invalid spans and numeric precision.
- Verify concrete engine output against an independently selected raw/hex object.
- Verify actual compiled CLI and stdio MCP selection/provenance and converted
  advertised schemas, summary/readback, cancellation and unchanged raw/hex calls.
- Report fixture/compiler/provider versions and unavailable host coverage.

Primary format reference:
[Solidity Standard JSON](https://docs.soliditylang.org/en/v0.8.30/using-the-compiler.html#compiler-input-and-output-json-description).
