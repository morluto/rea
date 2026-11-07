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

const advertisedSeed = async (profile: "full" | "compact") => {
  const harness = await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("tools/list must not acquire a binary provider");
    }),
    serverOptions: {
      logger: silentLogger,
      environment: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: profile },
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
it.each(["full", "compact"] as const)(
  "names every trace seed kind in the advertised seed field (%s profile)",
  async (profile) => {
    const seed = await advertisedSeed(profile);
    expect(seed).toBeDefined();
    for (const kind of SEED_KINDS) expect(seed?.description).toContain(kind);
  },
);
