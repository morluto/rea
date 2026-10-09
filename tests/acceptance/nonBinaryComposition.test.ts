import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";

import { createAndroidAnalysisProvider } from "../../src/composition/android.js";
import { createFirmwareAnalysisProvider } from "../../src/composition/firmware.js";
import { createJavaScriptRecoveryProvider } from "../../src/composition/javascriptRecovery.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { writeOrderedZip } from "../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const connect = async (environment: NodeJS.ProcessEnv) => {
  const session = createTestBinarySession(() => {
    throw new Error("Target-free analysis must not acquire a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      androidAnalysis: createAndroidAnalysisProvider(environment),
      firmwareAnalysis: createFirmwareAnalysisProvider(environment),
      javascriptRecovery: createJavaScriptRecoveryProvider(environment),
    },
  );
  const client = new Client({ name: "composition-parity", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

for (const { jarConfigured, setting } of [
  { jarConfigured: false, setting: "REA_JADX_MCP_JAR" },
  { jarConfigured: true, setting: "JAVA_HOME" },
])
  cliTest.skipIf(process.platform === "win32")(
    `preserves the APK ${setting} failure through the compiled CLI and MCP factories`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-android-composition-");
      const apk = join(root, "fixture.apk");
      await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
      const jar = join(root, "jadx-headless-mcp.jar");
      await writeFile(
        jar,
        "fixture jar; validation must fail before execution",
      );
      const environment = {
        REA_LOG_LEVEL: "silent",
        JAVA_HOME: "relative-fixture-jdk",
        ...(jarConfigured ? { REA_JADX_MCP_JAR: jar } : {}),
      };
      const cliResult = await cli.run({
        arguments: ["inspect-android-package", apk, "--json"],
        environment,
        timeoutMs: 10_000,
      });
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.json).toMatchObject({ code: "capability_unavailable" });
      const client = await connect(environment);
      const response = await client.callTool({
        name: "inspect_android_package",
        arguments: { path: apk },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response)).toEqual({ error: cliResult.json });
      expect(JSON.stringify(parseMcpToolError(response))).toContain(setting);
    },
  );

cliTest.skipIf(process.platform !== "linux")(
  "preserves the missing firmware command reason through both caller paths",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-firmware-composition-");
    const path = join(root, "input.bin");
    await writeFile(path, "firmware fixture");
    const environment = { REA_LOG_LEVEL: "silent" };
    const cliResult = await cli.run({
      arguments: ["inspect-firmware-regions", path, "--json"],
      environment,
      timeoutMs: 10_000,
    });
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.json).toMatchObject({ code: "capability_unavailable" });
    const client = await connect(environment);
    const response = await client.callTool({
      name: "inspect_firmware_regions",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response)).toEqual({ error: cliResult.json });
    expect(JSON.stringify(parseMcpToolError(response))).toContain(
      "REA_BINWALK_COMMAND",
    );
  },
);

cliTest.skipIf(process.platform !== "linux")(
  "resolves relative firmware CLI paths against the operator working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-firmware-cli-relative-");
    await writeFile(join(root, "input.bin"), "firmware fixture");
    const cliResult = await cli.run({
      arguments: ["inspect-firmware-regions", "input.bin", "--json"],
      cwd: root,
      environment: { REA_LOG_LEVEL: "silent" },
      timeoutMs: 10_000,
    });
    // A relative path must pass input validation and reach the provider,
    // which reports the missing firmware engine — not a validation error.
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.json).toMatchObject({ code: "capability_unavailable" });
  },
);

cliTest(
  "preserves optional JavaScript recovery configuration through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-recovery-composition-");
    const path = join(root, "bundle.js");
    await writeFile(path, "globalThis.fixture = 1;");
    const environment = {
      REA_LOG_LEVEL: "silent",
      REA_WAKARU_COMMAND: "relative-unavailable-tool",
    };
    const cliResult = await cli.run({
      arguments: [
        "recover-javascript-sources",
        path,
        join(root, "output"),
        "--json",
      ],
      environment,
      timeoutMs: 10000,
    });
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.json).toMatchObject({ code: "capability_unavailable" });
    const client = await connect(environment);
    const response = await client.callTool({
      name: "recover_javascript_sources",
      arguments: { path, output_directory: join(root, "output") },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response)).toEqual({ error: cliResult.json });
    expect(JSON.stringify(parseMcpToolError(response))).toContain(
      "REA_WAKARU_COMMAND",
    );
  },
);

cliTest(
  "returns recovery path diagnostics before missing-engine errors in CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-recovery-path-parity-");
    const environment = {
      REA_LOG_LEVEL: "silent",
      REA_WAKARU_COMMAND: "relative-unavailable-tool",
    };
    const client = await connect(environment);
    for (const field of ["path", "output_directory"] as const) {
      const input = {
        path: join(root, "bundle.js"),
        output_directory: join(root, "output"),
        [field]: "relative.js",
      };
      const result = await cli.run({
        arguments: [
          "recover-javascript-sources",
          input.path,
          input.output_directory,
          "--json",
        ],
        environment,
        timeoutMs: 10_000,
      });
      const response = await client.callTool({
        name: "recover_javascript_sources",
        arguments: input,
      });
      expect(result.exitCode).toBe(1);
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response)).toEqual({ error: result.json });
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "recover_javascript_sources",
          issues: [{ path: [field], reason: "invalid_format" }],
        },
      });
    }
  },
);
