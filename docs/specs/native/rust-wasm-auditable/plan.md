# Implementation plan

## Boundary and contract

`src/rust/RustWasmImage.ts` owns WebAssembly section framing: the preamble,
layer and version, section sizes read with the shared `readLeb128`,
custom-section names, the `.dep-v0` payload ranges and the data-section range. It reports failures through the
`ParseFailure` algebra with format `wasm`, and the section bound as a
`max_wasm_sections` decode limit.

`src/rust/RustBinaryImage.ts` builds one layout for either container: identity
facts, the dependency span and the spans searched for compiler paths. The
native layout comes from `readBinaryContainer`; the WebAssembly layout comes
from `RustWasmImage`. The dependency decoder, PE alignment allowance and rustc
path retention are shared and unchanged.

`src/domain/rust/rustBinary.ts` owns the report contract: `format` gains
`wasm`, and `bits` is explicitly `32 | 64 | null`. Null is valid only when
`format` is `wasm` and is not a number. Refinements bind `bits`,
`architecture`, `byte_order` and the dependency section name to the container.
`rustDependencySectionName` is the one owner of that name for the reader and
the schema. `metadataReportSubjectFormat` in
`src/domain/apple/machoTargetSelection.ts` maps a `wasm` report to the `file`
subject, and `requireMetadataReportSubject` accepts it, so the service, the
retained views and the CycloneDX view agree on one mapping.

`src/rust/RustBinaryProvider.ts` projects the section-bound limit with
`parseLimitConstraint` as a `cpu` constraint and a fixed work ceiling, and
names the searched compiler-path source in limitations.

## Incremental work and validation

1. Walk section framing with boundary tests over synthetic modules.
2. Read `.dep-v0` and data-section rustc paths through the shared layout, and
   widen the report contract.
3. Bound the section walk after review showed a 256 MiB module of three-byte
   sections kept the synchronous walk busy for seconds.
4. Map the Evidence subject once and run the retained-view workflow on a
   module.
5. Bind the remaining container facts in the report schema.
6. Update the guide, README rows, skill instructions, tool description and CLI
   help, then run focused tests, `check`, `docs:check` and the source group.

## Effects and compatibility

Output widening only: `format` gains `wasm` and `bits` is `32 | 64 | null`
on the report and its summary view. Null is admitted only for `wasm`
reports, which were previously refused. ELF, PE and Mach-O reports remain
32 or 64. No new tool, input, subprocess,
temporary file or network access. Native reports change only in limitation
wording.
