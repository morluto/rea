import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import * as warc from "../../../src/application/warcArchive/WarcArchiveService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains a completed WARC inventory when the MCP request is cancelled before delivery", async () => {
  const path = join(
    await createTestTempDirectory("rea-warc-cancel-"),
    "crawl.warc",
  );
  await writeFile(
    path,
    "WARC/1.1\r\nWARC-Type: resource\r\nContent-Length: 0\r\n\r\n",
  );
  const session = createTestBinarySession(() => {
    throw new Error("No native provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "warc-late-cancellation", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  onTestFinished(async () => {
    controller.abort();
    vi.restoreAllMocks();
    await client.close();
    await server.close();
    await session.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const request = { name: "inspect_warc_archive", arguments: { path } };
  const controlReply = await client.callTool(request);
  expect(controlReply.isError).not.toBe(true);
  const control = parseEvidence(controlReply.structuredContent);
  expect((await session.resetInvestigation()).ok).toBe(true);
  expect(session.evidenceById(control.evidence_id)).toBeUndefined();
  const original = warc.inspectWarcArchiveEvidence;
  vi.spyOn(warc, "inspectWarcArchiveEvidence").mockImplementation(
    async (...args) => {
      const result = await original(...args);
      if (result.ok) {
        const signal = args[2]?.signal;
        if (signal === undefined)
          throw new Error("Missing MCP cancellation signal");
        controller.abort("cancel after inventory");
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      }
      return result;
    },
  );
  const delivered =
    createDeferred<
      ReturnType<ToolResultDelivery["toPartialErrorToolResult"]>
    >();
  const deliver = server.delivery.toPartialErrorToolResult.bind(
    server.delivery,
  );
  vi.spyOn(
    ToolResultDelivery.prototype,
    "toPartialErrorToolResult",
  ).mockImplementation((...args) => {
    const result = deliver(...args);
    delivered.resolve(result);
    return result;
  });
  await expect(
    client.callTool(request, { signal: controller.signal }),
  ).rejects.toThrow();
  // The client suppresses cancelled replies; inspect server delivery and read back its session.
  const { error } = parseMcpToolError(await delivered.promise);
  expect(error.code).toBe("cancelled");
  const reference = z
    .object({
      partial_observation: z.object({
        kind: z.literal("retained-evidence"),
        evidence_id: z.string(),
      }),
    })
    .parse(error.details).partial_observation;
  expect(session.evidenceById(reference.evidence_id)).toEqual(control);
  await expect(client.ping()).resolves.toEqual({});
});
