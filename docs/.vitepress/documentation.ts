// Authored guide ownership: physical sources and stable public routes.
export const documentationSections = [
  {
    text: "Getting started",
    items: [
      {
        text: "Installation and setup",
        source: "getting-started/installation.md",
        route: "/installation",
      },
      {
        text: "Client configuration and troubleshooting",
        source: "getting-started/client-configuration.md",
        route: "/client-configuration",
      },
      {
        text: "CLI and Evidence",
        source: "getting-started/cli.md",
        route: "/cli",
      },
      {
        text: "Guided MCP prompts and completion",
        source: "getting-started/mcp-prompts.md",
        route: "/mcp-prompts",
      },
    ],
  },
  {
    text: "Native binaries",
    items: [
      {
        text: "Native binary investigation",
        source: "guides/native/native-investigation.md",
        route: "/native-investigation",
      },
      {
        text: "Go binary build metadata",
        source: "guides/native/go-binaries.md",
        route: "/go-binaries",
      },
      {
        text: "Offline binary diagnostics",
        source: "guides/native/binary-diagnostics.md",
        route: "/binary-diagnostics",
      },
      {
        text: "ELF and Mach-O initializer functions",
        source: "guides/native/native-initializers.md",
        route: "/native-initializers",
      },
      {
        text: "ELF unwind function ranges",
        source: "guides/native/elf-unwind-ranges.md",
        route: "/elf-unwind-ranges",
      },
      {
        text: "Linux kernel build config",
        source: "guides/native/kernel-build-config.md",
        route: "/kernel-build-config",
      },
      {
        text: "Recorded crash evidence",
        source: "guides/native/recorded-crashes.md",
        route: "/recorded-crashes",
      },
      {
        text: "Windows Shell Link shortcuts",
        source: "guides/native/windows-shortcut.md",
        route: "/windows-shortcut",
      },
      {
        source: "guides/native/ntfs-metadata.md",
        route: "/ntfs-metadata",
        text: "Acquired NTFS metadata",
      },
    ],
  },
  {
    text: "JavaScript and Electron",
    items: [
      {
        text: "JavaScript Application Graph",
        source: "guides/javascript/javascript-application-graph.md",
        route: "/javascript-application-graph",
      },
      {
        text: "Cross-layer JavaScript application workflows",
        source: "guides/javascript/javascript-application-workflows.md",
        route: "/javascript-application-workflows",
      },
      {
        text: "JavaScript artifact reconstruction",
        source: "guides/javascript/javascript-artifact-reconstruction.md",
        route: "/javascript-artifact-reconstruction",
      },
      {
        text: "JavaScript source recovery",
        source: "guides/javascript/javascript-recovery.md",
        route: "/javascript-recovery",
      },
      {
        text: "Passive Node and Electron runtime observation",
        source: "guides/javascript/javascript-runtime-observation.md",
        route: "/javascript-runtime-observation",
      },
      {
        text: "JavaScript static/runtime reconciliation",
        source: "guides/javascript/javascript-runtime-reconciliation.md",
        route: "/javascript-runtime-reconciliation",
      },
      {
        text: "Electron file-page observation",
        source: "guides/javascript/electron-observation.md",
        route: "/electron-observation",
      },
      {
        text: "V8 code cache inspection",
        source: "guides/javascript/v8-code-cache.md",
        route: "/v8-code-cache",
      },
    ],
  },
  {
    text: "Browser and captured websites",
    items: [
      {
        text: "Website observation with CDP",
        source: "guides/web/browser-observation.md",
        route: "/browser-observation",
      },
      {
        text: "Browser scenario contract",
        source: "guides/web/browser-scenario-contract.md",
        route: "/browser-scenario-contract",
      },
      {
        text: "Website runtime source attribution",
        source: "guides/web/web-runtime.md",
        route: "/web-runtime",
      },
      {
        text: "Historical web network captures",
        source: "guides/web/web-network-captures.md",
        route: "/web-network-captures",
      },
      {
        text: "HTTP/3 capture lab",
        source: "http3-capture-lab.md",
        route: "/http3-capture-lab",
      },
      {
        text: "Captured website source locations",
        source: "guides/web/web-source-location.md",
        route: "/web-source-location",
      },
      {
        text: "Captured website module relationships",
        source: "guides/web/website-module-trace.md",
        route: "/website-module-trace",
      },
      {
        text: "Captured website scripts and static JavaScript analysis",
        source: "guides/web/website-script-export.md",
        route: "/website-script-export",
      },
    ],
  },
  {
    text: "Android applications",
    items: [
      {
        text: "Static Android APK analysis",
        source: "guides/android/android-analysis.md",
        route: "/android-analysis",
      },
      {
        text: "Apktool resource decoding",
        source: "guides/android/apktool-resource-analysis.md",
        route: "/apktool-resource-analysis",
      },
      {
        text: "ADB device inspection and acquisition",
        source: "guides/android/adb-device-analysis.md",
        route: "/adb-device-analysis",
      },
      {
        text: "Flutter build identification",
        source: "guides/android/flutter-analysis.md",
        route: "/flutter-analysis",
      },
    ],
  },
  {
    text: "Apple applications",
    items: [
      {
        text: "Apple Application Inventory Projection",
        source: "guides/apple/apple-application-analysis.md",
        route: "/apple-application-analysis",
      },
    ],
  },
  {
    text: ".NET assemblies",
    items: [
      {
        text: "Managed-code analysis",
        source: "guides/managed/managed-code-analysis.md",
        route: "/managed-code-analysis",
      },
    ],
  },
  {
    text: "Firmware",
    items: [
      {
        text: "Firmware analysis",
        source: "guides/firmware/firmware-analysis.md",
        route: "/firmware-analysis",
      },
    ],
  },
  {
    text: "HarmonyOS packages",
    items: [
      {
        text: "Static HarmonyOS package inventory",
        source: "guides/harmony/harmony-analysis.md",
        route: "/harmony-analysis",
      },
    ],
  },
  {
    text: "WebAssembly",
    items: [
      {
        text: "Offline WebAssembly artifacts",
        source: "guides/wasm/wasm-artifacts.md",
        route: "/wasm-artifacts",
      },
    ],
  },
  {
    text: "EVM contracts",
    items: [
      {
        text: "Offline EVM bytecode",
        source: "guides/evm/evm-bytecode.md",
        route: "/evm-bytecode",
      },
    ],
  },
  {
    text: "Databases and recorded packets",
    items: [
      {
        text: "SQLite database snapshots",
        source: "guides/data/sqlite-databases.md",
        route: "/sqlite-databases",
      },
      {
        text: "Recorded packet capture inspection",
        source: "guides/data/packet-captures.md",
        route: "/packet-captures",
      },
      {
        text: "Packet capture summaries",
        source: "guides/data/pcap-analysis.md",
        route: "/pcap-analysis",
      },
      {
        text: "NuGet package inspection",
        source: "guides/data/nuget-packages.md",
        route: "/nuget-packages",
      },
    ],
  },
  {
    text: "Process capture and instrumentation",
    items: [
      {
        text: "Process capture",
        source: "guides/runtime/process-capture.md",
        route: "/process-capture",
      },
      {
        text: "Frida instrumentation",
        source: "guides/runtime/frida-instrumentation.md",
        route: "/frida-instrumentation",
      },
    ],
  },
  {
    text: "Provider setup and formats",
    items: [
      {
        text: "Ghidra provider semantics",
        source: "providers/ghidra-provider.md",
        route: "/ghidra-provider",
      },
      {
        text: "DOS MZ and COM analysis with Ghidra",
        source: "providers/ghidra-dos.md",
        route: "/ghidra-dos",
      },
      {
        text: "Optional NativeAOT metadata recovery",
        source: "providers/ghidra-nativeaot.md",
        route: "/ghidra-nativeaot",
      },
      {
        text: "MIPS ELF analysis through Ghidra",
        source: "providers/ghidra-mips.md",
        route: "/ghidra-mips",
      },
      {
        text: "PSP static ELF analysis through Ghidra",
        source: "providers/ghidra-psp.md",
        route: "/ghidra-psp",
      },
      {
        text: "RISC-V ELF analysis through Ghidra",
        source: "providers/ghidra-riscv.md",
        route: "/ghidra-riscv",
      },
      {
        text: "Windows Ghidra P0",
        source: "providers/windows-ghidra-p0.md",
        route: "/windows-ghidra-p0",
      },
      {
        text: "Headerless raw-binary analysis with Ghidra",
        source: "providers/raw-binary.md",
        route: "/raw-binary",
      },
      {
        text: "IDA provider",
        source: "providers/ida-provider.md",
        route: "/ida-provider",
      },
      {
        text: "JEB instrumentation and analysis",
        source: "providers/jeb-analysis.md",
        route: "/jeb-analysis",
      },
    ],
  },
  {
    text: "Contracts and evidence",
    items: [
      {
        text: "MCP runtime contracts",
        source: "reference/mcp-contracts.md",
        route: "/mcp-contracts",
      },
      {
        text: "Reconstruction obligation ledgers",
        source: "reference/reconstruction-obligation-ledgers.md",
        route: "/reconstruction-obligation-ledgers",
      },
    ],
  },
  {
    text: "Development and verification",
    items: [
      {
        text: "Settings and recovery",
        source: "design/limits-and-recovery.md",
        route: "/design/limits-and-recovery",
      },
      {
        text: "REA limit inventory",
        source: "design/rea-limit-inventory.md",
        route: "/design/rea-limit-inventory",
      },
      {
        text: "MCP tool design",
        source: "development/tool-design.md",
        route: "/tool-design",
      },
      {
        text: "Testing REA",
        source: "development/testing.md",
        route: "/testing",
      },
      {
        text: "Client and agent verification",
        source: "development/client-verification.md",
        route: "/client-verification",
      },
      {
        text: "Reconstruction readiness conformance",
        source: "development/reconstruction-readiness.md",
        route: "/reconstruction-readiness",
      },
      {
        text: "Releasing REA",
        source: "development/releasing.md",
        route: "/releasing",
      },
      {
        text: "REA roadmap",
        source: "development/roadmap.md",
        route: "/roadmap",
      },
    ],
  },
  {
    text: "Release migrations",
    items: [
      {
        text: "Upgrading from REA 6.1 to 6.2",
        source: "migrations/migration-6.2.md",
        route: "/migration-6.2",
      },
    ],
  },
  {
    text: "Signal recordings",
    items: [
      {
        text: "Recorded signal inspection",
        source: "guides/signals/signal-recordings.md",
        route: "/signal-recordings",
      },
    ],
  },
  {
    text: "Additional guides",
    items: [
      {
        text: "Offline API contract inventory",
        source: "api-contracts.md",
        route: "/api-contracts",
      },
      {
        text: "Bun standalone executables",
        source: "bun-standalone.md",
        route: "/bun-standalone",
      },
      {
        text: "Deno compile executables",
        source: "deno-standalone.md",
        route: "/deno-standalone",
      },
      {
        text: "Capability composition and ownership",
        source: "capability-composition.md",
        route: "/capability-composition",
      },
      {
        text: ".NET single-file bundles",
        source: "dotnet-bundles.md",
        route: "/dotnet-bundles",
      },
      {
        text: "ESP flash images",
        source: "esp-flash-image.md",
        route: "/esp-flash-image",
      },
      {
        text: "U-Boot FIT images",
        source: "fit-images.md",
        route: "/fit-images",
      },
      {
        text: "Measure MCP catalog costs in Codex",
        source: "mcp-catalog-evaluation.md",
        route: "/mcp-catalog-evaluation",
      },
      {
        text: "Offline Playwright traces",
        source: "playwright-traces.md",
        route: "/playwright-traces",
      },
      {
        text: "Testing lanes and provider verification",
        source: "testing-lanes.md",
        route: "/testing-lanes",
      },
      {
        text: "UF2 and DfuSe images",
        source: "uf2-dfuse.md",
        route: "/uf2-dfuse",
      },
      {
        text: "WeChat mini-program wxapkg archives",
        source: "wxapkg.md",
        route: "/wxapkg",
      },
      {
        text: "Binary hardening",
        source: "binary-hardening.md",
        route: "/binary-hardening",
      },
      {
        text: "Desktop application capture",
        source: "desktop-application-capture.md",
        route: "/desktop-application-capture",
      },
      {
        text: "Desktop application export",
        source: "desktop-application-export.md",
        route: "/desktop-application-export",
      },
      {
        text: "Desktop application state",
        source: "desktop-application-state.md",
        route: "/desktop-application-state",
      },
      {
        text: "Desktop application tasks",
        source: "desktop-application-tasks.md",
        route: "/desktop-application-tasks",
      },
      {
        text: "Desktop build computer",
        source: "desktop-build-computer.md",
        route: "/desktop-build-computer",
      },
      {
        text: "Desktop build witness",
        source: "desktop-build-witness.md",
        route: "/desktop-build-witness",
      },
      {
        text: "iNES containers",
        source: "ines-containers.md",
        route: "/ines-containers",
      },
      {
        text: "Build RL environments with REA",
        source: "agent-environments-quickstart.md",
        route: "/agent-environments-quickstart",
      },
      {
        text: "Agent environments from recorded captures",
        source: "agent-environments.md",
        route: "/agent-environments",
      },
      {
        text: "APK signature schemes",
        source: "apk-signature.md",
        route: "/apk-signature",
      },
      {
        text: "Apple IPS crash reports",
        source: "apple-ips.md",
        route: "/apple-ips",
      },
      {
        text: "Static analysis in GitHub Actions",
        source: "ci-analysis.md",
        route: "/ci-analysis",
      },
      {
        text: "Desktop installation directories",
        source: "desktop-applications.md",
        route: "/desktop-applications",
      },
      {
        text: "Flattened devicetree inspection",
        source: "devicetree.md",
        route: "/devicetree",
      },
      {
        text: "Electron fuse state",
        source: "electron-fuses.md",
        route: "/electron-fuses",
      },
      { text: "ELF note tables", source: "elf-notes.md", route: "/elf-notes" },
      {
        text: "Erlang BEAM files",
        source: "erlang-beam.md",
        route: "/erlang-beam",
      },
      { text: "ESP images", source: "esp-image.md", route: "/esp-image" },
      {
        text: "GameCube DOL analysis through Ghidra",
        source: "ghidra-dol.md",
        route: "/ghidra-dol",
      },
      {
        text: "PowerPC ELF analysis through Ghidra",
        source: "ghidra-ppc.md",
        route: "/ghidra-ppc",
      },
      {
        text: "Godot PCK archives",
        source: "godot-pck.md",
        route: "/godot-pck",
      },
      {
        text: "Static CUDA and HIP code objects",
        source: "gpu-code-objects.md",
        route: "/gpu-code-objects",
      },
      {
        text: "Intel HEX and S-record images",
        source: "hex-records.md",
        route: "/hex-records",
      },
      {
        text: "IL2CPP metadata",
        source: "il2cpp-metadata.md",
        route: "/il2cpp-metadata",
      },
      {
        text: "Static JavaScript route inventory",
        source: "javascript-route-inventory.md",
        route: "/javascript-route-inventory",
      },
      {
        text: "Linux kernel modules",
        source: "kernel-modules.md",
        route: "/kernel-modules",
      },
      {
        text: "Kuna provider",
        source: "kuna-provider.md",
        route: "/kuna-provider",
      },
      {
        text: "Model file declarations",
        source: "model-artifacts.md",
        route: "/model-artifacts",
      },
      {
        text: "Match native functions across builds",
        source: "native-function-matching.md",
        route: "/native-function-matching",
      },
      {
        text: "Node.js single executable applications",
        source: "node-sea.md",
        route: "/node-sea",
      },
      {
        text: "PE Authenticode certificate tables",
        source: "pe-certificates.md",
        route: "/pe-certificates",
      },
      {
        text: "PE import and delay-load tables",
        source: "pe-imports.md",
        route: "/pe-imports",
      },
      {
        text: "PE TLS callbacks and load configuration",
        source: "pe-load-config.md",
        route: "/pe-load-config",
      },
      {
        text: "Python packaged applications",
        source: "python-packaged-applications.md",
        route: "/python-packaged-applications",
      },
      {
        text: "CPython pyc inspection",
        source: "python-pyc.md",
        route: "/python-pyc",
      },
      {
        text: "Reconstruction coverage",
        source: "reconstruction-coverage.md",
        route: "/reconstruction-coverage",
      },
      {
        text: "Release exposure",
        source: "release-exposure.md",
        route: "/release-exposure",
      },
      {
        text: "Reverse-engineering tool integrations",
        source: "reverse-engineering-tools.md",
        route: "/reverse-engineering-tools",
      },
      {
        text: "Rust binary dependency metadata",
        source: "rust-binaries.md",
        route: "/rust-binaries",
      },
      {
        text: "U-Boot legacy uImage containers",
        source: "uimage.md",
        route: "/uimage",
      },
      {
        text: "UnityFS AssetBundle archives",
        source: "unityfs.md",
        route: "/unityfs",
      },
    ],
  },
];

export const documentationRewrites = Object.fromEntries(
  documentationSections.flatMap((section) =>
    section.items.flatMap((item) => {
      const target = `${item.route.slice(1)}.md`;
      return item.source === target ? [] : [[item.source, target]];
    }),
  ),
);
