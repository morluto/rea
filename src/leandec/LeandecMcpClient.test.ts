import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  LeandecMcpClient,
  LeandecCallCancelled,
  LeandecRpcError,
} from "./LeandecMcpClient.js";

const fixture = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({input: process.stdin});
const notifications = [];
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result}) + "\n");
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    reply(request.id, {protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"fixture",version:"1.0.0"}});
  } else if (request.method === "notifications/cancelled") {
    notifications.push(request.params.requestId);
  } else if (request.method === "tools/call") {
    const name = request.params.name;
    if (name === "wait") return;
    if (name === "malformed") { reply(request.id, {content: {}}); return; }
    if (name === "exit") { process.exit(0); return; }
    reply(request.id,{content:[{type:"text",text:JSON.stringify({notifications})}]});
  }
});
`;
const clientFor = async () => {
  const cwd = await createTestTempDirectory("leandec-mcp-");
  const server = join(cwd, "server.cjs");
  await writeFile(server, fixture);
  return new LeandecMcpClient({
    python: process.execPath,
    server,
    cwd,
    environment: process.env,
    defaultTimeoutMs: 5000,
  });
};

describe.skipIf(process.platform === "win32")("Leandec stdio transport", () => {
  it("handshakes, sends cancellation and remains available", async () => {
    const client = await clientFor();
    try {
      await client.initialize();
      const cancellation = new AbortController();
      const waiting = client.call("wait", {}, { signal: cancellation.signal });
      const rejected =
        expect(waiting).rejects.toBeInstanceOf(LeandecCallCancelled);
      await new Promise((resolve) => setTimeout(resolve, 100));
      cancellation.abort();
      await rejected;
      const result = await client.call("observe", {});
      expect(result).toMatchObject({ notifications: [expect.any(Number)] });
    } finally {
      await client.close();
    }
  });

  it("rejects malformed MCP envelopes instead of returning empty output", async () => {
    const client = await clientFor();
    try {
      await expect(client.call("malformed", {})).rejects.toBeInstanceOf(
        LeandecRpcError,
      );
    } finally {
      await client.close();
    }
  });

  it("rejects a pending call on process exit and closes idempotently", async () => {
    const client = await clientFor();
    try {
      await expect(client.call("exit", {})).rejects.toBeInstanceOf(
        LeandecRpcError,
      );
    } finally {
      await client.close();
      await client.close();
    }
  });
});
