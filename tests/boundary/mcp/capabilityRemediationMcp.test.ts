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
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
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
      /jeb\.mcp_timeout_ms.*update_analysis_settings.*REA_JEB_MCP_TIMEOUT_MS/iu,
    );
    expect(entry?.remediation).toMatch(
      /catalog discovery.*tools\/call.*cleanup.*headroom/iu,
    );
    expect(entry?.remediation).toMatch(
      /confirm outstanding work and cleanup before retrying/iu,
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
    adb: /absolute path.*adb executable.*execute permission.*search permission/iu,
    apktool: /file type and execute permission.*executable apktool launcher/iu,
  },
  {
    selection: "missing",
    adb: /absolute path.*existing adb binary/iu,
    apktool: /absolute apktool launcher.*wrapper.*java -jar/iu,
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
        expect(entry).toMatchObject({
          available: false,
          remediation: expect.stringMatching(repair),
        });
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

it.skipIf(process.platform === "win32")(
  "marks inspect_with_objdump unavailable in binary_session after launch failure and restores it after repair",
  async () => {
    const root = await createTestTempDirectory("rea-objdump-remediation-");
    const missingCommand = join(root, "missing-objdump");
    const { client, close } = await createApplicationMcpHarness({
      serverOptions: {
        environment: {
          REA_OBJDUMP_COMMAND: missingCommand,
        },
      },
      clientIdentity: { name: "objdump-remediation", version: "1" },
      schemaValidator: schemaValidation,
    });
    try {
      const initialSession = await client.callTool({
        name: "binary_session",
        arguments: { detail: "complete" },
      });
      expect(initialSession.isError).not.toBe(true);
      const initialStatus = toolContract("binary_session").outputSchema.parse(
        initialSession.structuredContent,
      ).result;
      const initialTools = new Map(
        expandToolAvailability(
          toolAvailabilityInventory.parse(initialStatus.tool_availability),
        ).map((tool) => [tool.name, tool]),
      );
      expect(initialTools.get("inspect_with_objdump")).toMatchObject({
        available: true,
        reason: "available",
        remediation: null,
      });

      const failed = (await client.callTool({
        name: "inspect_with_objdump",
        arguments: { operation: "architectures" },
      })) as CallToolResult;
      expect(failed.isError).toBe(true);
      const parsedFailure = parseMcpToolError(failed);
      expect(parsedFailure.error.code).toBe("capability_unavailable");
      expect(parsedFailure.error.details).toMatchObject({
        diagnostics: {
          boundary: "provider-launch",
          command: missingCommand,
        },
      });

      const afterFailedSession = await client.callTool({
        name: "binary_session",
        arguments: { detail: "complete" },
      });
      expect(afterFailedSession.isError).not.toBe(true);
      const afterFailedStatus = toolContract(
        "binary_session",
      ).outputSchema.parse(afterFailedSession.structuredContent).result;
      const afterFailedTools = new Map(
        expandToolAvailability(
          toolAvailabilityInventory.parse(afterFailedStatus.tool_availability),
        ).map((tool) => [tool.name, tool]),
      );
      expect(afterFailedTools.get("inspect_with_objdump")).toMatchObject({
        available: false,
        reason: "provider_unavailable",
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      });

      await writeFile(missingCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const retried = await client.callTool({
        name: "inspect_with_objdump",
        arguments: { operation: "architectures" },
      });
      expect(retried.isError).not.toBe(true);

      const recoveredSession = await client.callTool({
        name: "binary_session",
        arguments: { detail: "complete" },
      });
      expect(recoveredSession.isError).not.toBe(true);
      const recoveredStatus = toolContract("binary_session").outputSchema.parse(
        recoveredSession.structuredContent,
      ).result;
      const recoveredTools = new Map(
        expandToolAvailability(
          toolAvailabilityInventory.parse(recoveredStatus.tool_availability),
        ).map((tool) => [tool.name, tool]),
      );
      expect(recoveredTools.get("inspect_with_objdump")).toMatchObject({
        available: true,
        reason: "available",
        remediation: null,
      });
    } finally {
      await close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "marks execute_rizin_command unavailable in binary_session after real target launch failure and restores it after repair",
  async () => {
    const root = await createTestTempDirectory("rea-rizin-remediation-");
    const target = join(root, "sample.bin");
    const missingRizin = join(root, "missing-rizin");
    await writeFile(target, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
    const { client, close } = await createApplicationMcpHarness({
      serverOptions: {
        environment: {
          REA_RIZIN_COMMAND: missingRizin,
        },
      },
      clientIdentity: { name: "rizin-remediation", version: "1" },
      schemaValidator: schemaValidation,
    });
    try {
      const initialSession = await client.callTool({
        name: "binary_session",
        arguments: { detail: "complete" },
      });
      expect(initialSession.isError).not.toBe(true);
      const initialStatus = toolContract("binary_session").outputSchema.parse(
        initialSession.structuredContent,
      ).result;
      const initialTools = new Map(
        expandToolAvailability(
          toolAvailabilityInventory.parse(initialStatus.tool_availability),
        ).map((tool) => [tool.name, tool]),
      );
      expect(initialTools.get("execute_rizin_command")).toMatchObject({
        available: true,
        reason: "available",
        remediation: null,
      });

      const failed = (await client.callTool({
        name: "execute_rizin_command",
        arguments: { path: target, command: "iI" },
      })) as CallToolResult;
      expect(failed.isError).toBe(true);
      const parsedFailure = parseMcpToolError(failed);
      expect(parsedFailure.error.code).toBe("capability_unavailable");
      expect(parsedFailure.error.details).toMatchObject({
        provider_id: "rizin",
        diagnostics: {
          boundary: "provider-launch",
          command: missingRizin,
          system_code: "ENOENT",
        },
      });

      const afterFailedSession = await client.callTool({
        name: "binary_session",
        arguments: { detail: "complete" },
      });
      expect(afterFailedSession.isError).not.toBe(true);
      const afterFailedStatus = toolContract(
        "binary_session",
      ).outputSchema.parse(afterFailedSession.structuredContent).result;
      const afterFailedTools = new Map(
        expandToolAvailability(
          toolAvailabilityInventory.parse(afterFailedStatus.tool_availability),
        ).map((tool) => [tool.name, tool]),
      );
      expect(afterFailedTools.get("execute_rizin_command")).toMatchObject({
        available: false,
        reason: "provider_unavailable",
        remediation: expect.stringContaining("REA_RIZIN_COMMAND"),
      });

      await writeFile(missingRizin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const retried = await client.callTool({
        name: "execute_rizin_command",
        arguments: { path: target, command: "iI" },
      });
      expect(retried.isError).not.toBe(true);

      const recoveredSession = await client.callTool({
        name: "binary_session",
        arguments: { detail: "complete" },
      });
      expect(recoveredSession.isError).not.toBe(true);
      const recoveredStatus = toolContract("binary_session").outputSchema.parse(
        recoveredSession.structuredContent,
      ).result;
      const recoveredTools = new Map(
        expandToolAvailability(
          toolAvailabilityInventory.parse(recoveredStatus.tool_availability),
        ).map((tool) => [tool.name, tool]),
      );
      expect(recoveredTools.get("execute_rizin_command")).toMatchObject({
        available: true,
        reason: "available",
        remediation: null,
      });
    } finally {
      await close();
    }
  },
);
