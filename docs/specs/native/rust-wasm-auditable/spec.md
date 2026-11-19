# Rust dependency metadata in WebAssembly modules

## Problem and outcome

`cargo auditable build` for a `wasm32` target stores the same zlib-compressed
`.dep-v0` JSON that native builds carry, in a WebAssembly custom section.
`inspect_rust_binary` and `inspect-rust-binary` recognized only ELF, PE and
Mach-O containers, so every `.wasm` input was refused as an unsupported target
and an agent could not read a module's embedded crate list.

This feature lets the existing tool and command read that list from a
WebAssembly core module. It adds no tool, command or input.

[Rust binary dependency metadata](../../../rust-binaries.md#webassembly-modules)
describes the current behavior and limitations. This directory is the feature
specification, implementation plan and task list. The guide does not replace
these files.

This record was written on 2026-11-17, during review, after the repository
adopted feature records. The requirements restate the contract the
implementation already had; no earlier plan is reconstructed.

## Requirements

1. The module is a local file read through the stable artifact read. It is not
   validated, instantiated or executed. Only section framing is walked.
2. A version 1 core module is accepted. A component (layer 1) and any other
   module version are unsupported targets, because a component embeds several
   core modules and no input selects one.
3. A custom section named `.dep-v0` supplies the dependency list, and the
   report's `section_name` is `.dep-v0`; the report schema binds each
   container to its section name. `file_offset` and `section_bytes` locate the
   payload after the section name, in the original file. A second `.dep-v0`
   section is malformed; the walk ends there, so a later failure such as the
   section bound does not replace it.
4. A missing `.dep-v0` section is null metadata with a limitation. It is not
   evidence that the module has no dependencies.
5. `format` and `architecture` are `wasm` and `byte_order` is `little`.
   `bits` is `32 | 64 | null`, and is `null` for this container because
   WebAssembly declares no container word size and memory address types are
   not inspected. Null is not a number and must not be coerced. ELF, PE and
   Mach-O reports stay 32 or 64. The report schema, its field description and
   the summary view refuse any report that combines these facts differently.
6. The rustc commit is inferred from `/rustc/<40-hex>/` paths in the module's
   data section. Limitations name that source. A second data section is
   malformed.
7. A header, section or section size that ends past the file is truncated. A
   size or name length that does not fit a 32-bit LEB128 integer, a
   custom-section name or name length that extends past its section, and a
   name that is not UTF-8 are malformed. Integers are decoded by the shared
   LEB128 reader.
8. The section walk stops after 65,536 sections with a `cpu` resource
   constraint. The format sets no section count and the walk is synchronous.
   The allowance is fixed; `producer_limits` does not raise it. Retained state
   is at most two `.dep-v0` ranges and one data-section range.
9. The Evidence subject format is `file`, as for `inspect_wasm_artifact`, with
   no architecture. Retained summaries, package and edge pages and the
   CycloneDX view accept a WebAssembly parent.
10. `architecture` on a module is rejected, as on any image that is not a
    universal Mach-O.
11. ELF, PE and Mach-O reports are unchanged apart from limitation wording
    that names where compiler paths were searched.

## Acceptance

- Boundary tests cover a module with and without `.dep-v0`, each refusal in
  requirements 2, 3, 6 and 7 by failure kind, format, offset and field, and
  the section bound at 65,536 and 65,537 sections.
- CLI acceptance covers a module report, its `file` subject and the component
  refusal. The retained-view acceptance workflow runs on a module.
- MCP boundary tests validate a module report against the advertised output
  schema and check the section-bound refusal through the public error
  contract.
- A view test refuses imported reports whose container facts contradict
  requirements 3 and 5.

## Non-goals

- Reading a component's embedded core modules.
- Validating, instantiating or executing a module.
- Decoding memory address types or any section other than the framing, the
  `.dep-v0` payload and the data-section byte range.
