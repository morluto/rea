import { open, readFile, writeFile } from "node:fs/promises";
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

const hostTool = {
  inspectAvailability: async () => ({
    status: "unavailable" as const,
    code: "not_configured" as const,
    reason: "Snapshot recovery fixture does not probe host tools.",
    diagnostics: {},
  }),
  close: async () => {},
  execute: async (): Promise<never> => {
    throw new Error("Unexpected host-tool execution");
  },
};

it("recovers a retained snapshot descriptor through close_binary on the same connection", async () => {
  const root = await createTestTempDirectory("rea-snapshot-close-");
  const snapshotPath = join(root, "snapshot.json");
  injected.path = resolve(snapshotPath);
  const calls: string[] = [];
  const session = createTestBinarySession(createCacheProvider(calls));
  const server = createServer(
    { kind: "session", session },
    {
      logger: silentLogger,
      androidAnalysis: hostTool,
      adbDeviceAnalysis: hostTool,
      apktoolAnalysis: hostTool,
    },
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
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "fixture",
        })
      ).ok,
    ).toBe(true);
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
          reason: expect.stringContaining("controlled snapshot close failure"),
        },
      },
    });
    expect(failed.error.remediation.action).toContain("still retained");

    const before = await readFile(snapshotPath);
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    const statusText = status.content.find((item) => item.type === "text");
    expect(
      statusText?.type === "text" ? JSON.parse(statusText.text) : null,
    ).toMatchObject({ result: { cleanup_pending: true } });
    expect((await openTarget(false)).isError).toBe(true);
    expect(session.activeTarget()).toBeUndefined();
    const retry = parseMcpToolError(
      await client.callTool({
        name: "close_binary",
        arguments: {},
      }),
    );
    expect(retry.error).toMatchObject({
      code: "cleanup_incomplete",
      details: { operation: "close_binary" },
    });
    expect(injected.handles[0]?.fd).toBeGreaterThanOrEqual(0);
    injected.failClose = false;
    expect(
      (await client.callTool({ name: "close_binary", arguments: {} })).isError,
    ).not.toBe(true);
    expect(injected.handles[0]?.fd).toBe(-1);
    expect(await session.status()).toMatchObject({ cleanup_pending: false });
    expect((await openTarget(true)).isError).not.toBe(true);
    const previousCalls = calls.length;
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "fixture",
        })
      ).ok,
    ).toBe(true);
    expect(calls).toHaveLength(previousCalls);
    expect(await readFile(snapshotPath)).toEqual(before);

    // The connection remains usable after the exact owner's cleanup retry.
    injected.failClose = false;
    await server.close();
    serverClosed = true;

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
});
