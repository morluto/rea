import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it.skipIf(process.platform === "win32")(
  "rejects an open_binary FIFO without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-open-binary-fifo-");
    const fifoPath = join(root, "input.bin");
    await promisify(execFile)("mkfifo", [fifoPath]);
    const session = createTestBinarySession(new ArtifactProvider(process.env));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "fifo-target-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        client.callTool({ name: "open_binary", arguments: { path: fifoPath } }),
      );
      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed")
        throw new Error("MCP open_binary waited for a FIFO writer");
      expect(outcome.result.isError).toBe(true);
      expect(parseMcpToolError(outcome.result)).toMatchObject({
        error: {
          code: "target_unavailable",
          message: expect.stringContaining("not a regular file"),
        },
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  },
);
