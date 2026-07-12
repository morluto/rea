import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  BinarySession,
  type BinaryClient,
} from "../src/application/BinarySession.js";
import { ok } from "../src/domain/result.js";
import { createServer } from "../src/server/createServer.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("target-free MCP lifecycle", () => {
  it("reports no-target, opens, analyzes, switches, reports status, and closes", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-mcp-session-"));
    const first = join(directory, "first.hop");
    const second = join(directory, "second.hop");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const closed: string[] = [];
    const session = new BinarySession((target) => client(target.path, closed));
    const server = createServer(session, session);
    const mcp = new Client({ name: "session-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const before = await mcp.callTool({
      name: "current_document",
      arguments: {},
    });
    expect(before.isError).toBe(true);
    expect(text(before)).toContain("NoBinaryOpenError");
    expect((await mcp.listTools()).tools).toHaveLength(43);
    expect(
      (await mcp.callTool({ name: "open_binary", arguments: { path: first } }))
        .isError,
    ).not.toBe(true);
    expect(
      text(await mcp.callTool({ name: "current_document", arguments: {} })),
    ).toContain("first.hop");
    await mcp.callTool({ name: "open_binary", arguments: { path: second } });
    expect(closed.some((path) => path.endsWith("first.hop"))).toBe(true);
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain("second.hop");
    await mcp.callTool({ name: "close_binary", arguments: {} });
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain('"open": false');
  });
});

const client = (path: string, closed: string[]): BinaryClient => ({
  callTool: (name) =>
    Promise.resolve(ok(name === "health" ? null : { path, name })),
  close: () => {
    closed.push(path);
    return Promise.resolve();
  },
});

const text = (result: CallToolResult): string => {
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("missing text result");
  return content.text;
};
