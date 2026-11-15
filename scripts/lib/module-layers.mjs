/**
 * Declared layer of every top-level `src/` unit: each directory, and each
 * root-level source file. Dependencies may point to the same or a lower
 * layer. An undeclared unit fails the check, so a new directory must choose
 * its layer when it is added.
 *
 * The order follows docs/architecture/architecture.mermaid: domain and
 * contracts at the centre, the process/filesystem foundation, the ports
 * that providers implement and application consumes, provider adapters,
 * shared application workflows, production composition, then the CLI and
 * MCP entry points.
 */
export const LAYER_ORDER = Object.freeze([
  "domain",
  "contracts",
  "foundation",
  "ports",
  "providers",
  "application",
  "composition",
  "adapters",
]);

const units = (layer, names) => names.map((name) => [name, layer]);

export const UNIT_LAYERS = Object.freeze(
  Object.fromEntries([
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
    // Every unit here except the shared provider core (`providers`) is a
    // provider folder; see PROVIDER_CORE and providerBoundaryFacts.
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
      "providers",
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
      "catalogDiscovery.ts",
      "catalogIdentity.ts",
      "cli.ts",
      "cliBrowserScenarioCommands.ts",
      "cliBuiltinArguments.ts",
      "cliCommandNames.ts",
      "cliConfiguration.ts",
      "cliEvidenceCommands.ts",
      "cliJsonInput.ts",
      "cliLogging.ts",
      "cliObservationOptions.ts",
      "cliOneShot.ts",
      "cliOutput.ts",
      "doctorRuntime.ts",
      "main.ts",
      "mcpDoctor.ts",
      "mcpDoctorOptions.ts",
      "mcpStartupPolicy.ts",
      "recordedCatalogDigests.ts",
      "recordedCliCommandRegistrations.ts",
      "recordedMcpCatalog.ts",
      "serverIdentity.ts",
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

/** The shared provider core that every provider folder may import. */
export const PROVIDER_CORE = "providers";

/** Whether a unit is a provider folder (not the shared provider core). */
export const isProviderUnit = (unit) =>
  UNIT_LAYERS[unit] === "providers" && unit !== PROVIDER_CORE;

const ENTRY_IMPORTER_LAYERS = new Set([
  "application",
  "composition",
  "adapters",
]);

const sortedCounts = (counts) =>
  Object.fromEntries(
    [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/**
 * Provider boundary facts, counted per unit pair.
 *
 * A provider folder may import the domain, contracts, foundation and ports
 * layers, the shared provider core and its own files. An import of another
 * provider folder is an explicit, recorded exception (for example inspector
 * reusing browser's CDP helpers): `crossProvider` counts them per pair, and a
 * pair that is not in the baseline fails. Application, composition and the
 * CLI/MCP adapters reach a provider only through its entry file
 * `src/<provider>/index.ts`: `providerEntry` counts their imports of any other
 * file in a provider folder. Both counts may only shrink.
 */
export const providerBoundaryFacts = (imports) => {
  const cross = new Map();
  const entry = new Map();
  for (const { file, target } of imports) {
    const from = sourceUnit(file);
    const to = sourceUnit(target);
    if (from === undefined || to === undefined || from === to) continue;
    if (!isProviderUnit(to)) continue;
    const key = `${from} -> ${to}`;
    if (isProviderUnit(from)) cross.set(key, (cross.get(key) ?? 0) + 1);
    else if (
      ENTRY_IMPORTER_LAYERS.has(UNIT_LAYERS[from]) &&
      sourcePath(target) !== `src/${to}/index.ts`
    )
      entry.set(key, (entry.get(key) ?? 0) + 1);
  }
  return {
    crossProvider: sortedCounts(cross),
    providerEntry: sortedCounts(entry),
  };
};

/** Counted pair maps a baseline ratchets, with the wording of each finding. */
const COUNTED = Object.freeze([
  ["upward", "upward import"],
  ["crossProvider", "cross-provider import"],
  ["providerEntry", "import past the provider entry"],
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
  providerEntry: lowerCounts(facts.providerEntry, baseline.providerEntry),
});
