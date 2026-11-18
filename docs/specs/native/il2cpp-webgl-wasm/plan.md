# Implementation plan

## Boundary and contract

`src/wasm/WasmModuleImage.ts` reads the module sections IL2CPP needs (import,
function, table, memory, element, code counts, data) and rebuilds initial
linear memory. Failures are `WasmModuleFailure`, a `ParseFailureError` from
`src/domain/parseFailure.ts`: `malformed`, `unsupported`, or `limit` naming the
exceeded `WASM_MODULE_LIMITS` entry and its unit. LEB128 integers go through
the shared `readLeb128` (`src/domain/leb128.ts`), and fixed-width reads through
`BinaryReader`.

`src/il2cpp/Il2cppBinaryImage.ts` opens a module as a `NativeImage` with
`pointerSize: 4` and a `wasmTable`, and maps module failures onto
`Il2cppBinaryFormatFailure` reasons. Slice selection (`requireIl2cppBinaryImage`)
runs first, so `binary_architecture` on a module is an input error.
`Il2cppMetadataProvider` names the wasm allowances in resource refusals. The
il2cpp to wasm import is declared in `scripts/lib/module-layers.mjs`.

## Limits

| Limit                    | Value  | Refusal                |
| ------------------------ | ------ | ---------------------- |
| Input bytes              | 1 GiB  | `wasm-module-capacity` |
| Data or element segments | 2^18   | `wasm-module-capacity` |
| Table slots              | 2^21   | `wasm-module-capacity` |
| Module plus view bytes   | 1 GiB  | `wasm-memory-capacity` |
| Added zero bytes         | 64 MiB | `wasm-memory-capacity` |

## Effects and compatibility

Additive: the report schema gains `wasm` binaries and wasm method rows; native
reports are unchanged. No external tools or module execution.
