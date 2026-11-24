import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";
import {
  AnalysisCapabilityUnavailableError,
  cancelledBy,
} from "../../../src/domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../../src/domain/result.js";
import { Radare2SessionManager } from "../../../src/radare2/Radare2SessionManager.js";
import type { Radare2SessionToolOptions } from "../../../src/server/debuggerToolBindings.js";
import type { ExternalMutationAdmission } from "../../../src/server/externalMutationAdmission.js";
import { radare2McpServer } from "../../fixtures/debuggerMcp.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";

const sessionId = "00000000-4000-4000-8000-000000000001";

const fakeRadare2Provider = `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    let command = "";
    try {
      command = JSON.parse(line).cmd ?? "";
    } catch {
      continue;
    }
    process.stdout.write(
      JSON.stringify({ res: command + ":ok", error: false, value: 0, code: 0 }) +
        "\\0",
    );
  }
});
`;

it.skipIf(process.platform === "win32")(
  "starts, commands, and closes a Radare2 session through MCP",
  async () => {
    const directory = await createTestTempDirectory("rea-r2-session-mcp-");
    const provider = join(directory, "fake-radare2.mjs");
    await writeFile(provider, fakeRadare2Provider);
    await chmod(provider, 0o700);
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const manager = new Radare2SessionManager({
      ...process.env,
      REA_R2_COMMAND: provider,
    });
    const server = radare2McpServer("radare2-session", manager);
    const client = new Client(
      { name: "radare2-session", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({
        name: "start_radare2_session",
        arguments: { path: artifact },
      });
      expect(started.isError, JSON.stringify(started)).not.toBe(true);
      const startedId = z
        .object({ session_id: z.string().uuid() })
        .parse(started.structuredContent).session_id;

      const command = await client.callTool({
        name: "radare2_command",
        arguments: { session_id: startedId, command: "ij" },
      });
      expect(command.isError).not.toBe(true);
      expect(JSON.stringify(command.structuredContent)).toContain("ij:ok");

      const status = await client.callTool({
        name: "radare2_session_status",
        arguments: { session_id: startedId },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ state: "ready" });

      const closed = await client.callTool({
        name: "close_radare2_session",
        arguments: { session_id: startedId },
      });
      expect(closed.isError).not.toBe(true);
      expect(closed.structuredContent).toEqual({ closed: true });
    } finally {
      await closeVerifierResources([
        () => client.close(),
        () => server.close(),
        async () => {
          await manager.closeAll();
        },
      ]);
    }
  },
);

it("closes a started session that a cancelling admission never delivers", async () => {
  const released: string[] = [];
  const manager = {
    start: async () => ok({ session_id: sessionId }),
    execute: async () =>
      err(
        new AnalysisCapabilityUnavailableError(
          "radare2",
          "radare2_command",
          "unused",
        ),
      ),
    status: () => undefined,
    close: async (closedSessionId: string) => {
      released.push(closedSessionId);
      return ok({ closed: true as const });
    },
    retryCleanupFailures: async () => ok(null),
  } satisfies Radare2SessionToolOptions["manager"];
  const admission: ExternalMutationAdmission = {
    withAdmittedExternalMutation: async <Value>(
      _path: string | undefined,
      _signal: AbortSignal | undefined,
      operation: () => Promise<Result<Value, AnalysisError>>,
      completionFailure: (
        value: Result<Value, AnalysisError>,
        error: AnalysisError,
      ) => AnalysisError,
    ) => {
      const value = await operation();
      const controller = new AbortController();
      const reason = new Error("caller stopped");
      controller.abort(reason);
      return err(
        completionFailure(
          value,
          cancelledBy("start_radare2_session", controller.signal),
        ),
      );
    },
  };
  const server = radare2McpServer(
    "radare2-start-cancellation",
    manager,
    admission,
  );
  const client = new Client(
    { name: "radare2-start-cancellation", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const started = await client.callTool({
      name: "start_radare2_session",
      arguments: { path: "/tmp/fixture.bin" },
    });
    expect(started.isError).toBe(true);
    // The engine the caller never learns about is closed, not left running.
    expect(released).toEqual([sessionId]);
    const delivered = JSON.stringify(started.content);
    expect(delivered).toContain('\\"category\\":\\"cancelled\\"');
    expect(delivered).toContain('\\"cleanup\\":\\"complete\\"');
  } finally {
    await closeVerifierResources([() => client.close(), () => server.close()]);
  }
});
