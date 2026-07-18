import { names } from "./catalog-core.mjs";

/** Build tool-family counts and sorted tool-name lists. */
export const toolFamilyCatalog = (sources) => {
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
      id: "managed",
      surface: "managed",
      contracts: [
        ...sources.managedContracts.MANAGED_TOOL_CONTRACTS,
        ...sources.managedWorkflowContracts.MANAGED_WORKFLOW_TOOL_CONTRACTS,
      ],
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
      id: "application",
      surface: "application-workflow",
      contracts: sources.applicationContracts.APPLICATION_TOOL_CONTRACTS,
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

/** Build provider identities with their sorted capability names. */
export const providerCatalog = (sources) => {
  const applicationContracts =
    sources.electronContracts.ELECTRON_TOOL_CONTRACTS.filter(
      ({ name }) => name === "analyze_javascript_application",
    );
  const reconciliationContracts =
    sources.electronContracts.ELECTRON_TOOL_CONTRACTS.filter(
      ({ name }) => name === "reconcile_javascript_runtime",
    );
  const observationContracts =
    sources.electronContracts.ELECTRON_TOOL_CONTRACTS.filter(
      ({ name }) =>
        name !== "analyze_javascript_application" &&
        name !== "reconcile_javascript_runtime",
    );
  if (
    applicationContracts.length !== 1 ||
    reconciliationContracts.length !== 1 ||
    observationContracts.length !== 2
  )
    throw new Error("Electron provider capability ownership drifted");
  return [
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
      identity: sources.artifactProviders.MANAGED_STATIC_PROVIDER,
      contracts: sources.managedContracts.MANAGED_TOOL_CONTRACTS,
    },
    {
      identity: sources.artifactProviders.MANAGED_WORKFLOW_PROVIDER,
      contracts:
        sources.managedWorkflowContracts.MANAGED_WORKFLOW_TOOL_CONTRACTS,
    },
    {
      identity: sources.browserProvider.CDP_BROWSER_PROVIDER_IDENTITY,
      contracts: sources.browserContracts.BROWSER_TOOL_CONTRACTS,
    },
    {
      identity: sources.electronProvider.CDP_ELECTRON_PROVIDER_IDENTITY,
      contracts: observationContracts,
    },
    {
      identity: sources.artifactProviders.JAVASCRIPT_APPLICATION_PROVIDER,
      contracts: applicationContracts,
    },
    {
      identity:
        sources.artifactProviders.JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER,
      contracts: reconciliationContracts,
    },
    {
      identity:
        sources.artifactProviders.JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
      contracts: sources.applicationContracts.APPLICATION_TOOL_CONTRACTS,
    },
  ]
    .map(({ identity, contracts }) => ({
      id: identity.id,
      name: identity.name,
      version: identity.version,
      capabilities: names(contracts),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
};
