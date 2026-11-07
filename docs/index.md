---
layout: home

hero:
  name: REA
  text: Reverse Engineer Anything
  tagline: Understand binaries, applications, and runtime behavior with one CLI and MCP server.
  actions:
    - theme: brand
      text: Get started
      link: /installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/morluto/rea

features:
  - title: Investigate with your agent
    details: Connect REA to your coding agent, describe the app or feature you want to understand, and follow the evidence.
    link: /mcp-prompts
  - title: Inspect across formats
    details: Explore native binaries, JavaScript and Electron apps, .NET assemblies, Android packages, firmware, and websites.
    link: /installation
  - title: Keep the evidence
    details: Analysis runs locally and returns observations, limitations, and unknowns through the CLI and MCP.
    link: /mcp-contracts
---

## Start with one command

```bash
npx rea-agents setup
```

Choose your agent, review the planned changes, and approve setup. Native binary
analysis can use an existing Hopper, Ghidra, or IDA installation; static
JavaScript analysis needs no native analysis engine.

For a first result from an extracted JavaScript application or ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

See [installation and setup](getting-started/installation.md) for requirements and configuration.

For runtime instrumentation, see the [Frida guide](guides/runtime/frida-instrumentation.md).

## Choose a guide

The [documentation directory](README.md) lists every guide by domain.

| Task                                                | Guides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identify a desktop installation                     | [Runtime candidates, evidence and follow-up files](desktop-applications.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Inspect native functions, references, or types      | [Native binaries](guides/native/native-investigation.md), [Go metadata](guides/native/go-binaries.md), [Rust dependencies](rust-binaries.md), [CPython pyc files](python-pyc.md), [PE certificates](pe-certificates.md), [PE imports](pe-imports.md), [PE TLS/load config](pe-load-config.md), [ELF notes](elf-notes.md), [Linux kernel modules](kernel-modules.md), [Apple IPS](apple-ips.md), [Erlang BEAM](erlang-beam.md), [offline ELF layout](guides/native/binary-diagnostics.md), [recorded crashes](guides/native/recorded-crashes.md)                                                                                                              |
| Select a native provider or import format           | [Ghidra semantics](providers/ghidra-provider.md), [Windows](providers/windows-ghidra-p0.md), [DOS](providers/ghidra-dos.md), [raw bytes](providers/raw-binary.md), [GameCube DOL](ghidra-dol.md), [MIPS](providers/ghidra-mips.md), [PSP](providers/ghidra-psp.md), [NativeAOT](providers/ghidra-nativeaot.md), [IDA](providers/ida-provider.md), [Kuna](kuna-provider.md), [JEB](providers/jeb-analysis.md)                                                                                                                                                                                                                                                 |
| Analyze JavaScript or Electron artifacts            | [Static analysis](guides/javascript/javascript-artifact-reconstruction.md), [tracing and comparisons](guides/javascript/javascript-application-workflows.md), [application graph](guides/javascript/javascript-application-graph.md), [source recovery](guides/javascript/javascript-recovery.md)                                                                                                                                                                                                                                                                                                                                                            |
| Compare static JavaScript with runtime observations | [Runtime attribution](guides/javascript/javascript-runtime-observation.md), [reconciliation](guides/javascript/javascript-runtime-reconciliation.md), [Electron observation](guides/javascript/electron-observation.md), [Electron fuses](electron-fuses.md)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Inspect assemblies, packages, or firmware           | [Godot PCK](godot-pck.md), [UnityFS](unityfs.md), [U-Boot uImage](uimage.md), [.NET](guides/managed/managed-code-analysis.md), [Python packages](python-packaged-applications.md), [Android](guides/android/android-analysis.md), [APK signatures](apk-signature.md), [Apktool resources](guides/android/apktool-resource-analysis.md), [ADB acquisition](guides/android/adb-device-analysis.md), [Apple](guides/apple/apple-application-analysis.md), [Harmony](guides/harmony/harmony-analysis.md), [firmware](guides/firmware/firmware-analysis.md), [ESP images](esp-image.md), [WASM](guides/wasm/wasm-artifacts.md), [EVM](guides/evm/evm-bytecode.md) |
| Observe or compare a browser scenario               | [CDP observation](guides/web/browser-observation.md), [scenarios](guides/web/browser-scenario-contract.md), [runtime evidence](guides/web/web-runtime.md), [historical captures](guides/web/web-network-captures.md)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Serve recorded behavior as an agent environment     | [Agent environments](agent-environments.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Trace captured website source                       | [Source locations](guides/web/web-source-location.md), [module traces](guides/web/website-module-trace.md), [script export](guides/web/website-script-export.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Capture and compare a command                       | [Process capture](guides/runtime/process-capture.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Use CLI/MCP and retain evidence                     | [CLI](getting-started/cli.md), [MCP contracts](reference/mcp-contracts.md), [agent prompts](getting-started/mcp-prompts.md), [obligation ledgers](reference/reconstruction-obligation-ledgers.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

For development, use [testing](development/testing.md), [client verification](development/client-verification.md),
[tool design](development/tool-design.md), [admission limits and recovery](design/limits-and-recovery.md),
and [releasing](development/releasing.md).
[Reconstruction readiness](development/reconstruction-readiness.md) describes a development
conformance verifier. [The 6.2 migration](migrations/migration-6.2.md) records that release's
compatibility changes; [the roadmap](development/roadmap.md) tracks future work.

![REA inspecting a native binary in Hopper](./assets/rea-hopper-analysis.png)
