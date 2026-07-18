import { format } from "prettier";

import { assertSameNames, loadSources } from "./catalog-core.mjs";
import {
  createCliInventory,
  cliCommandDescriptionIssues,
  cliCommandOptionNames,
} from "./catalog-cli.mjs";
import { providerCatalog, toolFamilyCatalog } from "./catalog-builders.mjs";
import { schemaCatalog } from "./catalog-schemas.mjs";

export {
  createCliInventory,
  cliCommandDescriptionIssues,
  cliCommandOptionNames,
};

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
