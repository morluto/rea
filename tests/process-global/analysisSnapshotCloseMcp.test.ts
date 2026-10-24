import { open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  path: "",
  failClose: false,
  closeAttempts: 0,
  handles: [] as Awaited<ReturnType<typeof open>>[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (resolve(String(args[0])) !== injected.path) return handle;
      injected.handles.push(handle);
      const nativeClose = handle.close.bind(handle);
      handle.close = async () => {
        injected.closeAttempts += 1;
        if (injected.failClose)
          throw Object.assign(new Error("controlled snapshot close failure"), {
            code: "EIO",
          });
        await nativeClose();
      };
      return handle;
    },
  };
});

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../fixtures/binarySession.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createServer } from "../../src/server/createServer.js";
import { silentLogger } from "../../src/logger.js";

it.each(["server", "transport"] as const)(
  "reports retained snapshot cleanup and releases it on %s close",
  async (shutdown) => {
    const root = await createTestTempDirectory("rea-snapshot-close-");
    const snapshotPath = join(root, "snapshot.json");
    injected.path = resolve(snapshotPath);
    const session = createTestBinarySession(createCacheProvider([]));
    const server = createServer(
      { kind: "session", session },
      { logger: silentLogger },
    );
    const client = new Client({ name: "snapshot-close", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let serverClosed = false;
    const openTarget = (snapshot: boolean) =>
      client.callTool({
        name: "open_binary",
        arguments: {
          path: process.execPath,
          ...(snapshot ? { snapshot_path: snapshotPath } : {}),
        },
      });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await openTarget(false)).isError).not.toBe(true);
      const exported = session.exportAnalysisSnapshot();
      if (!exported.ok) throw exported.error;
      await writeFile(snapshotPath, JSON.stringify(exported.value));
      const closed = await client.callTool({
        name: "close_binary",
        arguments: {},
      });
      expect(closed.isError).not.toBe(true);

      injected.failClose = true;
      const failed = parseMcpToolError(await openTarget(true));
      // Finalization and the scope's retained-owner retry both observed EIO.
      expect(injected.closeAttempts).toBe(2);
      expect(injected.handles).toHaveLength(1);
      expect(injected.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      expect(failed.error).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          operation: "open_binary",
          cleanup: "incomplete",
          resources: [injected.path],
          diagnostics: {
            reason: expect.stringContaining(
              "controlled snapshot close failure",
            ),
          },
        },
      });
      expect(failed.error.remediation.action).toContain("still retained");

      // Session files must also be released when the enclosing server/transport closes.
      injected.failClose = false;
      if (shutdown === "server") {
        await server.close();
        serverClosed = true;
      } else {
        await client.close();
        await vi.waitFor(() => expect(injected.handles[0]?.fd).toBe(-1));
      }
      expect(injected.closeAttempts).toBe(3);
      expect(injected.handles[0]?.fd).toBe(-1);
    } finally {
      injected.failClose = false;
      await client.close();
      if (!serverClosed) await server.close();
      await session.close();
      injected.path = "";
      injected.handles = [];
      injected.closeAttempts = 0;
    }
  },
);
