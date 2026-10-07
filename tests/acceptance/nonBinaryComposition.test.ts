import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";

import { createAndroidAnalysisProvider } from "../../src/composition/android.js";
import { createFirmwareAnalysisProvider } from "../../src/composition/firmware.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { writeOrderedZip } from "../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const connect = async (environment: NodeJS.ProcessEnv) => {
  const session = createTestBinarySession(() => {
    throw new Error("Target-free analysis must not acquire a deep provider");
  });
  const server = createServer(session, session, {
    androidAnalysis: createAndroidAnalysisProvider(environment),
    firmwareAnalysis: createFirmwareAnalysisProvider(environment),
  });
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

cliTest.skipIf(process.platform === "win32")(
  "preserves the selected APK configuration through the compiled CLI and MCP factories",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-composition-");
    const apk = join(root, "fixture.apk");
    await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
    const environment = {
      REA_LOG_LEVEL: "silent",
      JAVA_HOME: "relative-fixture-jdk",
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
    expect(response.structuredContent).toEqual({ error: cliResult.json });
    expect(JSON.stringify(response.structuredContent)).toContain("JAVA_HOME");
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
    expect(response.structuredContent).toEqual({ error: cliResult.json });
    expect(JSON.stringify(response.structuredContent)).toContain(
      "REA_BINWALK_COMMAND",
    );
  },
);
