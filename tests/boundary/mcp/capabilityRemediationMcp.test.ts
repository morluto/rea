import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  expandToolAvailability,
  toolAvailabilityInventory,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { startJebMcpFixture } from "../../fixtures/jebMcp.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

/** Read final capability discovery through the production MCP composition. */
const discoverTools = async (environment: NodeJS.ProcessEnv) => {
  const { client, close } = await createApplicationMcpHarness({
    serverOptions: { environment },
    clientIdentity: { name: "capability-remediation", version: "1" },
    schemaValidator: schemaValidation,
  });
  try {
    const result = await client.callTool({
      name: "binary_session",
      arguments: { detail: "complete" },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const status = toolContract("binary_session").outputSchema.parse(
      result.structuredContent,
    ).result;
    return new Map(
      expandToolAvailability(
        toolAvailabilityInventory.parse(status.tool_availability),
      ).map((tool) => [tool.name, tool]),
    );
  } finally {
    await close();
  }
};

it("names the JEB discovery deadline setting instead of repeating the expired deadline", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await startJebMcpFixture(
    () => null,
    async () => {
      await gate;
      return { tools: [] };
    },
  );
  try {
    const tools = await discoverTools({
      REA_JEB_MCP_URL: fixture.endpoint,
      REA_JEB_MCP_TIMEOUT_MS: "100",
    });
    const entry = tools.get("inspect_jeb_client");
    expect(entry).toMatchObject({
      available: false,
      reason: "provider_unavailable",
    });
    expect(entry?.remediation).toMatch(
      /^Increase REA_JEB_MCP_TIMEOUT_MS in REA's launch environment .* restart and reconnect REA to apply it\./u,
    );
    expect(entry?.remediation).not.toContain("deadlineExpired");
  } finally {
    release();
    await fixture.close();
  }
});

it.skipIf(process.platform === "win32").each([
  {
    selection: "non-executable",
    adb: "Check file type and execute permission for REA_ADB_PATH or select an executable adb binary.",
    apktool:
      "Check file type and execute permission for REA_APKTOOL_COMMAND or select an executable apktool launcher.",
  },
  {
    selection: "missing",
    adb: "Set REA_ADB_PATH to an absolute path to an existing adb binary.",
    apktool:
      "Set REA_APKTOOL_COMMAND to an absolute apktool launcher (the upstream wrapper or a java -jar script).",
  },
] as const)(
  "keeps the owner's repair for a $selection ADB and Apktool selection",
  async ({ selection, adb, apktool }) => {
    const root = await createTestTempDirectory("rea-capability-remediation-");
    const selected = { adb: join(root, "adb"), apktool: join(root, "apktool") };
    if (selection === "non-executable")
      for (const path of Object.values(selected))
        await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const tools = await discoverTools({
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      REA_ADB_PATH: selected.adb,
      REA_APKTOOL_COMMAND: selected.apktool,
    });
    expect(tools.get("inspect_adb_client")).toMatchObject({
      available: false,
      remediation: adb,
    });
    for (const name of ["inspect_apktool_client", "decode_android_resources"])
      expect(tools.get(name)).toMatchObject({
        available: false,
        remediation: apktool,
      });
  },
);
