import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect, it } from "vitest";

import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { registerRadare2SessionTools } from "../../../src/server/registerRadare2SessionTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createProviderEnvironmentMcpHarness } from "../../support/reverseDebuggerMcpTestHelpers.js";
import {
  createReverseEngineeringMcpHarness,
  invokeWithLiveSignal,
} from "../../support/reverseEngineeringMcpHarness.js";

const writeFakeRadare2 = async (path: string): Promise<void> => {
  await writeFile(
    path,
    `#!${process.execPath}
process.stdout.write("\\0");
let buffer = "";
const reply = (payload) => process.stdout.write(JSON.stringify(payload) + "\\0");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof request.cmd !== "string") continue;
    if (request.cmd === "aflj")
      reply({ res: '[{"name":"main"}]', error: false, value: 0, code: 0 });
    else if (request.cmd === "__fail__")
      reply({ res: "", error: true, value: 1, code: 1 });
    else
      reply({ res: "ok", error: false, value: 0, code: 0 });
  }
});
`,
  );
  await chmod(path, 0o755);
};

const startSession = async (client: Client, artifact: string) => {
  const response = await client.callTool({
    name: "start_radare2_session",
    arguments: { path: artifact },
  });
  expect(response.isError).not.toBe(true);
  const sessionId = (
    response.structuredContent as { readonly session_id: string }
  ).session_id;
  expect(sessionId).toEqual(expect.any(String));
  return sessionId;
};

// The fake engine is an extensionless Node script with a shebang; Windows
// spawns owned providers through CreateProcessW, which cannot run it.
const posixEngine = it.skipIf(process.platform === "win32");

posixEngine("runs a full radare2 session lifecycle through MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-r2-session-"));
  const fakeRadare2 = join(directory, "fake-radare2");
  const artifact = join(directory, "fixture.bin");
  await writeFile(artifact, "fixture");
  await writeFakeRadare2(fakeRadare2);
  const { client } = await createProviderEnvironmentMcpHarness({
    directory,
    clientName: "radare2-session",
    serverOptions: {
      environment: { REA_R2_COMMAND: fakeRadare2 },
    },
  });

  const sessionId = await startSession(client, artifact);
  const command = await client.callTool({
    name: "radare2_command",
    arguments: { session_id: sessionId, command: "aflj" },
  });
  expect(command.isError).not.toBe(true);
  const commandContent = JSON.stringify(command.structuredContent);
  expect(commandContent).toContain('[{"name":"main"}]');
  expect(commandContent).toContain('"parsed"');
  // Delivered copies must stay authenticated: the identifier is
  // content-addressed, so post-hoc field injection would invalidate it.
  expect(() =>
    parseEvidence(command.structuredContent as unknown),
  ).not.toThrow();

  const status = await client.callTool({
    name: "radare2_session_status",
    arguments: { session_id: sessionId },
  });
  expect(status.isError).not.toBe(true);
  expect(JSON.stringify(status.structuredContent).includes('"ready"')).toBe(
    true,
  );

  const closed = await client.callTool({
    name: "close_radare2_session",
    arguments: { session_id: sessionId },
  });
  expect(closed.isError).not.toBe(true);

  const afterClose = await client.callTool({
    name: "radare2_session_status",
    arguments: { session_id: sessionId },
  });
  expect(afterClose.isError).toBe(true);
});

it("reports a missing radare2 executable as an unavailable capability on start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-r2-session-missing-"));
  const artifact = join(directory, "fixture.bin");
  await writeFile(artifact, "fixture");
  const { client } = await createProviderEnvironmentMcpHarness({
    directory,
    clientName: "radare2-session-missing",
    serverOptions: {
      environment: { REA_R2_COMMAND: join(directory, "missing-radare2") },
    },
  });

  const response = await client.callTool({
    name: "start_radare2_session",
    arguments: { path: artifact },
  });

  expect(response.isError).toBe(true);
});

it("passes the radare2_command operation name to admitted external mutations", async () => {
  const evidence = createEvidence(
    undefined,
    { id: "radare2.session", name: "Radare2 session", version: null },
    {
      predicateType: "rea.reverse-engineering.command-observation",
      operation: "radare2_command",
      parameters: { session_id: "s", command: "aflj" },
      result: { completion_status: "complete", output_truncated: false },
      rawResult: { command: "aflj", output: "[]" },
    },
  );
  const { server, handler } = createReverseEngineeringMcpHarness();
  const admittedNames: Array<string | undefined> = [];
  registerRadare2SessionTools(
    server,
    {
      start: async () => ok({ session_id: "s" }),
      execute: async () =>
        ok({
          result: {
            command: "aflj",
            output: "[]",
            output_truncated: false,
            completion_status: "complete" as const,
            command_error: false,
            command_code: 0,
            command_logs: [],
          },
          evidence,
        }),
      status: () => undefined,
      close: async () => ok({ closed: true as const }),
      retryCleanupFailures: async () => ok(null),
    },
    pino({ enabled: false }),
    createToolResultDelivery(2 * 1024 * 1024),
    undefined,
    {
      withAdmittedExternalMutation: async (
        _path,
        _signal,
        operation,
        _rebindFailure,
        operationName,
      ) => {
        admittedNames.push(operationName);
        return ok(await operation());
      },
    },
  );
  const invoke = handler("radare2_command");

  await invokeWithLiveSignal(invoke, {
    session_id: "00000000-4000-4000-8000-000000000001",
    command: "aflj",
  });

  expect(admittedNames).toEqual(["radare2_command"]);
});

it("reports retained cleanup when a failed start cannot verify the session stop", async () => {
  const evidence = createEvidence(
    undefined,
    { id: "radare2.session", name: "Radare2 session", version: null },
    {
      predicateType: "rea.reverse-engineering.command-observation",
      operation: "radare2_command",
      parameters: { session_id: "session-1", command: "__fail__" },
      result: {
        completion_status: "complete",
        output_truncated: false,
        command_error: true,
      },
      rawResult: { command: "__fail__", output: "" },
    },
  );
  const { server, handler } = createReverseEngineeringMcpHarness();
  registerRadare2SessionTools(
    server,
    {
      start: async () => ok({ session_id: "session-1" }),
      execute: async () =>
        ok({
          result: {
            command: "__fail__",
            output: "",
            output_truncated: false,
            completion_status: "complete" as const,
            command_error: true,
            command_code: 1,
            command_logs: [],
          },
          evidence,
        }),
      status: () => undefined,
      close: async () =>
        err(
          new AnalysisCapabilityUnavailableError(
            "radare2",
            "close_radare2_session",
            "The owned Radare2 process could not be confirmed stopped: injected uncertainty",
            {
              cleanup: {
                reason: "injected uncertainty",
                resources: ["session-1"],
              },
            },
          ),
        ),
      retryCleanupFailures: async () => ok(null),
    },
    pino({ enabled: false }),
    createToolResultDelivery(2 * 1024 * 1024),
  );
  const invoke = handler("start_radare2_session");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "/tmp/f",
    initial_commands: ["__fail__"],
  })) as { readonly isError?: boolean };

  expect(response.isError).toBe(true);
  const content = JSON.stringify(response);
  expect(content).toContain('"cleanup":"incomplete"');
  expect(content).toContain("session-1");
});

posixEngine(
  "runs caller-selected initial commands inside the start admission",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-init-"));
    const fakeRadare2 = join(directory, "fake-radare2");
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    await writeFakeRadare2(fakeRadare2);
    const { client } = await createProviderEnvironmentMcpHarness({
      directory,
      clientName: "radare2-init",
      serverOptions: { environment: { REA_R2_COMMAND: fakeRadare2 } },
    });

    const started = await client.callTool({
      name: "start_radare2_session",
      arguments: { path: artifact, initial_commands: ["aaa", "aflj"] },
    });
    expect(started.isError).not.toBe(true);
    const sessionId = (
      started.structuredContent as { readonly session_id: string }
    ).session_id;
    const status = await client.callTool({
      name: "radare2_session_status",
      arguments: { session_id: sessionId },
    });
    expect(JSON.stringify(status.structuredContent).includes('"ready"')).toBe(
      true,
    );
    await client.callTool({
      name: "close_radare2_session",
      arguments: { session_id: sessionId },
    });

    const failed = await client.callTool({
      name: "start_radare2_session",
      arguments: { path: artifact, initial_commands: ["__fail__"] },
    });
    expect(failed.isError).toBe(true);
  },
);
