import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { DEFAULT_AGENT_RESULT_BUDGET_BYTES } from "../../../src/domain/analysisResourceLimits.js";
import { AGENT_RESULT_BUDGET_SETTING } from "../../../src/domain/agentResultBudget.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import { createByteEntropyService } from "../../../src/composition/binaryDiagnostics/byteEntropy.js";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Entropy inspection must not start a deep provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "agent-result-budget", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
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

/** Random bytes in 256-byte blocks give one entropy row per block. */
const entropyTarget = async (bytes: number) => {
  const root = await createTestTempDirectory("rea-agent-budget-");
  const path = join(root, "bytes");
  await writeFile(path, randomBytes(bytes));
  return { path, block_size: 256 };
};

const textBytes = (content: unknown): number => {
  const [first] = Array.isArray(content) ? content : [];
  if (first?.type !== "text") throw new Error("Missing MCP text result");
  return Buffer.byteLength(String(first.text));
};

type EvidenceJsonPage = {
  readonly text: string;
  readonly coverage: { readonly next_offset: number | null };
};

/** Page the retained record through inspect_analysis_view until exhausted. */
const pageEvidenceJson = async (
  client: Client,
  evidenceId: string,
): Promise<string> => {
  const pages: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: evidenceId },
        view: { kind: "evidence-json", offset },
      },
    });
    expect(page.isError).not.toBe(true);
    // Each default page itself fits the agent result budget.
    expect(textBytes(page.content)).toBeLessThanOrEqual(
      DEFAULT_AGENT_RESULT_BUDGET_BYTES,
    );
    const result = parseEvidence(page.structuredContent)
      .normalized_result as unknown as EvidenceJsonPage;
    pages.push(result.text);
    offset = result.coverage.next_offset;
  }
  return pages.join("");
};

it("delivers a retained summary with a cursor when complete Evidence exceeds the agent budget", async () => {
  const client = await connect();
  const input = await entropyTarget(1024 * 1024);

  const delivered = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: input,
  });
  expect(delivered.isError).not.toBe(true);
  expect(textBytes(delivered.content)).toBeLessThanOrEqual(
    DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  );
  const summary = parseEvidence(delivered.structuredContent);
  expect(summary.operation).toBe("inspect_analysis_view");
  const view = summary.normalized_result as {
    readonly kind: string;
    readonly parent_operation: string;
    readonly parent_evidence_id: string;
    readonly summary: { readonly block_count: number };
  };
  expect(view).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_byte_entropy",
    summary: { block_count: 4096 },
  });
  const limitation = summary.limitations.find((text) =>
    text.includes(AGENT_RESULT_BUDGET_SETTING),
  );
  expect(limitation).toContain(String(DEFAULT_AGENT_RESULT_BUDGET_BYTES));
  expect(limitation).toContain(view.parent_evidence_id);
  expect(limitation).toContain('"kind":"evidence-json"');

  // An explicit per-call detail keeps complete inline delivery.
  const complete = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { ...input, detail: "complete" },
  });
  expect(complete.isError).not.toBe(true);
  const completeEvidence: Evidence = parseEvidence(complete.structuredContent);
  expect(completeEvidence.operation).toBe("inspect_byte_entropy");
  expect(completeEvidence.evidence_id).toBe(view.parent_evidence_id);
  expect(textBytes(complete.content)).toBeGreaterThan(
    DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  );

  // Paging the cursor reproduces the complete retained Evidence exactly.
  const joined = await pageEvidenceJson(client, view.parent_evidence_id);
  expect(joined).toBe(JSON.stringify(complete.structuredContent));
  expect(JSON.parse(joined)).toEqual(complete.structuredContent);
});

it("delivers complete Evidence that fits, and follows a runtime budget override", async () => {
  const client = await connect();
  const small = await entropyTarget(4096);
  const fitting = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: small,
  });
  expect(parseEvidence(fitting.structuredContent).operation).toBe(
    "inspect_byte_entropy",
  );

  const large = await entropyTarget(1024 * 1024);
  const updated = await client.callTool({
    name: "update_analysis_settings",
    arguments: {
      changes: [
        {
          setting: AGENT_RESULT_BUDGET_SETTING,
          action: "set",
          value: 10 * 1024 * 1024,
        },
      ],
    },
  });
  expect(updated.isError).not.toBe(true);
  const raised = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: large,
  });
  expect(parseEvidence(raised.structuredContent).operation).toBe(
    "inspect_byte_entropy",
  );
});

it("keeps admission refusals unchanged by the delivery budget", async () => {
  const client = await connect();
  // 32,769 blocks of 256 bytes exceed the 32,768-block admission limit.
  const input = await entropyTarget(256 * 32_769);
  for (const detail of [undefined, "complete"] as const) {
    const refused = await client.callTool({
      name: "inspect_byte_entropy",
      arguments: detail === undefined ? input : { ...input, detail },
    });
    expect(refused.isError).toBe(true);
    const [first] = refused.content as { type: string; text: string }[];
    expect(JSON.parse(first!.text)).toMatchObject({
      error: { code: "resource_constraint" },
    });
  }
});

it("delivers the same over-budget summary through CLI publication, with complete Evidence in the bundle", async () => {
  const input = await entropyTarget(1024 * 1024);
  const inspected = await createByteEntropyService().inspect(input);
  if (!inspected.ok) throw inspected.error;
  const complete = inspected.value;
  const publish = (
    detail: "complete" | "summary" | undefined,
    evidenceOutput?: string,
  ) =>
    publishCliAnalysisEvidence(inspected, {
      operation: "inspect_byte_entropy",
      signal: new AbortController().signal,
      detail,
      evidenceOutput,
    });

  const unretained = parseEvidence(await publish(undefined));
  expect(unretained.operation).toBe("inspect_analysis_view");
  expect(
    (unretained.normalized_result as { parent_evidence_id: string })
      .parent_evidence_id,
  ).toBe(complete.evidence_id);
  expect(
    unretained.limitations.some((text) => text.includes("--evidence_output")),
  ).toBe(true);
  expect(parseEvidence(await publish("complete")).evidence_id).toBe(
    complete.evidence_id,
  );

  const bundle = join(
    await createTestTempDirectory("rea-agent-budget-bundle-"),
    "evidence.json",
  );
  const published = (await publish(undefined, bundle)) as {
    readonly summary: Evidence;
    readonly evidence_bundle: { readonly path: string };
  };
  expect(published.summary.operation).toBe("inspect_analysis_view");
  expect(published.evidence_bundle.path).toBe(bundle);
  const page = await inspectAnalysisView({
    source: {
      kind: "evidence-file",
      path: bundle,
      evidence_id: complete.evidence_id,
    },
    view: { kind: "evidence-json", offset: 0, limit: 1_048_576 },
  });
  if (!page.ok) throw page.error;
  const { text } = page.value.normalized_result as unknown as EvidenceJsonPage;
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(complete)));
});
