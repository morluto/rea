# Tasks: UEFI Firmware Decompilation Pipeline

- [x] 1. Schema and Contract Specifications <!-- id: 1 -->
  - [x] Input schema validation (absolute absent output directory, bounds on max_modules)
  - [x] Result schema definition with phase distribution and relative links
  - [x] Explicit effect block (`mutatesSession: true`, `writesFilesystem: true`, `launchesProcess: true`)

- [x] 2. Analysis Provider & Publication Pipeline <!-- id: 2 -->
  - [x] Unified `DiscoveredUefiModule` discovery for both raw images and extracted folders
  - [x] Bounded directory sniffing: 64-byte `OwnedFileHandle` probe with resource scope retention
  - [x] Lazy buffer resolution: avoid keeping all discovered file buffers in memory
  - [x] Process supervision: enforce `stopSignal: "SIGTERM"` and timeouts on all external process launches
  - [x] Resource budgets: cap individual disassembly buffer at 2 MiB and aggregate at 64 MiB
  - [x] Safe publication: exclusive output directory acquisition via `SafeOutputTree` with rollback

- [x] 3. C Pseudocode Reconstruction & Headless Ghidra <!-- id: 3 -->
  - [x] Implement `bridge/ghidra/ReaDecompileToC.java` script utilizing `CppExporter`
  - [x] Integrate headless Ghidra execution in `UefiAnalysisProvider.ts` when available
  - [x] Clear labeling for entry scaffolding fallback when decompiler is unavailable

- [x] 4. Verification & Testing <!-- id: 4 -->
  - [x] End-to-end unit tests in `src/uefi/UefiAnalysisProvider.test.ts`
  - [x] Test image-based decompilation and phase filtering
  - [x] Test directory-based decompilation and module disambiguation
  - [x] Test existing directory rejection under `SafeOutputTree`
  - [x] Test `max_modules` capping and limitation delivery
