# Implementation plan

## Boundary and contracts

- `src/domain/machoDebugCompanion.ts`: own pure incremental `machoUuidReads`,
  thin and universal `readMachoUuidEntries` (delegating container and
  load-command framing to `src/domain/apple/machoContainer.ts` and
  `src/domain/apple/machoLoadCommands.ts`), and CPU-scoped `(uuid, cpuType,
  cpuSubtypeBase)` matching in `matchMachOCompanionEntries`.
- `src/application/DebugCompanionAdmission.ts` and
  `src/application/BinaryTargetResolver.ts`: admit the caller-selected bundle at
  target resolution before any provider starts. Reuse the resolver's open target
  handle, enforce normalized `.dSYM` directory naming, enumerate
  `Contents/Resources/DWARF` through `OwnedDirectoryHandle` and
  `withRegularFileCompletion`, deduplicate non-zero 64-bit
  `(dev, ino, size, mtimeNs, ctimeNs)` digests, and
  attach `MachODebugCompanion` to Mach-O `BinaryTarget` variants or project
  `debug_companion_rejected` refusals via `src/domain/analysisErrorProjection.ts`
  and `src/domain/analysisErrorPresentation.ts`.
- `src/contracts/sessionLifecycleInputs.ts`,
  `src/server/registerSessionTools.ts`, `src/cli/options.ts`,
  `src/cli/coreBinaryCommands.ts`, `src/application/DirectAnalysis.ts`, and
  `src/application/binary/BinarySessionOpen.ts`: expose optional absolute
  `dsym_path` / `--dsym-path` across MCP `open_binary` and one-shot native CLI
  commands with contract-level headerless-format pairing rejection.
- `src/ghidra/GhidraProvider.ts`, `src/ghidra/GhidraDebugCompanion.ts`,
  `src/ghidra/GhidraClient.ts`, `src/ghidra/GhidraAnalysisProfile.ts`, and
  `src/domain/liveBinaryTargetSummary.ts`: reject `REA_GHIDRA_PROJECT_PATH`
  pairing as a `ConfigurationError` (`configuration_invalid`) before headless
  launch, commit `debug_companion` into the Ghidra analysis profile so saved
  Program checkpoints stay isolated from bare imports, stage the verified member
  beside the private snapshot on fresh imports (skipping redundant staging on
  checkpoint restore), and project `dsym` facts into target-admission evidence.

## Incremental work and validation

1. Add pure Mach-O `LC_UUID` decoding, shared FAT container validation, and
   CPU-scoped matching rules with unit coverage in
   `src/domain/machoDebugCompanion.test.ts`.
2. Implement bounded `.dSYM` bundle admission, structured refusal diagnostics,
   and close-failure/cancellation handle ownership with boundary and
   process-global regression suites (`tests/boundary/filesystem/targetDiagnostics.test.ts`,
   `tests/process-global/debugCompanionAdmissionFailures.test.ts`).
3. Thread `dsym_path` / `--dsym-path` through MCP and CLI contracts, session
   open, and direct analysis; regenerate tool catalog projections.
4. Add private Ghidra staging, `REA_GHIDRA_PROJECT_PATH` refusal,
   analysis-profile/checkpoint isolation, checkpoint-restore staging skip, and
   target-admission evidence
   (`tests/boundary/filesystem/ghidraDebugCompanion.test.ts`,
   `tests/process-global/ghidraDebugCompanionStagingLifetime.test.ts`,
   `src/ghidra/GhidraProvider.behavior.test.ts`,
   `tests/boundary/providers/ghidra/ghidraCheckpointLifecycle.test.ts`).
5. Author [provider documentation](../../../providers/dsym.md), register public
   navigation and route entries, and run documentation, route, static, and deep
   verification checks.

## Effects and compatibility

All new inputs are optional; omitting `dsym_path` preserves existing target
resolution, analysis-profile digests, Program checkpoints, and Evidence shapes.
Staging writes only inside REA's private runtime root (exclusive `0600` staged
member creation) and cleans up with the ephemeral session root. Neither the
caller's executable nor `.dSYM` bundle is modified or executed.
