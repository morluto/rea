import { formatGeneratedFile } from "./format-generated-file.mjs";

import { assertSameNames, digest, loadSources } from "./catalog-core.mjs";
import {
  createCliInventory,
  cliCommandDescriptionIssues,
  cliCommandOptionNames,
} from "./catalog-cli.mjs";
import { providerCatalog, toolFamilyCatalog } from "./catalog-builders.mjs";

export {
  createCliInventory,
  cliCommandDescriptionIssues,
  cliCommandOptionNames,
};

/** Return the stable digest for the source-derived provider projection. */
export const providerCatalogDigest = (providers) => digest(providers);

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
  const providers = providerCatalog(sources);
  const metadata = sources.packageMetadata.PACKAGE_METADATA;
  return {
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
    providers,
    setup_clients: sources.supportedClients.SUPPORTED_CLIENT_DEFINITIONS.map(
      ({ name, displayName, format }) => ({
        id: name,
        display_name: displayName,
        format,
        configuration: format === "unsupported" ? "detect-only" : "managed",
      }),
    ),
    cli: {
      primary_count: cli.primary.length,
      commands: cli.primary,
      aliases: cli.aliases,
    },
    runtime_catalog: {
      counts: sources.catalogIdentity.CATALOG_IDENTITY.counts,
      digests: {
        ...sources.catalogIdentity.CATALOG_IDENTITY.digests,
        providers_sha256: providerCatalogDigest(providers),
      },
    },
  };
};

/** Stable checked-in representation of the product catalog. */
export const serializeProductCatalog = (catalog) =>
  formatGeneratedFile(
    "docs/product-catalog.json",
    JSON.stringify(catalog, null, 2),
  );
