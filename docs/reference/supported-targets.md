# Supported targets and requirements

REA requires Node.js 22.x (>=22.23.4), 24.x (>=24.22.1), or 26.12.1+, plus npm.
The table lists what REA returns for each target and which tools or host it requires.

| Target                  | What REA returns                                                                                  | Requirements and guide                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop installations   | Runtime candidates, supporting files, component markers and next probes                           | Built-in bounded directory/header inspection; [desktop applications](../desktop-applications.md)                                                                 |
| Native binaries         | Pseudocode, assembly, strings, symbols, calls and references                                      | Hopper, Ghidra, IDA or Kuna; [native analysis](../guides/native/native-investigation.md)                                                                         |
| Offline ELF layout      | Sections, segments, original symbols/relocations and static mitigation candidates                 | Caller-supplied pwntools on Linux x64; [binary diagnostics](../guides/native/binary-diagnostics.md)                                                              |
| Go binaries             | Embedded compiler version, modules, replacements and build settings                               | Built-in static ELF/PE/thin Mach-O inspection; no Go installation required                                                                                       |
| GPU code objects        | CUDA/HIP targets, selected kernel parameters and resources, retained PTX text                     | Built-in static ELF/PE/fatbin/CUBIN/PTX inspection; [GPU code objects](../gpu-code-objects.md)                                                                   |
| Model artifacts         | GGUF / safetensors metadata, tensor declarations and derived totals                               | Built-in header inspection; optional full-file hash; [model files](../model-artifacts.md)                                                                        |
| IL2CPP metadata         | Unity global-metadata.dat assembly images, type and method names and index ranges                 | Built-in static decoding of versions 24, 27, 29, 31 and 39; no Unity required                                                                                    |
| Godot PCK               | Archive inventory and extraction, original header/directory facts and selected content identities | Built-in static formats 2, 3 and 4; no Godot required                                                                                                            |
| Rust binaries           | Embedded cargo-auditable crate names, versions, sources and dependency edges                      | Built-in static ELF/PE/thin Mach-O/WebAssembly module inspection; [Rust binaries](../rust-binaries.md)                                                           |
| PE certificates         | Authenticode WIN_CERTIFICATE entries and PKCS#7 signer/X.509 identity fields                      | Built-in static PE inspection; [PE certificates](../pe-certificates.md)                                                                                          |
| PE imports              | Import and delay-load DLL names, ordinals, IAT RVAs and pefile import hash                        | Built-in static PE inspection; [PE imports](../pe-imports.md)                                                                                                    |
| Windows shortcuts       | Shell Link target, arguments, working dir, ExtraData and Tracker droid facts                      | Built-in static LNK inspection; [Windows shortcuts](../guides/native/windows-shortcut.md)                                                                        |
| ELF notes               | PT_NOTE/SHT_NOTE owners, types, and supported note metadata                                       | Built-in static ELF inspection; [ELF notes](../elf-notes.md)                                                                                                     |
| DWARF compile units     | Compile-unit name, directory, producer, language, and dwo_name                                    | Built-in static ELF, Mach-O, and PE inspection; [DWARF compile units](../guides/native/dwarf-units.md)                                                           |
| ELF dependencies        | DT_NEEDED, SONAME, RPATH/RUNPATH, GNU versions, and undefined imports                             | Built-in static ELF inspection; [ELF dependencies](../elf-dependencies.md)                                                                                       |
| Binary hardening        | PIE, NX, RELRO, CFG and related header flags for ELF, PE and Mach-O                               | Built-in static header inspection; [binary hardening](../binary-hardening.md)                                                                                    |
| Apple IPS crashes       | .ips metadata, threads, images, registers and documented crash classes                            | Built-in static JSON inspection; [Apple IPS](../apple-ips.md)                                                                                                    |
| Linux kernel modules    | .modinfo keys, __versions CRCs, this_module presence, and signature trailer                       | Built-in static ELF inspection; [kernel modules](../kernel-modules.md)                                                                                           |
| Erlang BEAM             | IFF chunks, atoms, exports, imports, lambdas and the Code header                                  | Built-in static BEAM inspection; [Erlang BEAM](../erlang-beam.md)                                                                                                |
| NuGet packages          | Package identity, dependency groups, license, repository and ZIP contents                         | Built-in static .nupkg inspection; [NuGet packages](../guides/managed/nuget-nupkg.md)                                                                            |
| WASM artifact           | Validation, sections, exact import/export WAT forms and decoded WAT                               | Caller-supplied [WABT](../guides/wasm/wasm-artifacts.md#configure-wabt); `inspect_wasm_artifact`                                                                 |
| EVM bytecode            | Dispatch selectors, byte offsets, inferred arguments and mutability                               | Local raw/hex carrier on Linux x64; [offline EVM guide](../guides/evm/evm-bytecode.md)                                                                           |
| SQLite databases        | Tables, columns, indexes, views, triggers and selected ordinary-table rows                        | Local database/WAL snapshot; REA on Node.js 24.x or 26.x (unavailable on 22.x)                                                                                   |
| Recorded Linux crashes  | Raw notes, every recorded thread's registers/signals and optional mapping candidates              | Caller-supplied pwntools on Linux x64; optional GDB/pwndbg; [recorded crashes](../guides/native/recorded-crashes.md)                                             |
| JavaScript / Electron   | Modules, imports, source maps, routes, IPC, native add-ons, `rea audit-release-exposure`          | Node.js and npm; Linux: procps-compatible `ps`; [application analysis](../guides/javascript/javascript-application-workflows.md)                                 |
| Websites                | Page structure, scripts, network observations and requested screenshots                           | A Chrome-family browser; [browser analysis](../guides/web/browser-observation.md)                                                                                |
| Saved network captures  | Requests, responses, exposed payloads and source locations                                        | HAR or Fiddler Everywhere SAZ; mitmdump on Linux for native mitmproxy; [capture guide](../guides/web/web-network-captures.md)                                    |
| .NET assemblies         | Metadata, CIL instructions, declared native dependencies and build comparisons                    | None (static only); [managed-code guide](../guides/managed/managed-code-analysis.md)                                                                             |
| Android APKs            | Manifest declarations, classes, decompiled methods and references                                 | Headless JADX and a full JDK on Linux/macOS/Windows x64; [Android guide](../guides/android/android-analysis.md)                                                  |
| APK signatures          | v1/v2/v3/v3.1 signers, certificate fingerprints, key rotation and digest self-consistency         | None (static only); `inspect_apk_signature`                                                                                                                      |
| Android devices         | Devices, packages, processes, logs, dumps, screen captures, and APK/file transfers                | Caller-supplied adb (emulator or hardware); [ADB guide](../guides/android/adb-device-analysis.md)                                                                |
| JEB projects            | Engine-backed project units, artifact digests and type/method pseudo-code                         | A caller-started JEB client serving MCP, selected with REA_JEB_MCP_URL; [JEB guide](../providers/jeb-analysis.md)                                                |
| Android resources       | Decoded manifest, string tables, locales and version facts                                        | Caller-supplied Apktool launcher; [resource guide](../guides/android/apktool-resource-analysis.md)                                                               |
| Flutter apps            | Dart snapshot hash, per-ABI library digests and engine build provenance                           | None (static APK parsing); [Flutter guide](../guides/android/flutter-analysis.md)                                                                                |
| Firmware                | Regions, extraction results and native-analysis handoffs                                          | Bundled UEFI/NVAR; external Binwalk/Unblob on Linux; [firmware guide](../guides/firmware/firmware-analysis.md)                                                   |
| Recorded packets        | Selected fields, repeated values, filters and decode-as rules                                     | Linux: TShark 4.x + prlimit; [capture guide](../guides/data/packet-captures.md)                                                                                  |
| Packet summaries        | Endpoints, DNS, TLS SNI, protocol distribution and HTTP requests                                  | Caller-supplied tshark and capinfos on Linux (prlimit) or Windows; [pcap guide](../guides/data/pcap-analysis.md)                                                 |
| Recorded logic signals  | Decoder annotations, sample ranges and diagnostics                                                | Linux: sigrok-cli 0.7.2 + prlimit; [signal recordings](../guides/signals/signal-recordings.md)                                                                   |
| Packages and resources  | File inventories, digests, plists, Apple bundle anatomy and extracted resources                   | [Artifact and JavaScript guide](../guides/javascript/javascript-artifact-reconstruction.md), [Apple applications](../guides/apple/apple-application-analysis.md) |
| Process behavior        | Terminal output, interactions, exit and filesystem observations, and run comparisons              | Linux/macOS with a native PTY; [process capture](../guides/runtime/process-capture.md)                                                                           |
| PyInstaller executables | CArchive members, Python version, entry scripts and extracted bytecode                            | None (static only); [Python packaged applications](../python-packaged-applications.md)                                                                           |
| Deno compile binaries   | Virtual files, entry point, recorded options, npm snapshot length                                 | None (static only); [Deno compile executables](../deno-standalone.md)                                                                                            |

Static JavaScript and .NET inspection read the supplied files without running
the application. Runtime capture runs or interacts with the selected target
using your user permissions; each runtime guide describes its effects.

For offline native-binary inspection, REA also supports caller-supplied GNU
objdump and Rizin. See the [reverse-engineering tools guide](../reverse-engineering-tools.md)
for provider setup, CLI commands, and Evidence limitations. REA does not install
or update either provider.

## Choosing a deep analysis provider

Native formats and host support vary by provider. See
[Hopper and Ghidra setup](../getting-started/installation.md#hopper), the
[IDA guide](../providers/ida-provider.md) (including an optional native MCP bridge), the
[Kuna decompiler guide](../kuna-provider.md), and
[experimental Windows Ghidra support](../providers/windows-ghidra-p0.md).
Ghidra also supports [16-bit DOS analysis](../providers/ghidra-dos.md).
For large binaries, raise the provider's startup deadline with
`REA_GHIDRA_STARTUP_TIMEOUT_MS` or `REA_HOPPER_STARTUP_TIMEOUT_MS`.
For provider selection, see the [CLI guide](../getting-started/cli.md#choose-a-provider).
Check [release availability](../getting-started/installation.md#released-package-and-main)
for features added since the latest npm release.
