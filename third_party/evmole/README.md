# EVM interface upstream profile

REA integrates unchanged [EVMole](https://github.com/cdump/evmole) as the exact
npm dependency `evmole@0.10.1`, with lockfile integrity verification. Its upstream
release tag `0.10.1` points to commit [`763f298`](https://github.com/cdump/evmole/commit/763f2984f6be5ea33636336e804022c75318a260).

The JavaScript binding and WASM engine remain in the original upstream package;
REA contains only carrier validation, a worker adapter and portable contracts.
No submodule or vendored engine fork is required. No signature database,
LLM decompiler, blockchain node or RPC dependency is acquired.

Upstream is MIT, copyright (c) 2023 Maxim Andreev. Its npm tarball includes the
same [LICENSE](LICENSE) as the upstream release commit.
The engine is initialized through the upstream `no_tla`/`initSync` interface
only inside an owned worker; importing REA services performs no WASM/file I/O.

Initial interface analysis uses `contractInfo` with selectors, arguments and
stateMutability enabled. Selector recovery also extracts/reports terminal metadata;
its reported representation is retained with explicit unknown precision/coverage.
Other upstream outputs are separate future contracts;
in particular, CFG destination IDs are not byte addresses and terminal CBOR
metadata cannot establish a lossless integer claim through the current binding.
