import { expect, it } from "vitest";

import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { silentLogger } from "../../../src/logger.js";

const SEED_KINDS = [
  "node-id",
  "route",
  "string",
  "channel",
  "module",
  "native-export",
  "api",
];

const advertisedSeed = async (
  profile: "full" | "compact",
  parentEnvironment: NodeJS.ProcessEnv = process.env,
) => {
  const environment: NodeJS.ProcessEnv = {
    ...parentEnvironment,
    REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    REA_MCP_TOOL_CATALOG_PROFILE: "full",
  };
  delete environment.REA_MCP_TOOL_FAMILIES;
  const harness = await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("tools/list must not acquire a binary provider");
    }),
    serverOptions: {
      logger: silentLogger,
      environment,
    },
    clientIdentity: { name: "trace-seed-guidance", version: "1" },
  });
  const tool = (await harness.client.listTools()).tools.find(
    ({ name }) => name === "trace_application_feature",
  );
  const properties = tool?.inputSchema.properties as
    | Record<string, { description?: string }>
    | undefined;
  return properties?.seed;
};

// The compact profile reduces this schema to shallow properties, which drops
// the seed union and its kind enums. The field description must still name
// every accepted kind so an agent can form a valid seed without the source.
it.each([
  ["full", false],
  ["compact", false],
  ["full", true],
  ["compact", true],
] as const)(
  "names every trace seed kind (%s schema, restricted parent: %s)",
  async (profile, restricted) => {
    const parent = restricted
      ? {
          ...process.env,
          REA_MCP_TOOL_FAMILIES: "native",
          REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold",
        }
      : process.env;
    const seed = await advertisedSeed(profile, parent);
    expect(seed).toBeDefined();
    for (const kind of SEED_KINDS) expect(seed?.description).toContain(kind);
  },
);
