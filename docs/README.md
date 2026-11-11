# Documentation directory

REA documentation is organized by reader task and document owner. This directory
links every authored guide; the [site](https://rea.tools/) also serves separate
product pages. The VitePress documentation source is this `docs/` tree.

## Getting started

- [Installation and setup](getting-started/installation.md)
- [Client configuration and troubleshooting](getting-started/client-configuration.md)
- [CLI and Evidence](getting-started/cli.md)
- [Guided MCP prompts and completion](getting-started/mcp-prompts.md)

## Native binaries

- [Native binary investigation](guides/native/native-investigation.md)
- [Go binary build metadata](guides/native/go-binaries.md)
- [Offline binary diagnostics](guides/native/binary-diagnostics.md)
- [ELF and Mach-O initializer functions](guides/native/native-initializers.md)
- [ELF unwind function ranges](guides/native/elf-unwind-ranges.md)
- [Linux kernel build config](guides/native/kernel-build-config.md)
- [Recorded crash evidence](guides/native/recorded-crashes.md)
- [Windows Shell Link shortcuts](guides/native/windows-shortcut.md)
- [Acquired NTFS metadata and change journals](guides/native/ntfs-metadata.md)

## JavaScript and Electron

- [JavaScript Application Graph](guides/javascript/javascript-application-graph.md)
- [Cross-layer JavaScript application workflows](guides/javascript/javascript-application-workflows.md)
- [JavaScript artifact reconstruction](guides/javascript/javascript-artifact-reconstruction.md)
- [JavaScript source recovery](guides/javascript/javascript-recovery.md)
- [Passive Node and Electron runtime observation](guides/javascript/javascript-runtime-observation.md)
- [JavaScript static/runtime reconciliation](guides/javascript/javascript-runtime-reconciliation.md)
- [Electron file-page observation](guides/javascript/electron-observation.md)
- [V8 code cache inspection](guides/javascript/v8-code-cache.md)

## Browser and captured websites

- [Website observation with CDP](guides/web/browser-observation.md)
- [Browser scenario contract](guides/web/browser-scenario-contract.md)
- [Website runtime source attribution](guides/web/web-runtime.md)
- [Historical web network captures](guides/web/web-network-captures.md)
- [HTTP/3 capture lab](http3-capture-lab.md)
- [Captured website source locations](guides/web/web-source-location.md)
- [Captured website module relationships](guides/web/website-module-trace.md)
- [Captured website scripts and static JavaScript analysis](guides/web/website-script-export.md)

## Android applications

- [Static Android APK analysis](guides/android/android-analysis.md)
- [Apktool resource decoding](guides/android/apktool-resource-analysis.md)
- [ADB device inspection and acquisition](guides/android/adb-device-analysis.md)
- [Flutter build identification](guides/android/flutter-analysis.md)

## Apple applications

- [Apple Application Inventory Projection](guides/apple/apple-application-analysis.md)

## .NET assemblies

- [Managed-code analysis](guides/managed/managed-code-analysis.md)

## Firmware

- [Firmware analysis](guides/firmware/firmware-analysis.md)

## HarmonyOS packages

- [Static HarmonyOS package inventory](guides/harmony/harmony-analysis.md)

## WebAssembly

- [Offline WebAssembly artifacts](guides/wasm/wasm-artifacts.md)

## EVM contracts

- [Offline EVM bytecode](guides/evm/evm-bytecode.md)

## Databases and recorded packets

- [SQLite database snapshots](guides/data/sqlite-databases.md)
- [Recorded packet capture inspection](guides/data/packet-captures.md)
- [Packet capture summaries](guides/data/pcap-analysis.md)

## Process capture and instrumentation

- [Process capture](guides/runtime/process-capture.md)
- [Frida instrumentation](guides/runtime/frida-instrumentation.md)

## Signal recordings

- [Recorded signal inspection](guides/signals/signal-recordings.md)

## Provider setup and formats

- [Ghidra provider semantics](providers/ghidra-provider.md)
- [DOS MZ and COM analysis with Ghidra](providers/ghidra-dos.md)
- [Optional NativeAOT metadata recovery](providers/ghidra-nativeaot.md)
- [MIPS ELF analysis through Ghidra](providers/ghidra-mips.md)
- [PSP static ELF analysis through Ghidra](providers/ghidra-psp.md)
- [RISC-V ELF analysis through Ghidra](providers/ghidra-riscv.md)
- [Xtensa ELF analysis through Ghidra](providers/ghidra-xtensa.md)
- [Windows Ghidra P0](providers/windows-ghidra-p0.md)
- [Headerless raw-binary analysis with Ghidra](providers/raw-binary.md)
- [IDA provider](providers/ida-provider.md)
- [JEB instrumentation and analysis](providers/jeb-analysis.md)

## Contracts and evidence

- [MCP runtime contracts](reference/mcp-contracts.md)
- [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md)

## Development and verification

- [Settings and recovery](design/limits-and-recovery.md)
- [REA limit inventory](design/rea-limit-inventory.md)
- [MCP tool design](development/tool-design.md)
- [Testing REA](development/testing.md)
- [Client and agent verification](development/client-verification.md)
- [Reconstruction readiness conformance](development/reconstruction-readiness.md)
- [Releasing REA](development/releasing.md)
- [REA roadmap](development/roadmap.md)

## Release migrations

- [Upgrading from REA 6.1 to 6.2](migrations/migration-6.2.md)

## Architecture and authoring

- [Architecture map](https://github.com/morluto/rea/blob/main/docs/architecture/architecture.mermaid)
- [Documentation ownership and contribution model](development/documentation.md)
- [Feature specifications](specs/README.md)
- [Architectural decision records](adr/README.md)

## Machine-owned documentation

| Path                                      | Owner and update command                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `public/product-catalog.json`             | Ignored contract projection; `npm run docs:generate`                                      |
| `verification/managed-conformance-*.json` | Ignored managed conformance projections; `npm run evidence:generate`                      |
| `error-contract.schema.json`              | Tracked schema from contracts; `npm run docs:error-schema`                                |
| `user-visible-errors.csv`                 | Authored error classification inventory; preserve its schema                              |
| `releases/<version>.contributions.json`   | Durable release contribution record; follow the [release guide](development/releasing.md) |
| `assets/`                                 | Shared authored images referenced by guides                                               |

Do not edit generated catalogs or evidence to change product facts. Change their
canonical contracts or producer and regenerate. Historical release records retain
the exact commit messages and references from the release they describe.

## Additional guides

- [Offline API contract inventory](api-contracts.md)
- [Bun standalone executables](bun-standalone.md)
- [Deno compile executables](deno-standalone.md)
- [Capability composition and ownership](capability-composition.md)
- [.NET single-file bundles](dotnet-bundles.md)
- [ESP flash images](esp-flash-image.md)
- [U-Boot FIT images](fit-images.md)
- [Measure MCP catalog costs in Codex](mcp-catalog-evaluation.md)
- [Offline Playwright traces](playwright-traces.md)
- [Testing lanes and provider verification](testing-lanes.md)
- [UF2 and DfuSe images](uf2-dfuse.md)
- [WeChat mini-program wxapkg archives](wxapkg.md)
- [Binary hardening](binary-hardening.md)
- [Desktop application capture](desktop-application-capture.md)
- [Desktop application export](desktop-application-export.md)
- [Desktop application state](desktop-application-state.md)
- [Desktop application tasks](desktop-application-tasks.md)
- [Desktop build computer](desktop-build-computer.md)
- [Desktop build witness](desktop-build-witness.md)
- [iNES containers](ines-containers.md)
- [Build RL environments with REA](agent-environments-quickstart.md)
- [Agent environments from recorded captures](agent-environments.md)
- [APK signature schemes](apk-signature.md)
- [Apple IPS crash reports](apple-ips.md)
- [Static analysis in GitHub Actions](ci-analysis.md)
- [Desktop installation directories](desktop-applications.md)
- [Flattened devicetree inspection](devicetree.md)
- [Electron fuse state](electron-fuses.md)
- [ELF note tables](elf-notes.md)
- [Erlang BEAM files](erlang-beam.md)
- [ESP images](esp-image.md)
- [GameCube DOL analysis through Ghidra](ghidra-dol.md)
- [PowerPC ELF analysis through Ghidra](ghidra-ppc.md)
- [Godot PCK archives](godot-pck.md)
- [Static CUDA and HIP code objects](gpu-code-objects.md)
- [Intel HEX and S-record images](hex-records.md)
- [IL2CPP metadata](il2cpp-metadata.md)
- [Static JavaScript route inventory](javascript-route-inventory.md)
- [Linux kernel modules](kernel-modules.md)
- [Kuna provider](kuna-provider.md)
- [Model file declarations](model-artifacts.md)
- [Match native functions across builds](native-function-matching.md)
- [Node.js single executable applications](node-sea.md)
- [PE Authenticode certificate tables](pe-certificates.md)
- [PE import and delay-load tables](pe-imports.md)
- [PE TLS callbacks and load configuration](pe-load-config.md)
- [Python packaged applications](python-packaged-applications.md)
- [CPython pyc inspection](python-pyc.md)
- [Reconstruction coverage](reconstruction-coverage.md)
- [Release exposure](release-exposure.md)
- [Reverse-engineering tool integrations](reverse-engineering-tools.md)
- [Rust binary dependency metadata](rust-binaries.md)
- [U-Boot legacy uImage containers](uimage.md)
- [UnityFS AssetBundle archives](unityfs.md)
