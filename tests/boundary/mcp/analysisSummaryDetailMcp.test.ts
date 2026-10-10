import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const contract = toolContract("analyze_javascript_application");

const connect = async (retainsEvidence: boolean) => {
  const session = createTestBinarySession(() => {
    throw new Error("JavaScript analysis must not start a deep provider");
  });
  const server = createServer(
    retainsEvidence
      ? { kind: "session", session }
      : {
          kind: "fixed",
          analysis: {
            execute: () => {
              throw new Error("JavaScript analysis must not use a target");
            },
          },
        },
  );
  const client = new Client({ name: "analysis-summary-detail", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const application = async () => {
  const root = await createTestTempDirectory("rea-summary-detail-");
  await writeFile(
    join(root, "main.js"),
    'import { helper } from "./util.js";\nexport const greet = (name) => helper(name);\n',
  );
  await writeFile(
    join(root, "util.js"),
    "export const helper = (value) => value.toUpperCase();\n",
  );
  return { input_path: root, format: "directory" };
};

const textBytes = (content: unknown): number => {
  const [first] = Array.isArray(content) ? content : [];
  if (first?.type !== "text") throw new Error("Missing MCP text result");
  return Buffer.byteLength(String(first.text));
};

it("returns the summary of complete Evidence retained for later views", async () => {
  const client = await connect(true);
  const input = await application();
  const complete = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(complete.isError).not.toBe(true);
  const completeEvidence = contract.outputSchema.parse(
    complete.structuredContent,
  );
  expect(completeEvidence.operation).toBe("analyze_javascript_application");

  const summary = await client.callTool({
    name: contract.name,
    arguments: { ...input, detail: "summary" },
  });
  expect(summary.isError).not.toBe(true);
  const summaryEvidence = contract.outputSchema.parse(
    summary.structuredContent,
  );
  expect(summaryEvidence).toMatchObject({
    operation: "inspect_analysis_view",
    evidence_links: [completeEvidence.evidence_id],
    normalized_result: {
      kind: "summary",
      parent_evidence_id: completeEvidence.evidence_id,
      parent_operation: "analyze_javascript_application",
    },
  });
  expect(textBytes(summary.content)).toBeLessThan(textBytes(complete.content));

  const modules = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: completeEvidence.evidence_id,
      },
      view: { kind: "page", collection: "modules", offset: 0, limit: 8 },
    },
  });
  expect(modules.isError).not.toBe(true);
  expect(modules.structuredContent).toMatchObject({
    normalized_result: {
      kind: "page",
      parent_evidence_id: completeEvidence.evidence_id,
    },
  });
});

it("refuses summary detail when the server cannot retain the complete Evidence", async () => {
  const client = await connect(false);
  const failure = parseMcpToolError(
    await client.callTool({
      name: contract.name,
      arguments: { ...(await application()), detail: "summary" },
    }),
  );
  expect(failure.error).toMatchObject({
    code: "capability_unavailable",
    message: expect.stringContaining("detail complete"),
  });
});
