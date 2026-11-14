import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { registerRizinDebugTools } from "../../../src/server/registerRizinDebugTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { validateDebuggerStatusResponse } from "../../support/reverseDebuggerMcpTestHelpers.js";
import { createInjectedProcess } from "../providers/RizinDebugSessionCoverage.fixtures.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "../providers/RizinTestInferiorTty.js";

const test = it.skipIf(process.platform === "win32");

const LIMIT_REASON = "Rizin command output exceeded the 8 byte command limit.";

// The injected stream simulates Rizin's NUL-framed protocol; it is not Rizin.
test.each([
  { cleanupRetry: false, command: "noisy", reason: LIMIT_REASON },
  { cleanupRetry: true, command: "noisy", reason: LIMIT_REASON },
  {
    cleanupRetry: false,
    command: "q",
    reason: "The Rizin process exited (exit code null, signal SIGTERM)",
  },
])(
  "reports why a Rizin session stopped through MCP after $command (cleanup retry: $cleanupRetry)",
  async ({ cleanupRetry, command, reason }) => {
    let stops = 0;
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        const marker = /!echo (.+)\n/u.exec(text)?.[1];
        if (marker === undefined) return;
        if (text.startsWith("noisy\n"))
          control.output(`too much output\0${marker}\0`);
        else if (text.startsWith("q\n")) setImmediate(() => control.exit());
        else if (text.startsWith("!echo __REA_CLEANUP_SYNC_"))
          control.output(`${marker}\0`);
        else if (text.startsWith("olj\n")) control.output(`[]\0${marker}\0`);
      },
    });
    const manager = createRizinTestManager(
      { REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES: "8" },
      {
        spawnProcess: injected.spawnProcess,
        // The injected stream has no OS process; detach through the protocol.
        stopProcess: async (session) => {
          stops += 1;
          if (cleanupRetry && stops === 1)
            return { status: "incomplete", reason: "injected stop pending" };
          if (session.exited) return { status: "already_exited" };
          await session.detachInferior?.();
          injected.control.exit();
          return { status: "stopped" };
        },
      },
    );
    const server = new McpServer({ name: "rizin-stopped", version: "1" });
    registerRizinDebugTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({ name: "rizin-stopped", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const call = (name: string, arguments_: Record<string, string>) =>
      client.callTool({
        name,
        arguments: arguments_,
      }) as Promise<CallToolResult>;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { session_id } = toolContract(
        "start_rizin_debug_session",
      ).outputSchema.parse(
        (
          await call("start_rizin_debug_session", {
            path: "fixture.bin",
            inferior_tty: await rizinTestInferiorTty(),
          })
        ).structuredContent,
      );

      const stopping = await call("rizin_debug_command", {
        session_id,
        command,
      });
      if (cleanupRetry)
        expect(parseMcpToolError(stopping).error.code).toBe(
          "cleanup_incomplete",
        );
      else expect(stopping.isError).not.toBe(true);

      // The next call retries retained cleanup first, then refuses the
      // command with the retained diagnosis instead of an argument error.
      const later = parseMcpToolError(
        await call("rizin_debug_command", { session_id, command: "dr" }),
      ).error;
      expect(later).toMatchObject({
        code: "capability_unavailable",
        message: expect.stringContaining(
          "The Rizin debug session stopped and accepts no more commands.",
        ),
        remediation: {
          action: expect.stringMatching(
            /close_rizin_debug_session.*start_rizin_debug_session/u,
          ),
        },
        details: { reason: expect.stringContaining(reason) },
      });
      expect(later.message).toContain(reason);
      expect(stops).toBe(cleanupRetry ? 2 : 1);

      const status = await validateDebuggerStatusResponse(
        client,
        "rizin_debug_session_status",
        session_id,
      );
      expect(status).toMatchObject({
        state: "closed",
        closed_reason: expect.stringContaining(reason),
      });

      expect(
        (await call("close_rizin_debug_session", { session_id })).isError,
      ).not.toBe(true);
      // A released ID is unknown, which differs from a retained stopped session.
      expect(
        parseMcpToolError(
          await call("rizin_debug_command", { session_id, command: "dr" }),
        ).error,
      ).toMatchObject({
        code: "invalid_request",
        message:
          "No Rizin debug session has this session_id in this REA server.",
      });
    } finally {
      await closeVerifierResources([
        () => client.close(),
        () => server.close(),
        () => manager.closeAll(),
      ]);
    }
  },
);
