import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { silentLogger } from "../../../src/logger.js";
import { registerGdbTools } from "../../../src/server/registerGdbTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

const settlesWithin = async <Value>(
  operation: Promise<Value>,
  timeoutMs: number,
): Promise<
  | { readonly settled: true; readonly value: Value }
  | { readonly settled: false }
> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  const result = await Promise.race([
    operation.then((value) => ({ settled: true as const, value })),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
};

it.skipIf(process.platform === "win32").each(["kill", "detach"])(
  "retains a valid GDB session through disposition refusal and explicit %s recovery",
  async (disposition) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-gdb-disposition-"));
    const provider = join(directory, "fake-gdb.mjs");
    await writeFile(
      provider,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
let live = false;
process.stdout.write('(gdb)\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const token = /^(\\d+)/.exec(line)?.[1];
  if (!token) return;
  const command = line.slice(token.length);
  if (command === '-interpreter-exec console "run"') {
    live = true;
    process.stdout.write(token + '^running\\n*stopped,reason="breakpoint-hit",thread-id="1"\\n(gdb)\\n');
    return;
  }
  const disposition = command === '-interpreter-exec console "kill"' || command === '-interpreter-exec console "detach"';
  if (disposition) live = false;
  const result = command === '-list-thread-groups --recurse 1'
    ? (live ? 'done,groups=[{id="i1",type="process",pid="4242"}]' : 'done,groups=[]')
    : command === '-thread-info'
      ? 'done,threads=[{id="1",state="running"}]'
    : disposition || command === '-gdb-set auto-load off' || command === '-gdb-exit' || command === '-gdb-show mi-async'
      ? 'done' : 'error,msg="Unmodeled fixture command"';
  process.stdout.write(token + '^' + result + '\\n' + (disposition ? '*stopped,reason="exited-normally",stopped-threads="all"\\n' : '') + '(gdb)\\n', () => {
    if (line.includes('-gdb-exit')) process.exit(0);
  });
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      platform: "linux",
      environment: { REA_GDB_COMMAND: provider },
    });
    const [target, replacement] = await createBinarySessionTargets();
    const binarySession = createTestBinarySession(createCacheProvider([]));
    expect((await binarySession.open(target)).ok).toBe(true);
    const server = new McpServer({
      name: "gdb-disposition-test",
      version: "1",
    });
    registerGdbTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
      undefined,
      binarySession,
    );
    const client = new Client({ name: "gdb-disposition-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const openingController = new AbortController();
    let opening: ReturnType<typeof binarySession.open> | undefined;
    let sessionId: string | undefined;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({
        name: "start_gdb_session",
        arguments: {},
      });
      sessionId = toolContract("start_gdb_session").outputSchema.parse(
        started.structuredContent,
      ).session_id;
      const running = await client.callTool({
        name: "gdb_console",
        arguments: { session_id: sessionId, command: "run" },
      });
      expect(running.isError).not.toBe(true);
      opening = binarySession.open(replacement, {
        signal: openingController.signal,
      });
      let closeProgressedBeforeAbort = true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const closeRequest = client.callTool({
          name: "close_gdb_session",
          arguments: { session_id: sessionId },
        });
        const withinDeadline =
          attempt === 0 ? await settlesWithin(closeRequest, 1_000) : undefined;
        if (withinDeadline?.settled === false) {
          closeProgressedBeforeAbort = false;
          openingController.abort();
        }
        const refusal =
          withinDeadline?.settled === true
            ? withinDeadline.value
            : await closeRequest;
        expect(refusal.isError).toBe(true);
        expect(refusal.structuredContent).toMatchObject({
          error: {
            code: "capability_unavailable",
            category: "unavailable",
            retryable: true,
            remediation: { action: expect.stringContaining("gdb_console") },
            details: {
              provider_id: "gnu.gdb",
              operation: "close_gdb_session",
              reason: expect.stringContaining("inferior"),
            },
          },
        });
        expect(JSON.stringify(refusal.structuredContent)).not.toContain(
          "invalid_value",
        );
        expect(manager.status(sessionId)?.state).toBe("ready");
      }
      const disposed = await client.callTool({
        name: "gdb_console",
        arguments: { session_id: sessionId, command: disposition },
      });
      expect(disposed.isError).not.toBe(true);
      await expect(opening).resolves.toMatchObject({ ok: true });
      expect(binarySession.activeTarget()?.path).toBe(replacement);
      expect(closeProgressedBeforeAbort).toBe(true);
      const closed = await client.callTool({
        name: "close_gdb_session",
        arguments: { session_id: sessionId },
      });
      expect(closed.isError).not.toBe(true);
      expect(closed.structuredContent).toMatchObject({
        target_state: "none_observed",
      });
      expect(manager.status(sessionId)).toBeUndefined();
      const unknown = await client.callTool({
        name: "close_gdb_session",
        arguments: { session_id: randomUUID() },
      });
      expect(unknown.structuredContent).toMatchObject({
        error: { code: "invalid_request", category: "invalid_input" },
      });
    } finally {
      if (sessionId !== undefined && manager.status(sessionId) !== undefined) {
        const disposed = await manager.execute(sessionId, "kill");
        if (!disposed.ok) throw disposed.error;
        const closed = await manager.close(sessionId);
        if (!closed.ok) throw closed.error;
      }
      await binarySession.close();
      await client.close();
      await server.close();
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
