# Source-built conformance fixtures

These sources are deliberately small semantic oracles for REA providers. Run
`npm run verify:fixtures` on macOS or Linux to compile them into the ignored
`build/conformance/` directory, emit a hash-and-toolchain manifest, and verify
their platform-native symbols and strings with local command-line tools. The
portable C, version, and large-inventory fixtures build as Mach-O on macOS and
ELF on Linux; Objective-C, Swift, and N-API-like fixtures remain macOS-only.

Only source files are versioned. Generated binaries, generated large-fixture
source, debug information, and manifests must remain under `build/`.

`ghidra/inventory.c` is also compiled into temporary Linux ELF debug and
stripped variants by `npm run verify:ghidra`. It fixes local functions, external
`puts` linkage, defined strings, and writable/executable memory needed to prove
the read-only Ghidra inventory contracts without committing a binary.

`scripts/create-ghidra-windows-fixture.mjs` separately emits a deterministic,
ignored native x86-64 PE application for the controlled Windows Ghidra P0 lane,
plus x86 application and x86/x86-64 DLL variants. Each DLL has no entry routine
and exports a callee returning 42 and a caller adding one. The generator and
fixed SHA-256 are versioned; the `.exe` and `.dll` files are never committed or
executed. `npm run verify:ghidra:windows` uses it to prove all 19 operations,
digest linkage, transport, and cleanup on the self-hosted real-Ghidra runner.

The C fixture fixes a known call chain and strings. The version pair fixes an
added symbol, changed string, and changed call relationship. The generated
large fixture contains 1,205 uniquely named functions and strings to verify that
providers return complete inventories. Objective-C, Swift, and N-API-like
fixtures provide metadata-oriented inputs without package
or network dependencies.

`readiness/` adds source-only generated JavaScript CLI and Electron fixtures for
the repository's reconstruction-readiness verifier. `npm run verify:readiness`
combines them with the compiled native fixtures, exercises CLI and MCP parity
for real analysis operations, and checks the internal machine-readable report
documented in `docs/reconstruction-readiness.md`.
