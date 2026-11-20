# UEFI Firmware Decompilation (`decompile_uefi_firmware`)

## Problem and outcome

Analyzing complex UEFI flash images often requires extracting and decompiling hundreds
of executable PE32/TE modules across multiple initialization phases (SEC, PEI, DXE, SMM, APP).
Prior workflows required manual extraction and disjoint disassembler invocation without
coordinated provenance or structured output directories.

`decompile_uefi_firmware` introduces an end-to-end decompilation and source-code reconstruction
pipeline in REA for both complete UEFI flash images and pre-extracted directory trees:

- Traverses and maps firmware volumes and FFS files
- Identifies executable PE32/TE sections and module identities (GUID, Section 0x15 UI names)
- Enforces strict memory budgets (bounded directory discovery, 64-byte sniffing, 2 MiB per-module / 64 MiB aggregate disassembly ceilings)
- Generates C pseudocode (via headless Ghidra `CppExporter` when available, or typed C entry-point skeletons)
- Generates C interface headers (`.h`), native assembly (`.asm`), and raw binaries (`.efi`)
- Emits a structured `firmware_manifest.json` and a navigable, relative-linked `README.md` index
- Publishes all artifacts atomically through `SafeOutputTree` with exclusive directory creation and rollback

## Requirements

1. **Input Admission**:
   - Supports both flash images (`format: "file"`) and pre-extracted directories.
   - Enforces absolute path checks on both target `path` and `output_directory`.
   - Rejects pre-existing `output_directory` trees to prevent accidental data destruction.

2. **Resource & Memory Bounds**:
   - Directory mode utilizes bounded `stat` probes (capping individual binaries at 32 MiB) and 64-byte header sniffing via `OwnedFileHandle`.
   - Never loads entire directory file buffers into memory concurrently; binary payloads are read lazily during module staging.
   - Caps individual disassembly stdout captures to 2 MiB and aggregate staged disassembly to 64 MiB; excess modules are safely marked `disassembly_status: "omitted"`.
   - All external disassembler/decompiler child processes run under `stopSignal: "SIGTERM"` process-group supervision with abort signal propagation.

3. **Source Reconstruction & Decompilation**:
   - When a local Ghidra installation is present (`GHIDRA_INSTALL_DIR`), executes headless Ghidra with `ReaDecompileToC.java` (`CppExporter`) to recover full C functions, types, and control flow.
   - When no external decompiler is installed or on decompiler failure, emits clearly labeled C entry-point skeletons (`// Reconstructed Entry Scaffolding`) without fabricating decompiled instructions.
   - Emits valid C identifiers, sanitizes non-alphanumeric characters, prepends leading underscores to numeric identifiers, and defines `EFIAPI` conventions.

4. **Publication & Provenance**:
   - Publishes modules partitioned by phase (`SEC/`, `PEI/`, `DXE/`, `SMM/`, `APP/`, `MISC/`).
   - Disambiguates duplicate GUIDs or names using deterministic occurrence indices (`<guid>_<name>_<occurrence>`).
   - Links in `README.md` and `firmware_manifest.json` are strictly relative to the publication root.
