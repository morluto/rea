import { names } from "./catalog-core.mjs";

/** Build tool-family counts and sorted tool-name lists. */
export const toolFamilyCatalog = (sources) => {
  const families = sources.toolFamilies.TOOL_FAMILY_DEFINITIONS.map(
    ({ id, surface, contracts }) => ({
      id,
      surface,
      count: contracts.length,
      tools: names(contracts),
    }),
  );
  const familyTotal = families.reduce(
    (total, family) => total + family.count,
    0,
  );
  if (
    familyTotal !== sources.toolContracts.TOOL_CONTRACTS.length ||
    familyTotal !==
      sources.catalogIdentity.FULL_CATALOG_IDENTITY.counts.mcp_tools
  )
    throw new Error("Tool family inventory does not match TOOL_CONTRACTS");
  return { total: familyTotal, families };
};

/** Derive provider capabilities from the same static declarations used by composition. */
export const providerCatalog = (sources) => {
  const contractNames = new Set(
    sources.toolContracts.TOOL_CONTRACTS.map(({ name }) => name),
  );
  const providers = new Map();
  for (const declaration of Object.values(
    sources.capabilityDeclarations.CAPABILITY_DECLARATIONS,
  )) {
    for (const { identity, operations } of declaration.providers) {
      let provider = providers.get(identity.id);
      if (provider === undefined) {
        provider = { ...identity, capabilities: new Set() };
        providers.set(identity.id, provider);
      } else if (
        provider.name !== identity.name ||
        provider.version !== identity.version
      ) {
        throw new TypeError(
          `Provider ${identity.id} has conflicting source identities`,
        );
      }
      let selectedOperations = operations;
      if (!Array.isArray(operations)) {
        const contracts =
          sources.toolFamilies.TOOL_CONTRACT_GROUPS[operations.group];
        if (contracts === undefined)
          throw new TypeError(
            `Provider ${identity.id} declares an unknown contract group: ${operations.group}`,
          );
        selectedOperations = contracts.map(({ name }) => name);
      }
      for (const operation of selectedOperations) {
        if (!contractNames.has(operation))
          throw new TypeError(
            `Provider ${identity.id} declares an unknown analyst operation: ${operation}`,
          );
        provider.capabilities.add(operation);
      }
    }
  }
  return [...providers.values()]
    .map(({ id, name, version, capabilities }) => ({
      id,
      name,
      version,
      capabilities: [...capabilities].sort((left, right) =>
        left.localeCompare(right),
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
};
