# Source-built conformance fixtures

These sources are deliberately small semantic oracles for REA providers. Run
`npm run verify:fixtures` on macOS to compile them into the ignored
`build/conformance/` directory, emit a hash-and-toolchain manifest, and verify
their Mach-O symbols and strings with native command-line tools.

Only source files are versioned. Generated binaries, generated large-fixture
source, debug information, and manifests must remain under `build/`.

The C fixture fixes a known call chain and strings. The version pair fixes an
added symbol, changed string, and changed call relationship. The generated
large fixture contains 1,205 uniquely named functions and strings so provider
pagination can be checked at boundaries of 500, 1,000, and 1,205. Objective-C,
Swift, and N-API-like fixtures provide metadata-oriented inputs without package
or network dependencies.
