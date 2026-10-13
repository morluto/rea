import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { AdbProvider } from "../../../src/adb/AdbProvider.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const responseText = (response: { readonly content: readonly unknown[] }) =>
  response.content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");

const createFakeAdb = async () => {
  const directory = await createTestTempDirectory("rea-adb-start-mcp-");
  const binary = join(directory, "adb");
  const stdoutFile = join(directory, "stdout");
  const stderrFile = join(directory, "stderr");
  const callsFile = join(directory, "calls");
  const fakeAdbSource = `#!/usr/bin/env node
const fs = require("node:fs");
const [stdoutPath, stderrPath, callsPath] = ${JSON.stringify([stdoutFile, stderrFile, callsFile])};
const args = process.argv.slice(2);
fs.appendFileSync(callsPath, args.join(" ") + "\\n");
if (args[0] === "version") {
  process.stdout.write("Android Debug Bridge version 1.0.41\\nVersion 34.0.5-stub\\n");
} else if (args.includes("resolve-activity")) {
  process.stdout.write("com.example/.Main\\n");
} else {
  process.stdout.write(fs.readFileSync(stdoutPath, "utf8"));
  process.stderr.write(fs.readFileSync(stderrPath, "utf8"));
}
`;
  await writeFile(binary, fakeAdbSource);
  await chmod(binary, 0o755);
  return {
    binary,
    calls: async () => (await readFile(callsFile, "utf8")).trim().split("\n"),
    setReport: async (stdout: string, stderr: string) => {
      await writeFile(stdoutFile, stdout);
      await writeFile(stderrFile, stderr);
    },
  };
};

it
  .skipIf(process.platform === "win32")
  .each(["start_adb_app", "start_adb_activity"] as const)(
  "%s preserves successful reports and failed launch attempts through MCP (ADB process output simulated)",
  async (operation) => {
    const fakeAdb = await createFakeAdb();
    const { binary } = fakeAdb;
    const starting =
      "Starting: Intent { act=android.intent.action.MAIN cmp=com.example/.Main }\n";
    let stdout = `${starting}Warning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok\nActivity: com.example/.Main\nWaitTime: 315\nComplete\n`;
    let stderr = "";
    await fakeAdb.setReport(stdout, stderr);

    const server = createServer(
      {
        kind: "session",
        session: createTestBinarySession(() => {
          throw new Error("ADB start must not open a deep-analysis provider");
        }),
      },
      {
        adbDeviceAnalysis: new AdbProvider({
          environment: { REA_ADB_PATH: binary },
        }),
      },
    );
    onTestFinished(() => server.close());
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "adb-start-boundary", version: "0.0.0" });
    onTestFinished(() => client.close());
    await client.connect(clientTransport);

    const input =
      operation === "start_adb_app"
        ? { serial: "emulator-5554", package: "com.example" }
        : {
            serial: "emulator-5554",
            action: "android.intent.action.MAIN",
            data_uri: "https://example.invalid/launch",
            component: "com.example/.Main",
            extras: [{ key: "mode", type: "string" as const, value: "test" }],
          };
    const success = await client.callTool({
      name: operation,
      arguments: input,
    });
    expect(success.isError).not.toBe(true);
    const evidence = toolContract(operation).outputSchema.parse(
      parseEvidence(JSON.parse(responseText(success))),
    );
    expect(evidence.confidence).toBe("observed");
    expect(evidence.normalized_result).toMatchObject({
      started_activity: "act=android.intent.action.MAIN cmp=com.example/.Main",
      reported_activity: "com.example/.Main",
      reported_status: "ok",
    });
    expect(evidence.raw_result).toEqual({ stdout, stderr });

    stdout = `${starting}Status: timeout\nActivity: com.example/.Main\nWaitTime: 10004\nComplete\n`;
    await fakeAdb.setReport(stdout, stderr);
    const timeout = await client.callTool({
      name: operation,
      arguments: input,
    });
    expect(timeout.isError).toBe(true);
    const timeoutError = analysisErrorProjectionSchema.parse(
      JSON.parse(responseText(timeout)).error,
    );
    expect(timeoutError).toMatchObject({
      code: "unsupported_target",
      details: {
        path: "emulator-5554",
        reason: "am start reported status: timeout",
        captured_output: { stdout, stderr, truncated: false },
        partial_observation: {
          provider_id: "adb",
          operation,
          result: {
            started_activity:
              "act=android.intent.action.MAIN cmp=com.example/.Main",
            reported_activity: "com.example/.Main",
            reported_status: "timeout",
          },
        },
      },
    });
    expect(timeoutError).not.toHaveProperty("timeout_ms");

    stdout = `${starting}Status: ok\nActivity: com.example/.Main\nComplete\n`;
    stderr = "Exception: Activity class does not exist\n";
    await fakeAdb.setReport(stdout, stderr);
    const hardError = await client.callTool({
      name: operation,
      arguments: input,
    });
    expect(hardError.isError).toBe(true);
    const hardErrorProjection = analysisErrorProjectionSchema.parse(
      JSON.parse(responseText(hardError)).error,
    );
    expect(hardErrorProjection.message).toContain(
      "Activity class does not exist",
    );
    expect(hardErrorProjection.details).toMatchObject({
      captured_output: { stdout, stderr, truncated: false },
      partial_observation: {
        operation,
        result: { reported_status: "ok" },
      },
    });

    const calls = await fakeAdb.calls();
    expect(
      calls.filter((arguments_) => arguments_.includes("start -W")),
    ).toEqual(
      Array.from({ length: 3 }, () =>
        [
          "-s emulator-5554 shell am start -W",
          ...(operation === "start_adb_app"
            ? ["-n com.example/.Main"]
            : [
                "-a android.intent.action.MAIN",
                "-d https://example.invalid/launch",
                "-n com.example/.Main",
                "--es mode test",
              ]),
        ].join(" "),
      ),
    );
  },
);
