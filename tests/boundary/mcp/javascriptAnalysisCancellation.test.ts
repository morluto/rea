import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("stops a cancelled SDK request on the server, retains prior Evidence, and accepts subsequent work", async () => {
  const root = await createTestTempDirectory("rea-mcp-js-cancellation-");
  await writeFile(join(root, "main.js"), "export const observed = 1;\n");
  const session = createTestBinarySession(() => {
    throw new Error(
      "Static JavaScript analysis must not start a binary provider",
    );
  });
  const prior = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "prior_observation",
      parameters: {},
      result: { preserved: true },
    },
  );
  expect(session.recordEvidence(prior).ok).toBe(true);
  const completed = createDeferred<string>();
  const completionSchema = z.object({
    tool: z.string(),
    status: z.string(),
    msg: z.string(),
  });
  const logger = pino(
    { level: "info" },
    {
      write(line) {
        const value: unknown = JSON.parse(line);
        const parsed = completionSchema.safeParse(value);
        if (
          parsed.success &&
          parsed.data.tool === "analyze_javascript_application" &&
          parsed.data.msg === "MCP tool execution completed"
        )
          completed.resolve(parsed.data.status);
      },
    },
  );
  const server = createServer(session, session, { logger });
  const client = new Client({ name: "javascript-cancellation", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const controller = new AbortController();
  let requested = false;
  const call = client.callTool(
    {
      name: "analyze_javascript_application",
      arguments: {
        input_path: root,
        format: "directory",
      },
    },
    {
      signal: controller.signal,
      onprogress() {
        requested = true;
        controller.abort(new Error("SDK cancellation verification"));
      },
    },
  );
  await expect(call).rejects.toThrow("SDK cancellation verification");
  expect(requested).toBe(true);
  // A rejected client promise alone does not prove that the server stopped.
  expect(await completed.promise).toBe("error");
  await client.ping();
  const bundle = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  expect(
    z
      .object({
        result: z.object({
          records: z.array(z.object({ evidence_id: z.string() })),
        }),
      })
      .parse(bundle.structuredContent).result.records,
  ).toEqual([{ evidence_id: prior.evidence_id }]);
  const next = await client.callTool({
    name: "analyze_javascript_application",
    arguments: {
      input_path: root,
      format: "directory",
    },
  });
  expect(next.isError, JSON.stringify(next)).not.toBe(true);
  await client.ping();
});
