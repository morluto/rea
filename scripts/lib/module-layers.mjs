/**
 * Declared layer of every top-level `src/` unit: each directory, and each
 * root-level source file. Dependencies may point to the same or a lower
 * layer. An undeclared unit fails the check, so a new directory must choose
 * its layer when it is added.
 *
 * The order follows docs/architecture/architecture.mermaid: domain and
 * contracts at the centre, the process/filesystem foundation, provider
 * adapters, shared application workflows, production composition, then the
 * CLI and MCP entry points.
 */
export const LAYER_ORDER = Object.freeze([
  "domain",
  "contracts",
  "foundation",
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
      "process",
      "windows",
      "generatedPackageMetadata.ts",
      "identity.ts",
      "logger.ts",
    ]),
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
export const layerGraphFacts = (imports) => {
  const edges = new Map();
  const undeclared = new Set();
  for (const { file, target } of imports) {
    const from = sourceUnit(file);
    const to = sourceUnit(target);
    if (from === undefined || to === undefined || from === to) continue;
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
  };
};

/**
 * Compare facts with the recorded baseline. Growth fails: a new upward pair,
 * more imports on a recorded pair, or a cycle group not recorded. Shrinkage is
 * returned separately so the baseline can be lowered.
 */
export const compareLayerBaseline = (facts, baseline) => {
  const failures = [];
  const lowerable = [];
  for (const unit of facts.undeclared)
    failures.push(
      `undeclared unit src/${unit}: add it to UNIT_LAYERS in scripts/lib/module-layers.mjs`,
    );
  for (const [key, count] of Object.entries(facts.upward)) {
    const allowed = baseline.upward[key] ?? 0;
    if (count > allowed)
      failures.push(
        `upward import ${key}: ${count} imports, baseline ${allowed}`,
      );
  }
  for (const [key, allowed] of Object.entries(baseline.upward)) {
    const count = facts.upward[key] ?? 0;
    if (count < allowed)
      lowerable.push(`upward import ${key}: ${count}, baseline ${allowed}`);
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
