# WABT producer fixtures

`module.wat` is source-owned. WABT 1.0.42 `wat2wasm module.wat -o module.wasm`
produced the binary used for `wasm-objdump -h -x module.wasm` (`objdump.txt`) and
`wasm2wat --enable-all module.wasm` (`decoded.wat`). No binary is checked in.
The module has an imported function, exported memory/function and a `test`
custom section. The custom payload is retained as an `@custom` annotation in decoded WAT.

Upstream tag commit: `ff0ef7e0009402740c805a9744c09b05be063e48`.
The separate real-tool verifier generates its own fixtures with caller-supplied
WABT and compares exact producer output against the public CLI/MCP surfaces.
