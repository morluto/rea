# UEFI Firmware Decompilation Implementation Plan

## Architecture & Integration

1. **Domain Models & Contracts (`src/domain/uefi/`, `src/contracts/uefi/`)**:
   - Define `decompile_uefi_firmware` input schema: absolute path, absent output directory, max_modules (1..2000), include_disassembly, filter_phase.
   - Define result schema: `parser`, `image_sha256`, `output_directory`, `total_modules_found`, `total_modules_decompiled`, phase counts, structured module list (`c_file`, `asm_file`, `header_file`, relative paths, `disassembly_status`), `diagnostics`, `limitations`.
   - Tool contracts declare explicit effects: `mutatesSession: true`, `writesFilesystem: true`, `launchesProcess: true`, `idempotent: false`.

2. **Provider Implementation (`src/uefi/UefiAnalysisProvider.ts`)**:
   - Unified `DiscoveredUefiModule` pipeline supporting both flash images and extracted directory trees.
   - Bounded directory sniffing: `stat.size` check (< 32 MiB) + 64-byte `OwnedFileHandle` magic read.
   - `SafeOutputTree` publication via `publishUefiFiles`: exclusive directory creation, staged publication entries, transactional rollback on cleanup errors.
   - Supervised execution for disassembly (`llvm-objdump` / `objdump`) with `stopSignal: "SIGTERM"`, individual 2 MiB ceiling, and aggregate 64 MiB ceiling.
   - Integrated Ghidra headless decompiler bridge (`bridge/ghidra/ReaDecompileToC.java`) with automatic fallback to typed scaffolding.

3. **Documentation & Tests**:
   - Guide documentation in `docs/guides/firmware/firmware-analysis.md`.
   - Regression suite in `src/uefi/UefiAnalysisProvider.test.ts` covering image decompilation, directory decompilation, phase filtering, duplicate disambiguation, output collision rejection, and `max_modules` capping.
