# IL2CPP method linking for Unity WebGL (wasm32)

## Problem and outcome

`inspect_il2cpp_metadata` linked method addresses only from 64-bit Mach-O, PE
and ELF binaries. A Unity WebGL build ships its IL2CPP code as a wasm32 module
(`Build/*.wasm`), so its methods stayed unlinked. Accept an uncompressed wasm32
module as `binary_path` and link each metadata method to its function table 0
slot and the module function that slot holds, without executing the module.

## Requirements

- Recognize a wasm32 module by its magic and open it as one image at
  four-byte pointer width; `binary.format` is `wasm`, `architecture` `wasm32`
  and `image_base` `0x0`.
- Rebuild initial linear memory from active data segments with `i32.const`
  offsets: mapped from the lowest segment start to the highest end, with the
  rest of the initial memory as zero fill. Bytes below the lowest segment stay
  unmapped.
- Report a linked code row with `address` and `rva` null, `table_index` (the
  table 0 slot) and `function_index` (the function the slot holds, counting
  imports). A slot naming an imported function is `unknown`; a slot that no
  active element segment fills is refused.
- Refuse, as `unsupported-container`: compressed modules (gzip named as
  compressed), imported memory or function table, passive or explicit-memory
  data segments, non-constant offsets, shared or 64-bit memory, non-funcref
  tables, several memories or tables. Refuse reordered or repeated sections as
  malformed. Refuse `binary_architecture`, `generic_instances` and Ghidra seeds
  for a module.
- Bound the work: module bytes and the rebuilt view share one 1 GiB
  allowance, added zero bytes are limited to 64 MiB (`wasm-memory-capacity`),
  and parser count caps refuse as `wasm-module-capacity`.

## Acceptance

Unit and boundary tests cover module reading, memory reconstruction, slot to
function linking, each refusal and both capacity reasons, the report schema
and paging of wasm rows. The guide records a manual check on two uncompressed
Unity 2022.3.62f3 WebGL builds (metadata version 31) against Il2CppDumper.

## Non-goals

Compressed builds, extracting `global-metadata.dat` from `Build/*.data`,
generic method instances, Ghidra seeds for wasm, other Unity or Emscripten
versions, and executing or instantiating the module.
