import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("withholds archived HTTP credentials from the reply and retained Evidence", async () => {
  const path = join(
    await createTestTempDirectory("rea-warc-http-"),
    "crawl.warc",
  );
  const payload =
    String.raw`GET / HTTP/1.1` +
    "\r\nAuthorization: Bearer fixture-secret\r\nX-Note: retained\r\nLocation: https://folded-user:folded-pass\r\n @example.test/path\r\n" +
    String.raw`Referer: https:\\bad-user:bad-pass@example.test` +
    "\r\n :badport\r\n\r\n";
  await writeFile(
    path,
    `WARC/1.1\r\nWARC-Type: request\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
  );
  const session = createTestBinarySession(() => {
    throw new Error("No native provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "warc-credential-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const reply = await client.callTool({
    name: "inspect_warc_archive",
    arguments: { path },
  });
  expect(reply.isError).not.toBe(true);
  const evidence = parseEvidence(reply.structuredContent);
  expect(JSON.stringify(reply)).not.toMatch(
    /fixture-secret|folded-user|folded-pass|bad-user|bad-pass/u,
  );
  expect(
    JSON.stringify(session.evidenceById(evidence.evidence_id)),
  ).not.toMatch(/fixture-secret|folded-user|folded-pass|bad-user|bad-pass/u);
  expect(evidence.normalized_result).toMatchObject({
    records: [
      {
        http: {
          headers: [
            { name: "Authorization", value: null },
            { name: "X-Note", value: "retained" },
            { name: "Location", value: "https://[redacted]" },
            { name: "Referer", value: "[redacted: ambiguous URL credentials]" },
          ],
          malformed_header_lines: [
            " @example.test/path",
            "[redacted continuation]",
          ],
        },
      },
    ],
  });
});
