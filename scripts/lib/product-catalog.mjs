import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { Cli } from "incur";
import { format } from "prettier";
import { z } from "zod";

const load = (root, path) => import(pathToFileURL(join(root, path)).href);
const names = (contracts) =>
  contracts
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));

const valuesAt = (node, path) => {
  if (typeof node !== "object" || node === null) return [];
  if ("anyOf" in node && Array.isArray(node.anyOf))
    return node.anyOf.flatMap((alternative) => valuesAt(alternative, path));
  if (path.length === 0)
    return "const" in node &&
      (typeof node.const === "number" || typeof node.const === "string")
      ? [node.const]
      : [];
  if (
    !("properties" in node) ||
    typeof node.properties !== "object" ||
    node.properties === null
  )
    return [];
  const [segment, ...remaining] = path;
  return segment !== undefined && segment in node.properties
    ? valuesAt(node.properties[segment], remaining)
    : [];
};

const versionAt = (schema, path) => {
  const versions = [
    ...new Set(valuesAt(z.toJSONSchema(schema), path).map(String)),
  ];
  if (versions.length !== 1)
    throw new Error(
      `Schema version path ${path.join(".")} has ${String(versions.length)} constant values`,
    );
  const version = versions[0];
  if (version === undefined) throw new Error("Schema version disappeared");
  return /^\d+$/u.test(version) ? Number(version) : version;
};

/** Read primary names and aliases from the actual Incur command router. */
export const createCliInventory = (cli) => {
  const commands = Cli.toCommands.get(cli);
  if (commands === undefined)
    throw new Error("Incur did not expose the registered REA CLI commands");
  const primary = [];
  const aliases = [];
  for (const [name, entry] of commands) {
    if ("_alias" in entry) aliases.push({ name, target: entry.target });
    else primary.push(name);
  }
  return {
    primary: primary.sort((left, right) => left.localeCompare(right)),
    aliases: aliases.sort((left, right) => left.name.localeCompare(right.name)),
  };
};

/** Read one primary command's declared option names from the Incur router. */
export const cliCommandOptionNames = (cli, name) => {
  const commands = Cli.toCommands.get(cli);
  const command = commands?.get(name);
  if (
    command === undefined ||
    "_alias" in command ||
    !("options" in command) ||
    command.options === undefined
  )
    return [];
  const schema = z.toJSONSchema(command.options);
  return Object.keys(schema.properties ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
};

const assertSameNames = (label, actual, expected) => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name));
  const extra = [...actualSet].filter((name) => !expectedSet.has(name));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    `${label} drifted (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
};

const SOURCE_PATHS = {
  packageMetadata: "dist/generatedPackageMetadata.js",
  catalogIdentity: "dist/catalogIdentity.js",
  cli: "dist/cli.js",
  toolContracts: "dist/contracts/toolContracts.js",
  nativeContracts: "dist/contracts/nativeToolContracts.js",
  artifactContracts: "dist/contracts/artifactToolContracts.js",
  browserContracts: "dist/contracts/browserToolContracts.js",
  electronContracts: "dist/contracts/electronToolContracts.js",
  supportedClients: "dist/application/SupportedClients.js",
  hopperProvider: "dist/hopper/HopperProvider.js",
  ghidraProvider: "dist/ghidra/GhidraProvider.js",
  nativeProvider: "dist/native/NativeMacOSProvider.js",
  artifactProviders: "dist/application/InvestigationProviders.js",
  browserProvider: "dist/browser/CdpBrowserProvider.js",
  electronProvider: "dist/browser/CdpElectronProvider.js",
  evidence: "dist/domain/evidence.js",
  evidenceBundle: "dist/domain/evidenceBundle.js",
  processCapture: "dist/domain/processCapture.js",
  analysisSnapshot: "dist/domain/analysisSnapshot.js",
  artifactGraph: "dist/domain/artifactGraph.js",
  investigationWorkspace: "dist/domain/investigationWorkspace.js",
  browserObservation: "dist/domain/browserObservation.js",
  browserSession: "dist/domain/browserSession.js",
  electronObservation: "dist/domain/electronObservation.js",
  webBundleAnalysis: "dist/domain/webBundleAnalysis.js",
  webCaptureDiff: "dist/domain/webCaptureDiff.js",
  webMcpDiscovery: "dist/domain/webMcpDiscovery.js",
  webScreenshot: "dist/domain/webScreenshot.js",
  javascriptApplicationGraph: "dist/domain/javascriptApplicationGraph.js",
  reconstructionVerification:
    "dist/domain/reconstructionVerificationSchemas.js",
  residualUnknown: "dist/domain/residualUnknown.js",
};

const loadSources = async (root) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(SOURCE_PATHS).map(async ([key, path]) => [
        key,
        await load(root, path),
      ]),
    ),
  );

const toolFamilyCatalog = (sources) => {
  const families = [
    {
      id: "direct",
      surface: "official-proxy",
      contracts: sources.toolContracts.OFFICIAL_TOOL_CONTRACTS,
    },
    {
      id: "enhanced",
      surface: "enhanced",
      contracts: sources.toolContracts.ENHANCED_TOOL_CONTRACTS,
    },
    {
      id: "native",
      surface: "native-provider",
      contracts: sources.nativeContracts.NATIVE_TOOL_CONTRACTS,
    },
    {
      id: "artifact",
      surface: "artifact-provider",
      contracts: sources.artifactContracts.ARTIFACT_TOOL_CONTRACTS,
    },
    {
      id: "browser",
      surface: "browser-provider",
      contracts: sources.browserContracts.BROWSER_TOOL_CONTRACTS,
    },
    {
      id: "electron",
      surface: "electron-provider",
      contracts: sources.electronContracts.ELECTRON_TOOL_CONTRACTS,
    },
    {
      id: "session",
      surface: "session",
      contracts: sources.toolContracts.SESSION_TOOL_CONTRACTS,
    },
  ].map(({ id, surface, contracts }) => ({
    id,
    surface,
    count: contracts.length,
    tools: names(contracts),
  }));
  const familyTotal = families.reduce(
    (total, family) => total + family.count,
    0,
  );
  if (
    familyTotal !== sources.toolContracts.TOOL_CONTRACTS.length ||
    familyTotal !== sources.catalogIdentity.CATALOG_IDENTITY.counts.mcp_tools
  )
    throw new Error("Tool family inventory does not match TOOL_CONTRACTS");
  return { total: familyTotal, families };
};

const providerCatalog = (sources) =>
  [
    {
      identity: sources.hopperProvider.HOPPER_PROVIDER_IDENTITY,
      contracts: sources.hopperProvider.HOPPER_PROVIDER_TOOL_CONTRACTS,
    },
    {
      identity: sources.ghidraProvider.GHIDRA_PROVIDER_IDENTITY,
      contracts: sources.ghidraProvider.GHIDRA_PROVIDER_TOOL_CONTRACTS,
    },
    {
      identity: sources.nativeProvider.NATIVE_MACOS_PROVIDER_IDENTITY,
      contracts: sources.nativeContracts.NATIVE_TOOL_CONTRACTS,
    },
    {
      identity: sources.artifactProviders.ARTIFACT_GRAPH_PROVIDER,
      contracts: sources.artifactContracts.ARTIFACT_TOOL_CONTRACTS,
    },
    {
      identity: sources.browserProvider.CDP_BROWSER_PROVIDER_IDENTITY,
      contracts: sources.browserContracts.BROWSER_TOOL_CONTRACTS,
    },
    {
      identity: sources.electronProvider.CDP_ELECTRON_PROVIDER_IDENTITY,
      contracts: sources.electronContracts.ELECTRON_TOOL_CONTRACTS,
    },
  ]
    .map(({ identity, contracts }) => ({
      id: identity.id,
      name: identity.name,
      version: identity.version,
      capabilities: names(contracts),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

const durableSchemaDefinitions = (sources) => [
  [
    "analysis_snapshot",
    sources.analysisSnapshot.analysisSnapshotSchema,
    ["snapshot_version"],
  ],
  [
    "artifact_graph",
    sources.artifactGraph.artifactInventoryResultSchema,
    ["manifest", "schema_version"],
  ],
  [
    "artifact_extraction",
    sources.artifactGraph.artifactExtractionResultSchema,
    ["extraction_manifest", "schema_version"],
  ],
  ["evidence", sources.evidence.evidenceSchema, ["schema_version"]],
  [
    "evidence_bundle",
    sources.evidenceBundle.evidenceBundleSchema,
    ["bundle_version"],
  ],
  [
    "investigation_run",
    sources.investigationWorkspace.investigationRunSchema,
    ["schema_version"],
  ],
  [
    "investigation_run_summary",
    sources.investigationWorkspace.investigationRunSummarySchema,
    ["schema_version"],
  ],
  [
    "investigation_workspace",
    sources.investigationWorkspace.investigationWorkspaceSchema,
    ["workspace_version"],
  ],
  [
    "javascript_application_graph",
    sources.javascriptApplicationGraph.javascriptApplicationGraphSchema,
    ["schema_version"],
  ],
  [
    "process_capture",
    sources.processCapture.processCaptureSchema,
    ["schema_version"],
  ],
  [
    "reconstruction_verification",
    sources.reconstructionVerification.reconstructionSpecificationSchema,
    ["schema_version"],
  ],
  [
    "residual_unknown",
    sources.residualUnknown.residualUnknownSchema,
    ["registry_version"],
  ],
];

const observationSchemaDefinitions = (sources) => [
  [
    "browser_target_list",
    sources.browserObservation.browserTargetListSchema,
    ["schema_version"],
  ],
  [
    "electron_page_inspection",
    sources.electronObservation.electronPageInspectionSchema,
    ["schema_version"],
  ],
  [
    "electron_target_list",
    sources.electronObservation.electronTargetListSchema,
    ["schema_version"],
  ],
  [
    "web_bundle_analysis",
    sources.webBundleAnalysis.webBundleAnalysisSchema,
    ["schema_version"],
  ],
  [
    "web_capture_diff",
    sources.webCaptureDiff.webCaptureDiffSchema,
    ["schema_version"],
  ],
  [
    "web_mcp_discovery",
    sources.webMcpDiscovery.webMcpDiscoverySchema,
    ["schema_version"],
  ],
  [
    "web_observation_session",
    sources.browserSession.webObservationSessionSchema,
    ["schema_version"],
  ],
  [
    "web_page_inspection",
    sources.browserObservation.webPageInspectionSchema,
    ["schema_version"],
  ],
  [
    "web_screenshot",
    sources.webScreenshot.webScreenshotSchema,
    ["schema_version"],
  ],
  [
    "web_screenshot_diff",
    sources.webScreenshot.webScreenshotDiffSchema,
    ["schema_version"],
  ],
];

const schemaCatalog = (sources) =>
  [
    ...durableSchemaDefinitions(sources),
    ...observationSchemaDefinitions(sources),
  ]
    .map(([id, schema, path]) => {
      try {
        return { id, version: versionAt(schema, path) };
      } catch (cause) {
        throw new Error(`Could not derive ${id} schema version`, { cause });
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));

/** Project current runtime contracts into deterministic, machine-readable facts. */
export const createProductCatalog = async (root) => {
  const sources = await loadSources(root);
  const cli = createCliInventory(sources.cli.createCli());
  assertSameNames(
    "Primary CLI inventory",
    cli.primary,
    sources.catalogIdentity.CLI_COMMAND_NAMES,
  );
  const tools = toolFamilyCatalog(sources);
  const metadata = sources.packageMetadata.PACKAGE_METADATA;
  return {
    catalog_schema_version: 1,
    package: {
      name: metadata.name,
      version: metadata.version,
      sdk: {
        server: metadata.serverSdkVersion,
        client: metadata.clientSdkVersion,
        core: metadata.coreSdkVersion,
      },
      skill_version: metadata.skillVersion,
    },
    tools,
    providers: providerCatalog(sources),
    setup_clients: sources.supportedClients.SUPPORTED_CLIENT_DEFINITIONS.map(
      ({ name, displayName, format }) => ({
        id: name,
        display_name: displayName,
        format,
        configuration: format === "unsupported" ? "detect-only" : "managed",
      }),
    ),
    schemas: schemaCatalog(sources),
    cli: {
      primary_count: cli.primary.length,
      commands: cli.primary,
      aliases: cli.aliases,
    },
    runtime_catalog: {
      counts: sources.catalogIdentity.CATALOG_IDENTITY.counts,
      digests: sources.catalogIdentity.CATALOG_IDENTITY.digests,
    },
  };
};

/** Stable checked-in representation of the product catalog. */
export const serializeProductCatalog = (catalog) =>
  format(JSON.stringify(catalog, null, 2), { parser: "json" });
