# Documentation directory

Find an installation step, investigation guide, or contributor reference by task.
The [REA website](https://rea.tools/) has worked examples and product pages.

## Getting started

- [Installation and setup](getting-started/installation.md)
- [Supported targets and requirements](reference/supported-targets.md)
- [Client configuration and troubleshooting](getting-started/client-configuration.md)
- [CLI and Evidence](getting-started/cli.md)
- [Guided MCP prompts and completion](getting-started/mcp-prompts.md)

## Desktop applications

- [Desktop installation directories](desktop-applications.md)
- [Desktop application capture](desktop-application-capture.md)
- [Desktop application state](desktop-application-state.md)
- [Desktop application tasks](desktop-application-tasks.md)
- [Desktop application export](desktop-application-export.md)
- [Desktop build computer](desktop-build-computer.md)
- [Desktop build witness](desktop-build-witness.md)

## Agent environments

- [Build RL environments with REA](agent-environments-quickstart.md)
- [Agent environments from recorded captures](agent-environments.md)

## Native binaries

- [Native binary investigation](guides/native/native-investigation.md)
- [Go binary build metadata](guides/native/go-binaries.md)
- [DWARF compile units](guides/native/dwarf-units.md)
- [Offline binary diagnostics](guides/native/binary-diagnostics.md)
- [ELF separate debug files](guides/native/elf-debug-link.md)
- [ELF and Mach-O initializer functions](guides/native/native-initializers.md)
- [ELF unwind function ranges](guides/native/elf-unwind-ranges.md)
- [Linux kernel build config](guides/native/kernel-build-config.md)
- [Recorded crash evidence](guides/native/recorded-crashes.md)
- [Windows Shell Link shortcuts](guides/native/windows-shortcut.md)
- [Acquired NTFS metadata](guides/native/ntfs-metadata.md)
- [Binary hardening](binary-hardening.md)
- [ELF note tables](elf-notes.md)
- [ELF dependency tables](elf-dependencies.md)
- [Linux kernel modules](kernel-modules.md)
- [PE Authenticode certificate tables](pe-certificates.md)
- [PE import and delay-load tables](pe-imports.md)
- [PE TLS callbacks and load configuration](pe-load-config.md)
- [Match native functions across builds](native-function-matching.md)
- [Rust binary dependency metadata](rust-binaries.md)
- [Static CUDA and HIP code objects](gpu-code-objects.md)

## JavaScript and Electron

- [JavaScript Application Graph](guides/javascript/javascript-application-graph.md)
- [Cross-layer JavaScript application workflows](guides/javascript/javascript-application-workflows.md)
- [JavaScript artifact reconstruction](guides/javascript/javascript-artifact-reconstruction.md)
- [JavaScript source recovery](guides/javascript/javascript-recovery.md)
- [Passive Node and Electron runtime observation](guides/javascript/javascript-runtime-observation.md)
- [JavaScript static/runtime reconciliation](guides/javascript/javascript-runtime-reconciliation.md)
- [Electron file-page observation](guides/javascript/electron-observation.md)
- [V8 code cache inspection](guides/javascript/v8-code-cache.md)
- [Electron fuse state](electron-fuses.md)
- [Static JavaScript route inventory](javascript-route-inventory.md)
- [Bun standalone executables](bun-standalone.md)
- [Deno compile executables](deno-standalone.md)
- [Node.js single executable applications](node-sea.md)

## Browser and captured websites

- [Website observation with CDP](guides/web/browser-observation.md)
- [Browser scenario contract](guides/web/browser-scenario-contract.md)
- [Website runtime source attribution](guides/web/web-runtime.md)
- [Historical web network captures](guides/web/web-network-captures.md)
- [HTTP/3 capture lab](http3-capture-lab.md)
- [Captured website source locations](guides/web/web-source-location.md)
- [Captured website module relationships](guides/web/website-module-trace.md)
- [Captured website scripts and static JavaScript analysis](guides/web/website-script-export.md)
- [Offline Playwright traces](playwright-traces.md)

## Android applications

- [Static Android APK analysis](guides/android/android-analysis.md)
- [Apktool resource decoding](guides/android/apktool-resource-analysis.md)
- [ADB device inspection and acquisition](guides/android/adb-device-analysis.md)
- [Flutter build identification](guides/android/flutter-analysis.md)
- [Android boot and vendor_boot images](android-boot-image.md)
- [APK signature schemes](apk-signature.md)

## Apple applications

- [Apple Application Inventory Projection](guides/apple/apple-application-analysis.md)
- [Apple IPS crash reports](apple-ips.md)

## .NET assemblies

- [Managed-code analysis](guides/managed/managed-code-analysis.md)
- [NuGet packages](guides/managed/nuget-nupkg.md)
- [.NET single-file bundles](dotnet-bundles.md)
- [IL2CPP metadata](il2cpp-metadata.md)

## Firmware

- [Firmware analysis](guides/firmware/firmware-analysis.md)
- [Android OTA update payloads](guides/firmware/android-ota-payload.md)
- [Flattened devicetree inspection](devicetree.md)
- [ESP flash images](esp-flash-image.md)
- [ESP images](esp-image.md)
- [U-Boot FIT images](fit-images.md)
- [Intel HEX and S-record images](hex-records.md)
- [UF2 and DfuSe images](uf2-dfuse.md)
- [U-Boot legacy uImage containers](uimage.md)

## HarmonyOS packages

- [Static HarmonyOS package inventory](guides/harmony/harmony-analysis.md)

<a id="additional-guides"></a>

## Packages and metadata

- [Offline API contract inventory](api-contracts.md)
- [CycloneDX dependencies](guides/native/cyclonedx-view.md)
- [Maven POM and Gradle module metadata](maven-gradle-metadata.md)
- [Release exposure](release-exposure.md)
- [Model file declarations](model-artifacts.md)
- [Python packaged applications](python-packaged-applications.md)
- [CPython pyc inspection](python-pyc.md)
- [Erlang BEAM files](erlang-beam.md)
- [Godot PCK archives](godot-pck.md)
- [UnityFS AssetBundle archives](unityfs.md)
- [iNES containers](ines-containers.md)
- [WeChat mini-program wxapkg archives](wxapkg.md)

## WebAssembly

- [Offline WebAssembly artifacts](guides/wasm/wasm-artifacts.md)

## EVM contracts

- [Offline EVM bytecode](guides/evm/evm-bytecode.md)

## Databases and recorded packets

- [SQLite database snapshots](guides/data/sqlite-databases.md)
- [Recorded packet capture inspection](guides/data/packet-captures.md)
- [Packet capture summaries](guides/data/pcap-analysis.md)
- [Offline OTLP traces](guides/data/otlp-traces.md)

## Process capture and instrumentation

- [Process capture](guides/runtime/process-capture.md)
- [Frida instrumentation](guides/runtime/frida-instrumentation.md)

## Provider setup and formats

- [Ghidra provider semantics](providers/ghidra-provider.md)
- [DOS MZ and COM analysis with Ghidra](providers/ghidra-dos.md)
- [Optional NativeAOT metadata recovery](providers/ghidra-nativeaot.md)
- [MIPS ELF analysis through Ghidra](providers/ghidra-mips.md)
- [PSP static ELF analysis through Ghidra](providers/ghidra-psp.md)
- [RISC-V ELF analysis through Ghidra](providers/ghidra-riscv.md)
- [Windows Ghidra P0](providers/windows-ghidra-p0.md)
- [Headerless raw-binary analysis with Ghidra](providers/raw-binary.md)
- [IDA provider](providers/ida-provider.md)
- [JEB instrumentation and analysis](providers/jeb-analysis.md)
- [GameCube DOL analysis through Ghidra](ghidra-dol.md)
- [PowerPC ELF analysis through Ghidra](ghidra-ppc.md)
- [Kuna provider](kuna-provider.md)
- [Reverse-engineering tool integrations](reverse-engineering-tools.md)

## Contracts and evidence

- [MCP runtime contracts](reference/mcp-contracts.md)
- [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md)
- [Reconstruction coverage](reconstruction-coverage.md)

## Development and verification

- [Documentation ownership and authoring](development/documentation.md)
- [Settings and recovery](reference/limits-and-recovery.md)
- [REA limit inventory](reference/rea-limit-inventory.md)
- [MCP tool design](development/tool-design.md)
- [Testing REA](development/testing.md)
- [Client and agent verification](development/client-verification.md)
- [Reconstruction readiness conformance](development/reconstruction-readiness.md)
- [Releasing REA](development/releasing.md)
- [Testing lanes and provider verification](testing-lanes.md)
- [Measure MCP catalog costs in Codex](mcp-catalog-evaluation.md)
- [Static analysis in GitHub Actions](ci-analysis.md)

## Release migrations

- [Upgrading from REA 6.1 to 6.2](migrations/migration-6.2.md)

## Signal recordings

- [Recorded signal inspection](guides/signals/signal-recordings.md)

<a id="machine-owned-documentation"></a>

## Generated files and release records

| Path                                      | Owner and update command                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `public/product-catalog.json`             | Ignored contract projection; `npm run docs:generate`                                                    |
| `verification/managed-conformance-*.json` | Ignored managed conformance projections; `npm run evidence:generate`                                    |
| `error-contract.schema.json`              | Tracked schema from contracts; `npm run docs:error-schema`                                              |
| `user-visible-errors.csv`                 | Generated error code and category per domain and provider-owned error case; `npm run docs:error-schema` |
| `releases/<version>.contributions.json`   | Durable release contribution record; follow the [release guide](development/releasing.md)               |

Regenerate catalogs and Evidence projections from their canonical source.
Release records preserve the exact commit messages and references for each release.
Guides share authored images in `assets/`.
