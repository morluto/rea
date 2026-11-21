import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";

import { createOwnedMcpStdioTransport } from "./owned-mcp-stdio.mjs";
import { VerifierFixture, withVerifierFixture } from "./verifier-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Profile combinations whose listings advertise every distinct schema. The
 * catalog profile changes the tool set (hot/cold adds `discover_tools`), so
 * each catalog profile is listed with every input and every output profile,
 * paired in turn rather than as their product: input and output presentations
 * are selected by separate settings, and each listing starts a server process.
 * advertisedDialect.test.ts lists the full product in process.
 */
const advertisedProfiles = async () => {
  const [
    { mcpInputSchemaProfileSchema },
    { mcpOutputSchemaProfileSchema },
    { mcpToolCatalogProfileSchema },
  ] = await Promise.all([
    import("../../dist/config/mcpInputSchemaProfile.js"),
    import("../../dist/config/mcpOutputSchemaProfile.js"),
    import("../../dist/config/mcpToolCatalogProfile.js"),
  ]);
  const inputs = mcpInputSchemaProfileSchema.options;
  const outputs = mcpOutputSchemaProfileSchema.options;
  const count = Math.max(inputs.length, outputs.length);
  return mcpToolCatalogProfileSchema.options.flatMap((catalog) =>
    Array.from({ length: count }, (_, index) => ({
      input: inputs[index % inputs.length],
      output: outputs[index % outputs.length],
      catalog,
    })),
  );
};

/** List tools from the packaged stdio entry, as an installed client does. */
const listPackagedTools = async (profile, packageRoot) => {
  // The listing must not depend on the developer's account or configuration.
  const fixture = await VerifierFixture.open({
    prefix: "rea-advertised-catalog-",
  });
  const home = fixture.path;
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    REA_MCP_INPUT_SCHEMA_PROFILE: profile.input,
    REA_MCP_OUTPUT_SCHEMA_PROFILE: profile.output,
    REA_MCP_TOOL_CATALOG_PROFILE: profile.catalog,
  };
  if (process.env.SystemRoot !== undefined)
    environment.SystemRoot = process.env.SystemRoot;
  return withVerifierFixture(fixture, async () => {
    // The process owner stops the server's whole process tree on close, and
    // the fixture keeps its home until that cleanup confirms.
    const transport = await createOwnedMcpStdioTransport({
      command: process.execPath,
      arguments: [join(packageRoot, "scripts/rea.mjs"), "mcp"],
      cwd: home,
      hostEnvironment: environment,
      expectedCommand: null,
      sweepTokenOwnedProcesses: true,
    });
    const client = new Client({ name: "rea-advertised-catalog", version: "1" });
    fixture.releaseAfter(() => client.close());
    try {
      await client.connect(transport);
      return (await client.listTools()).tools;
    } catch (cause) {
      throw new Error(
        `packaged MCP listing failed for ${describeProfile(profile)}: ${String(cause)}\n${transport.diagnostics()?.stderr ?? ""}`,
        { cause },
      );
    }
  });
};

/** `input/output/catalog`, as reported beside every finding. */
const describeProfile = ({ input, output, catalog }) =>
  `${input}/${output}/${catalog}`;

/**
 * The packaged server's tools/list for every profile combination, listed
 * concurrently from separate server processes. `packageRoot` selects an
 * installed package instead of this checkout's build.
 */
export const listAdvertisedCatalogs = async (packageRoot = root) => {
  const profiles = await advertisedProfiles();
  return Promise.all(
    profiles.map(async (profile) => ({
      profile,
      tools: await listPackagedTools(profile, packageRoot),
    })),
  );
};

/** Each advertised schema with every place it is advertised. */
export const distinctAdvertisedSchemas = (catalogs) => {
  const schemas = new Map();
  for (const { profile, tools } of catalogs)
    for (const tool of tools)
      for (const kind of ["inputSchema", "outputSchema"]) {
        const schema = tool[kind];
        if (schema === undefined) continue;
        const key = JSON.stringify(schema);
        const site = {
          profile: describeProfile(profile),
          tool: tool.name,
          kind,
        };
        const entry = schemas.get(key);
        if (entry === undefined) schemas.set(key, { schema, sites: [site] });
        else entry.sites.push(site);
      }
  return [...schemas.values()];
};
