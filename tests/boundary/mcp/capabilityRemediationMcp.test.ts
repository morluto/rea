import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, expect, it, onTestFinished } from "vitest";

import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { IdaProvider } from "../../../src/ida/IdaProvider.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  expandToolAvailability,
  toolAvailabilityInventory,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { startJebMcpFixture } from "../../fixtures/jebMcp.js";
import { jebMcpTimeoutGuidance } from "../../../src/jeb/JebMcpDeadline.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  ADB_MISSING_REMEDIATION,
  ADB_NOT_EXECUTABLE_REMEDIATION,
} from "../../../src/adb/AdbConfiguration.js";
import {
  APKTOOL_MISSING_REMEDIATION,
  APKTOOL_NOT_EXECUTABLE_REMEDIATION,
} from "../../../src/apktool/ApktoolConfiguration.js";

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
    // The deadline owner authors the repair; discovery must not restate the failure.
    expect(entry?.remediation).toBe(
      jebMcpTimeoutGuidance("discovery", 100).remediationAction,
    );
    expect(entry?.remediation).toContain("REA_JEB_MCP_TIMEOUT_MS");
    expect(entry?.remediation).not.toContain("deadlineExpired");
  } finally {
    release();
    await fixture.close();
  }
});

it.skipIf(process.platform === "win32").each([
  {
    selection: "non-executable",
    adb: ADB_NOT_EXECUTABLE_REMEDIATION,
    apktool: APKTOOL_NOT_EXECUTABLE_REMEDIATION,
  },
  {
    selection: "missing",
    adb: ADB_MISSING_REMEDIATION,
    apktool: APKTOOL_MISSING_REMEDIATION,
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
    const entries = [
      { setting: "REA_ADB_PATH", repair: adb, names: ["inspect_adb_client"] },
      {
        setting: "REA_APKTOOL_COMMAND",
        repair: apktool,
        names: ["inspect_apktool_client", "decode_android_resources"],
      },
    ];
    for (const { setting, repair, names } of entries)
      for (const name of names) {
        const entry = tools.get(name);
        expect(entry).toMatchObject({ available: false, remediation: repair });
        // Independent of wording: the repair names the setting and matches
        // the observed failure, not the other outcome's repair.
        expect(entry?.remediation).toContain(setting);
        expect(/execute permission/u.test(entry?.remediation ?? "")).toBe(
          selection === "non-executable",
        );
      }
  },
);

it("returns an unready IDA registration's repair from an explicit open_binary selection", async () => {
  const root = await createTestTempDirectory("rea-selection-remediation-");
  const target = join(root, "target.elf");
  await writeFile(target, elf(2, 1, 62));
  const config = parseConfig({
    REA_IDA_MCP_CONFIG: join(root, "missing.json"),
  });
  if (!config.ok) throw config.error;
  const ida = new IdaProvider(config.value, {}, () => {
    throw new Error("Selection must not connect to IDA");
  });
  // The readiness owner is the oracle for the repair the caller receives.
  const owner = await ida.inspectAvailability();
  if (owner.status !== "unavailable")
    throw new Error("A missing registration must be unavailable");
  const session = composeBinarySession(new AnalysisProviderRegistry([ida]));
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const client = new Client({ name: "selection-remediation", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
    const closed = await session.close();
    if (!closed.ok) throw closed.error;
    const released = await ida.closeOwnedResources();
    if (!released.ok) throw released.error;
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { error } = parseMcpToolError(
    (await client.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "ida" },
    })) as CallToolResult,
  );
  expect(error.remediation.action).toBe(owner.remediation);
  expect(error.remediation.action).toContain("REA_IDA_MCP_CONFIG");
  expect(error.details).toMatchObject({
    selection_reason: "provider_unavailable",
    requested_provider_id: "ida",
    rejections: [
      {
        provider_id: "ida",
        origin: "availability",
        reason: owner.reason,
        remediation: owner.remediation,
      },
    ],
  });
});
