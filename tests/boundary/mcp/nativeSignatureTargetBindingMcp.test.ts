import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { NativeMacOSProvider } from "../../../src/native/NativeMacOSProvider.js";
import {
  machoImage,
  rpathCommand,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { NativeFixtureRunner } from "../../fixtures/nativeCommands.js";

it("rejects changed signature targets through MCP and accepts reopening the new version", async () => {
  const path = join(
    await createTestTempDirectory("rea-signature-binding-mcp-"),
    "program",
  );
  await writeFile(path, machoImage({}));
  const session = createTestBinarySession(
    new NativeMacOSProvider({}, new NativeFixtureRunner(), "darwin"),
  );
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "signature-binding-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const open = () =>
      client.callTool({ name: "open_binary", arguments: { path } });
    expect((await open()).isError).not.toBe(true);
    await writeFile(
      path,
      machoImage({ commands: [rpathCommand("new-version")] }),
    );
    const changed = await client.callTool({
      name: "inspect_signature",
      arguments: {},
    });
    expect(changed.isError).toBe(true);
    expect(parseMcpToolError(changed)).toMatchObject({
      error: { code: "artifact_changed", details: { path } },
    });
    expect((await open()).isError).not.toBe(true);
    const inspected = await client.callTool({
      name: "inspect_signature",
      arguments: {},
    });
    expect(
      inspected.isError,
      JSON.stringify(inspected.structuredContent),
    ).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      normalized_result: { signed: true, identifier: "com.example.fixture" },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
