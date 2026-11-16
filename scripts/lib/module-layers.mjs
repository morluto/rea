/**
 * Declared layer of every top-level `src/` unit: each directory, and each
 * root-level source file. Dependencies may point to the same or a lower
 * layer. An undeclared unit fails the check, so a new directory must choose
 * its layer when it is added.
 *
 * The order follows docs/architecture/architecture.mermaid: the dependency-free
 * kernel helpers that every layer may use, domain and
 * contracts at the centre, the process/filesystem foundation, the ports
 * that providers implement and application consumes, the shared provider
 * core (src/providers), provider adapters,
 * shared application workflows, production composition, then the CLI and
 * MCP entry points.
 */
export const LAYER_ORDER = Object.freeze([
  "kernel",
  "domain",
  "contracts",
  "foundation",
  "ports",
  "providerCore",
  "providers",
  "application",
  "composition",
  "adapters",
]);

const units = (layer, names) => names.map((name) => [name, layer]);

export const UNIT_LAYERS = Object.freeze(
  Object.fromEntries([
    ...units("kernel", ["kernel"]),
    ...units("domain", ["domain"]),
    ...units("contracts", ["contracts"]),
    ...units("foundation", [
      "compression",
      "config",
      "filesystem",
      "hopperPaths",
      "platform",
      "process",
      "resources",
      "windows",
      "generatedPackageMetadata.ts",
      "identity.ts",
      "logger.ts",
    ]),
    ...units("ports", ["ports"]),
    // The shared provider core (src/providers): deferred client owners and
    // failure attribution that every provider folder may import. It may not
    // import a provider folder.
    ...units("providerCore", ["providers"]),
    // Every unit here is a provider folder; see providerBoundaryFacts.
    ...units("providers", [
      "adb",
      "android",
      "apkSignature",
      "apktool",
      "artifacts",
      "browser",
      "captures",
      "cutter",
      "desktop",
      "dotnet",
      "electron",
      "erlang",
      "evm",
      "firmware",
      "flutter",
      "frida",
      "gdb",
      "ghidra",
      "go",
      "gpu",
      "hopper",
      "ida",
      "il2cpp",
      "inspector",
      "javascript",
      "jeb",
      "kuna",
      "model",
      "native",
      "objdump",
      "pcap",
      "python",
      "reference",
      "rizin",
      "rust",
      "signals",
      "sqlite",
      "v8",
      "wasm",
    ]),
    ...units("application", ["application"]),
    ...units("composition", ["composition"]),
    ...units("adapters", [
      "cli",
      "main",
      "server",
      "cli.ts",
      "cliBrowserScenarioCommands.ts",
      "cliBuiltinArguments.ts",
      "cliConfiguration.ts",
      "cliEvidenceCommands.ts",
      "cliLogging.ts",
      "cliOneShot.ts",
      "cliOutput.ts",
      "doctorRuntime.ts",
      "main.ts",
      "mcpDoctor.ts",
      "mcpDoctorOptions.ts",
      "recordedCliCommandRegistrations.ts",
      "recordedMcpCatalog.ts",
    ]),
  ]),
);

/**
 * Single file-to-file imports that may point up the layer order. Each one is
 * a deliberate decision, not a baseline debt: it is not counted, and any other
 * import between the same units still is. Keep the list short and say why.
 */
export const LAYER_EXCEPTIONS = Object.freeze([
  Object.freeze({
    file: "src/domain/localPath.ts",
    target: "src/platform/HostPlatform.ts",
    // `absoluteLocalPathStringSchema` states which paths are absolute on the
    // host running REA; that is a fact about the host's path rules, and
    // HostPlatform is its only reader (maintainer decision, W8).
    reason:
      "the absolute local path schema follows the running host's path rules",
  }),
]);

const sourcePath = (path) => path.replace(/\.js$/u, ".ts");
/** Whether one resolved import is a declared layer exception. */
export const isLayerException = (file, target) =>
  LAYER_EXCEPTIONS.some(
    (exception) =>
      exception.file === sourcePath(file) &&
      exception.target === sourcePath(target),
  );

const PRODUCTION_SOURCE = /^src\/.+\.(?:ts|js)$/u;
const NON_PRODUCTION = /\.(?:test|spec|fixture)\.(?:ts|js)$|\.d\.ts$/u;

/** The top-level unit of a production `src/` file, or undefined. */
export const sourceUnit = (path) => {
  if (!PRODUCTION_SOURCE.test(path) || NON_PRODUCTION.test(path))
    return undefined;
  // A root-level source file is its own unit; built .js specifiers name .ts files.
  return path.split("/")[1].replace(/\.js$/u, ".ts");
};

const rank = (unit) => LAYER_ORDER.indexOf(UNIT_LAYERS[unit]);

/** Unit pairs that import each other, the shortest import cycles. */
const mutualPairs = (edges) =>
  [...edges.keys()]
    .map((key) => key.split(" -> "))
    .filter(([from, to]) => from < to && edges.has(`${to} -> ${from}`))
    .map(([from, to]) => `${from} <-> ${to}`)
    .sort();

/**
 * Collect unit-level facts from resolved production imports: undeclared
 * units, imports that point to a higher layer (counted per unit pair), and
 * unit pairs that import each other. Longer cycles through three or more
 * units are not reported; every such cycle contains an upward import, which
 * the layer count already ratchets.
 */
export const layerGraphFacts = (imports, files = []) => {
  const edges = new Map();
  const undeclared = new Set();
  for (const file of files) {
    const unit = sourceUnit(file);
    if (unit !== undefined && UNIT_LAYERS[unit] === undefined)
      undeclared.add(unit);
  }
  for (const { file, target } of imports) {
    const from = sourceUnit(file);
    const to = sourceUnit(target);
    if (from === undefined || to === undefined || from === to) continue;
    if (isLayerException(file, target)) continue;
    for (const unit of [from, to])
      if (UNIT_LAYERS[unit] === undefined) undeclared.add(unit);
    const key = `${from} -> ${to}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  const upward = {};
  for (const [key, count] of [...edges].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const [from, to] = key.split(" -> ");
    if (undeclared.has(from) || undeclared.has(to)) continue;
    if (rank(from) < rank(to)) upward[key] = count;
  }
  return {
    undeclared: [...undeclared].sort(),
    upward,
    cycles: mutualPairs(edges),
    ...providerBoundaryFacts(imports),
  };
};

/** Whether a unit is a provider folder. */
export const isProviderUnit = (unit) => UNIT_LAYERS[unit] === "providers";

const ENTRY_IMPORTER_LAYERS = new Set([
  "application",
  "composition",
  "adapters",
]);

/**
 * Declared entry files of each unit, relative to `src/<unit>/`: the only
 * files that outside code may import.
 *
 * - `src/resources`, the shared provider toolkit (stable reads, artifact
 *   readers, resource scopes, cleanup leases and their failure projections),
 *   is reached from every other unit through its `index.ts`.
 * - A provider folder is reached from application, composition and the CLI/MCP
 *   adapters through the files listed here: the provider classes, identities,
 *   metadata, worker servers, doctors and commands that composition wires.
 *   There is no per-provider barrel, because composition, the capability
 *   declarations and the CLI load single provider files lazily or for metadata
 *   only, and a barrel would pull in the whole provider.
 *
 * Adding a file here widens that unit's public surface; review it as such.
 * Imports of any other file are counted in the baseline's `entry` map.
 */
export const ENTRY_FILES = Object.freeze(
  Object.fromEntries(
    Object.entries({
      resources: ["index.ts"],
      adb: ["AdbProvider.ts", "AdbProviderIdentity.ts"],
      android: [
        "JadxDoctor.ts",
        "JadxMcpTransport.ts",
        "JadxProvider.ts",
        "JadxRelease.ts",
      ],
      apkSignature: ["ApkSignatureProvider.ts", "ApkSignatureRelease.ts"],
      apktool: ["ApktoolProvider.ts", "ApktoolProviderIdentity.ts"],
      artifacts: [
        "ArtifactProvider.ts",
        "ArtifactProviderMetadata.ts",
        "DesktopApplicationReader.ts",
        "ReleaseExposureReader.ts",
        // JavaScript reconstruction owns one resource scope across the
        // inventory scan, the format reader and the source read.
        "inventory/scanCanonical.ts",
        "javascript/JavaScriptArtifactFiles.ts",
        "javascript/JavaScriptArtifactReader.ts",
      ],
      browser: [
        "CdpBrowserProvider.ts",
        "CdpElectronProvider.ts",
        "IsolatedWebBundleAnalyzer.ts",
        "PlaywrightBrowserScenarioProvider.ts",
        "PlaywrightElectronActiveProvider.ts",
        "PlaywrightScenarioSession.ts",
        "WebBundleAnalysisWorkerServer.ts",
        "assets/WebSourceLocationArtifacts.ts",
        "execution/CdpWebRuntimeProvider.ts",
        "history/CaptureProviderIdentities.ts",
        "history/HistoricalCaptureDecoder.ts",
        "history/MitmproxyCaptureAdapter.ts",
        "history/NodeCaptureAdapter.ts",
        "history/playwrightTrace/PlaywrightTraceDecoder.ts",
        "modules/NativeModuleResolver.ts",
        "modules/WebModuleArtifacts.ts",
        "providerIdentities.ts",
      ],
      captures: ["TsharkCaptureProvider.ts", "TsharkProviderIdentity.ts"],
      cutter: [
        "CutterBridgeClient.ts",
        "CutterBridgeService.ts",
        "CutterProviderIdentity.ts",
      ],
      desktop: [
        "AgentEnvComputer.ts",
        "BuildComputerEnvironment.ts",
        "DconfDatabaseReader.ts",
        "DesktopBuildDoctorFacts.ts",
        "DesktopSessionRequests.ts",
      ],
      dotnet: ["ManagedStaticProvider.ts", "ManagedStaticProviderMetadata.ts"],
      electron: ["ElectronFuseProvider.ts", "ElectronFuseProviderIdentity.ts"],
      erlang: ["BeamProvider.ts", "ErlangBeamProviderIdentity.ts"],
      evm: ["EvmoleInterfaceProvider.ts", "EvmoleProviderIdentity.ts"],
      firmware: [
        "FirmwareCommand.ts",
        "FirmwareProvider.ts",
        "FirmwareProviderIdentities.ts",
        "devicetree/DevicetreeProvider.ts",
      ],
      flutter: ["FlutterBuildProvider.ts", "FlutterProviderIdentity.ts"],
      frida: ["FridaInstrumentationManager.ts", "FridaProviderIdentity.ts"],
      gdb: ["GdbProviderIdentity.ts", "GdbSessionManager.ts"],
      ghidra: [
        "GhidraDoctor.ts",
        "GhidraProvider.ts",
        "GhidraProviderMetadata.ts",
      ],
      go: ["GoBinaryProvider.ts", "GoBinaryProviderIdentity.ts"],
      gpu: ["GpuCodeObjectsProvider.ts", "GpuCodeObjectsProviderIdentity.ts"],
      hopper: [
        "HopperProvider.ts",
        "HopperProviderMetadata.ts",
        "LinuxPrivateDisplayProbe.ts",
      ],
      ida: [
        "IdaConfiguration.ts",
        "IdaDoctor.ts",
        "IdaMcpConnection.ts",
        "IdaProvider.ts",
        "IdaProviderMetadata.ts",
      ],
      il2cpp: [
        "Il2CppMetadataProviderIdentity.ts",
        "Il2cppGhidraSeedWriter.ts",
        "Il2cppMetadataProvider.ts",
      ],
      inspector: ["V8InspectorProvider.ts", "providerIdentity.ts"],
      javascript: [
        "analysis/JavaScriptAnalysisTransfer.ts",
        "analysis/JavaScriptAnalysisWorkerServer.ts",
        "analysis/JavaScriptSourceAnalysis.ts",
        "recovery/WakaruCommand.ts",
        "recovery/WakaruProvider.ts",
        "recovery/WakaruProviderIdentity.ts",
        "sourceMaps/SourceMapDecoder.ts",
      ],
      jeb: ["JebMcpConnection.ts", "JebProvider.ts", "JebProviderIdentity.ts"],
      kuna: ["KunaDoctor.ts", "KunaProvider.ts", "KunaProviderMetadata.ts"],
      model: ["ModelArtifactProvider.ts", "ModelArtifactProviderIdentity.ts"],
      native: [
        "NativeMacOSProvider.ts",
        "NativeMacOSProviderMetadata.ts",
        "NativeMacosProviderIdentity.ts",
        "apple/AppleIpsProvider.ts",
        "elf/ElfNotesProvider.ts",
        "elf/ElfUnwindRangesProvider.ts",
        "elf/KernelBuildConfigProvider.ts",
        "elf/KernelModuleProvider.ts",
        "exports/NativeExportsProvider.ts",
        "hardening/BinaryHardeningProvider.ts",
        "initializers/NativeInitializersProvider.ts",
        "pe/PeCertificatesProvider.ts",
        "pe/PeImportsProvider.ts",
        "pe/PeLoadConfigProvider.ts",
        "pe/PeResourcesProvider.ts",
        "pwntools/PwntoolsDecoder.ts",
        "pwntools/PwntoolsLayoutProvider.ts",
        "pwntools/PwntoolsProviderIdentity.ts",
        "pwntools/PwntoolsRecordedCrashProvider.ts",
        "windows/WindowsShortcutProvider.ts",
      ],
      objdump: ["ObjdumpCommand.ts", "ObjdumpProviderIdentity.ts"],
      pcap: [
        "PcapConfiguration.ts",
        "PcapProvider.ts",
        "PcapProviderIdentity.ts",
      ],
      python: ["PythonPycProvider.ts", "PythonPycProviderIdentity.ts"],
      reference: [
        // The reference-source import workflow (src/application/ReferenceSource*)
        // runs the reader and consumes its result and failure types. It reports
        // its own root and VCS reads with the reader's two failure builders, so
        // both kinds of failure share one shape and wording. Traversal state,
        // symlink reconciliation and the per-entry failure helpers stay private.
        "ReferenceSourceFailureBuilders.ts",
        "ReferenceSourceReader.ts",
        "ReferenceSourceReaderTypes.ts",
      ],
      rizin: [
        "RizinCommand.ts",
        "RizinDebugSessionManager.ts",
        "RizinDebuggerProviderIdentity.ts",
        "RizinProviderIdentity.ts",
      ],
      rust: ["RustBinaryProvider.ts", "RustBinaryProviderIdentity.ts"],
      signals: ["SigrokProviderIdentity.ts", "SigrokRecordingProvider.ts"],
      sqlite: ["SqliteDatabaseProvider.ts"],
      v8: ["V8CodeCacheProvider.ts", "V8CodeCacheProviderIdentity.ts"],
      wasm: ["WabtArtifactProvider.ts", "WabtRelease.ts"],
    }).map(([unit, files]) => [unit, Object.freeze(files)]),
  ),
);

/**
 * Whether an import from `from` into `to` must use one of `to`'s entry
 * files: every import of a non-provider unit that declares entry files, and
 * every application, composition or adapter import of a provider folder (a
 * provider without declared entry files has none).
 */
const requiresEntry = (from, to) =>
  isProviderUnit(to)
    ? ENTRY_IMPORTER_LAYERS.has(UNIT_LAYERS[from])
    : ENTRY_FILES[to] !== undefined;

/** Whether a resolved target is one of its unit's declared entry files. */
const isEntryFile = (unit, target) =>
  (ENTRY_FILES[unit] ?? []).some(
    (file) => sourcePath(target) === `src/${unit}/${file}`,
  );

/**
 * Declared provider-to-provider dependencies: files of one provider folder,
 * relative to `src/<to>/`, that another provider folder may import. Each one
 * is a deliberate decision, not baseline debt: imports of these files are not
 * counted in `crossProvider`, and any other import between the same folders
 * still is. Keep the list short and say why.
 */
export const PROVIDER_DEPENDENCIES = Object.freeze([
  Object.freeze({
    from: "inspector",
    to: "browser",
    files: Object.freeze([
      "CdpCaptureValues.ts",
      "CdpConnection.ts",
      "CdpDiscoveryTargets.ts",
      "CdpEndpoint.ts",
      "CdpScriptContextFacts.ts",
      "CdpTargetSessionOwner.ts",
      "ElectronFileScope.ts",
      "protocol/CdpEvents.ts",
    ]),
    // The V8 inspector speaks the Chrome DevTools Protocol. It reuses
    // browser's CDP client (endpoint discovery, connection, target sessions
    // and captured value projection) instead of keeping a second client.
    // For Electron targets it authorizes script files inside app.asar with
    // browser's Electron file scope, which owns the ASAR descriptors.
    reason:
      "the V8 inspector reuses the browser provider's CDP client and Electron file scope",
  }),
  Object.freeze({
    from: "browser",
    to: "electron",
    files: Object.freeze([
      "ElectronFuseFailures.ts",
      "ElectronFusePath.ts",
      "ElectronFuseReader.ts",
    ]),
    // Active Electron capture launches the target with inspect arguments,
    // which the EnableNodeCliInspectArguments fuse can silently disable.
    // The preflight reads that fuse with the electron provider's fuse reader
    // and reports its failures, instead of parsing the fuse wire twice.
    reason:
      "active Electron capture checks the inspect-arguments fuse with the electron provider's fuse reader",
  }),
  Object.freeze({
    from: "desktop",
    to: "electron",
    files: Object.freeze(["ElectronFuseReader.ts"]),
    // The Linux application inventory marks an executable as Electron when
    // it carries a fuse sentinel. It locates the sentinel with the electron
    // provider's fuse reader instead of searching the fuse wire again.
    reason:
      "the Linux application inventory detects Electron executables with the electron provider's fuse reader",
  }),
  Object.freeze({
    from: "captures",
    to: "pcap",
    files: Object.freeze(["PcapConfiguration.ts"]),
    // Live packet capture runs the same Wireshark tshark that the pcap
    // provider runs. It locates, selects, versions and identity-checks it
    // through pcap's Wireshark tool configuration, so REA_TSHARK_COMMAND and
    // the executable identity rules have one owner.
    reason:
      "live packet capture selects and verifies tshark with the pcap provider's Wireshark tool configuration",
  }),
]);

/** Whether one provider-to-provider import is a declared dependency. */
const isDeclaredProviderDependency = (from, to, target) =>
  PROVIDER_DEPENDENCIES.some(
    (dependency) =>
      dependency.from === from &&
      dependency.to === to &&
      dependency.files.some(
        (file) => sourcePath(target) === `src/${to}/${file}`,
      ),
  );

const sortedCounts = (counts) =>
  Object.fromEntries(
    [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/**
 * Provider boundary facts, counted per unit pair.
 *
 * A provider folder may import the domain, contracts, foundation and ports
 * layers, the shared provider core (its own layer, below providers) and its
 * own files. Any other import of another provider folder is recorded debt
 * unless PROVIDER_DEPENDENCIES declares its target file for that pair:
 * `crossProvider` counts them per pair, and a pair that is not in the
 * baseline fails. Application, composition and the
 * CLI/MCP adapters reach a provider only through its declared ENTRY_FILES, and
 * every unit reaches src/resources only through its `index.ts`: `entry` counts
 * the imports of any other file in such a unit. Both counts may only shrink.
 */
export const providerBoundaryFacts = (imports) => {
  const cross = new Map();
  const entry = new Map();
  for (const { file, target } of imports) {
    const from = sourceUnit(file);
    const to = sourceUnit(target);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from} -> ${to}`;
    if (isProviderUnit(from) && isProviderUnit(to)) {
      if (!isDeclaredProviderDependency(from, to, target))
        cross.set(key, (cross.get(key) ?? 0) + 1);
    } else if (requiresEntry(from, to) && !isEntryFile(to, target))
      entry.set(key, (entry.get(key) ?? 0) + 1);
  }
  return {
    crossProvider: sortedCounts(cross),
    entry: sortedCounts(entry),
  };
};

/** Counted pair maps a baseline ratchets, with the wording of each finding. */
const COUNTED = Object.freeze([
  ["upward", "upward import"],
  ["crossProvider", "cross-provider import"],
  ["entry", "import past the entry file"],
]);

/**
 * Compare facts with the recorded baseline. Growth fails: a new counted pair
 * (upward, cross-provider, or past a provider entry), more imports on a
 * recorded pair, or a cycle group not recorded. Shrinkage is returned
 * separately: the caller fails on it too, so the baseline is lowered in the
 * change that removes the imports and can never grow back silently.
 */
export const compareLayerBaseline = (facts, baseline) => {
  const failures = [];
  const lowerable = [];
  for (const unit of facts.undeclared)
    failures.push(
      `undeclared unit src/${unit}: add it to UNIT_LAYERS in scripts/lib/module-layers.mjs`,
    );
  for (const [kind, label] of COUNTED) {
    const observed = facts[kind] ?? {};
    const recorded = baseline[kind] ?? {};
    for (const [key, count] of Object.entries(observed)) {
      const allowed = recorded[key] ?? 0;
      if (count > allowed)
        failures.push(`${label} ${key}: ${count} imports, baseline ${allowed}`);
    }
    for (const [key, allowed] of Object.entries(recorded)) {
      const count = observed[key] ?? 0;
      if (count < allowed)
        lowerable.push(`${label} ${key}: ${count}, baseline ${allowed}`);
    }
  }
  const recordedCycles = new Set(baseline.cycles);
  for (const group of facts.cycles)
    if (!recordedCycles.has(group))
      failures.push(`mutual import not in baseline: ${group}`);
  const observedCycles = new Set(facts.cycles);
  for (const group of baseline.cycles)
    if (!observedCycles.has(group))
      lowerable.push(`recorded mutual import no longer present: ${group}`);
  return { failures, lowerable };
};

const lowerCounts = (observed = {}, recorded = {}) =>
  Object.fromEntries(
    Object.entries(recorded).flatMap(([key, allowed]) => {
      const count = Math.min(allowed, observed[key] ?? 0);
      return count > 0 ? [[key, count]] : [];
    }),
  );

/**
 * The baseline lowered to the observed facts: each recorded counted pair
 * keeps the smaller of its recorded and observed counts, and only recorded
 * cycles that are still present remain. Nothing is added, so growth still
 * fails.
 */
export const lowerLayerBaseline = (facts, baseline) => ({
  upward: lowerCounts(facts.upward, baseline.upward),
  cycles: baseline.cycles.filter((group) => facts.cycles.includes(group)),
  crossProvider: lowerCounts(facts.crossProvider, baseline.crossProvider),
  entry: lowerCounts(facts.entry, baseline.entry),
});
