import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpStdioTransport.js";
import type { ProviderProcessHandle } from "../process/ProviderProcess.js";
import { createIdaMcpConnection } from "./IdaMcpConnection.js";

class FixtureProcess extends EventEmitter implements ProviderProcessHandle {
  readonly pid = 1;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly signalCode = null;
  kill(): boolean {
    return true;
  }
}

it("keeps a failed handshake's incomplete cleanup observable with the redacted server tail", async () => {
  const child = new FixtureProcess();
  let cleanupFails = true;
  // The server answers initialize with an unsupported protocol version, so the
  // SDK starts close without awaiting it while owned cleanup stays incomplete.
  createInterface({ input: child.stdin }).on("line", (line) => {
    const request = JSON.parse(line) as { id?: number; method?: string };
    if (request.method !== "initialize") return;
    child.stderr.write("server stopped: missing database\n");
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "1999-01-01",
          capabilities: {},
          serverInfo: { name: "old", version: "1" },
        },
      })}\n`,
    );
  });
  const launcher: OwnedMcpLauncher = async ({ runId }) => ({
    process: child,
    ownership: {
      runId,
      leaderPid: child.pid,
      processGroupId: child.pid,
      expectedParentPid: child.pid,
    },
    cleanup: async () => {
      if (cleanupFails)
        return { cleaned: false, reason: "ownership verification unavailable" };
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return { cleaned: true, signaled: false };
    },
  });
  const connection = createIdaMcpConnection(
    {
      command: "/opt/ida-mcp/server",
      args: [],
      env: {},
      protocol: "legacy",
      mode: "attached",
      timeoutMs: 5000,
    },
    {},
    { platform: "darwin", launcher },
  );
  await expect(connection.connect()).rejects.toThrow();
  const failure: unknown = await connection.close().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(failure instanceof ProviderCleanupError)) throw failure;
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.capturedOutput?.stderr).toContain(
    "server stopped: missing database",
  );
  cleanupFails = false;
  await connection.close();
  expect(failure.cleanupIncomplete).toBe(false);
});
