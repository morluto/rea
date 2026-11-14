# Tasks

- [x] Define Mach-O `LC_UUID` decoding, shared FAT slice validation, and CPU-scoped companion matching rules (`src/domain/machoDebugCompanion.ts`, `src/domain/machoDebugCompanion.test.ts`).
- [x] Implement bounded `.dSYM` bundle admission, refusal diagnostics, and cancellation/cleanup handle ownership at target resolution (`src/application/DebugCompanionAdmission.ts`, `tests/boundary/filesystem/targetDiagnostics.test.ts`, `tests/process-global/debugCompanionAdmissionFailures.test.ts`).
- [x] Expose optional `dsym_path` / `--dsym-path` across MCP `open_binary` and native CLI commands, and regenerate catalog projections.
- [x] Stage verified DWARF members into private Ghidra runtime roots, isolate `GhidraAnalysisProfile` and Program checkpoints, reject `REA_GHIDRA_PROJECT_PATH` pairing, and record `dsym` admission evidence (`src/ghidra/GhidraDebugCompanion.ts`, `src/ghidra/GhidraAnalysisProfile.ts`, `src/ghidra/GhidraProvider.behavior.test.ts`).
- [x] Author [provider documentation](../../../providers/dsym.md) and pass route, catalog, static, and deep verification gates.
