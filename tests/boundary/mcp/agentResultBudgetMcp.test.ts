import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createCli } from "../../../src/cli.js";

import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "../../../src/domain/analysisResourceLimits.js";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { ok } from "../../../src/domain/result.js";
import { analysisViewLayoutFixture } from "../../fixtures/analysisView.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import {
  AGENT_RESULT_BUDGET_SETTING,
  EVIDENCE_OUTPUT_PLACEHOLDER,
} from "../../../src/domain/agentResultBudget.js";
import { AGENT_BUDGET_DELIVERY_META } from "../../../src/server/ToolResultDelivery.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import { withCliEvidencePublication } from "../../../src/cli/cliEvidencePublication.js";
import { createByteEntropyService } from "../../../src/composition/binaryDiagnostics/byteEntropy.js";
import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Entropy inspection must not start a deep provider");
  });
  // Exercise the default budget, not the complete-delivery seed the test
  // environment gives spawned processes.
  const { REA_AGENT_RESULT_BUDGET_BYTES: _seed, ...environment } = process.env;
  const server = createServer({ kind: "session", session }, { environment });
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

type Delivery = {
  readonly kind: string;
  readonly budget_bytes: number;
  readonly complete_bytes: number;
  readonly evidence_id: string;
  readonly retained: string;
  readonly note: string;
  readonly next?: {
    readonly operation: string;
    readonly arguments: {
      readonly source: Record<string, string>;
      readonly view: Record<string, unknown>;
    };
  };
};

type Link = {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
};

/**
 * The delivery facts block that follows the summary's own text block, and
 * the resource link to the complete record after it.
 */
const deliveryOf = (result: {
  readonly content?: unknown;
  readonly _meta?: Record<string, unknown> | undefined;
}): Delivery & { readonly link: Link } => {
  const blocks = result.content as { type: string; text: string }[];
  expect(blocks.map(({ type }) => type)).toEqual([
    "text",
    "text",
    "resource_link",
  ]);
  const { delivery } = JSON.parse(blocks[1]!.text) as {
    readonly delivery: Delivery;
  };
  expect(result._meta?.[AGENT_BUDGET_DELIVERY_META]).toEqual(delivery);
  return { ...delivery, link: blocks[2] as unknown as Link };
};

type EvidenceJsonPage = {
  readonly text: string;
  readonly coverage: { readonly next_offset: number | null };
};

/** Page the retained record through inspect_analysis_view until exhausted. */
const pageEvidenceJson = async (
  client: Client,
  next: NonNullable<Delivery["next"]>,
): Promise<string> => {
  const pages: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await client.callTool({
      name: next.operation,
      arguments: {
        ...next.arguments,
        view: { ...next.arguments.view, offset },
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
  const delivery = deliveryOf(delivered);
  expect(delivery).toMatchObject({
    kind: "agent-budget-summary",
    budget_bytes: DEFAULT_AGENT_RESULT_BUDGET_BYTES,
    evidence_id: view.parent_evidence_id,
    retained: "session",
    next: {
      operation: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: view.parent_evidence_id,
        },
        view: { kind: "evidence-json", offset: 0 },
      },
    },
  });

  // The budgeted summary is the same record detail summary delivers, so its
  // identity holds wherever a summary is accepted.
  const explicit = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { ...input, detail: "summary" },
  });
  expect(parseEvidence(explicit.structuredContent).evidence_id).toBe(
    summary.evidence_id,
  );
  // The delivered summary is itself retained, as an explicit one is.
  const summaryRecord = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: summary.evidence_id },
      view: { kind: "evidence-json", offset: 0 },
    },
  });
  expect(summaryRecord.isError).not.toBe(true);

  // An explicit per-call detail keeps complete inline delivery.
  const complete = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { ...input, detail: "complete" },
  });
  expect(complete.isError).not.toBe(true);
  const completeEvidence: Evidence = parseEvidence(complete.structuredContent);
  expect(completeEvidence.operation).toBe("inspect_byte_entropy");
  expect(completeEvidence.evidence_id).toBe(view.parent_evidence_id);
  expect(complete.content).toHaveLength(1);
  expect(textBytes(complete.content)).toBe(delivery.complete_bytes);

  // Paging the cursor reproduces the complete retained Evidence exactly.
  const joined = await pageEvidenceJson(client, delivery.next!);
  expect(joined).toBe(JSON.stringify(complete.structuredContent));
  expect(JSON.parse(joined)).toEqual(complete.structuredContent);

  // The link names the same retained parent, and one read returns its exact
  // JSON: the bytes the cursor pages and that complete detail delivers.
  expect(delivery.link).toEqual({
    type: "resource_link",
    uri: `rea://evidence/${view.parent_evidence_id}`,
    name: "complete-evidence",
    title: `Complete inspect_byte_entropy Evidence (${String(delivery.complete_bytes)} bytes)`,
    mimeType: "application/json",
    size: delivery.complete_bytes,
  });
  const read = await client.readResource({ uri: delivery.link.uri });
  expect(read.contents).toHaveLength(1);
  const [contents] = read.contents as {
    uri: string;
    mimeType: string;
    text: string;
  }[];
  expect(contents).toMatchObject({
    uri: delivery.link.uri,
    mimeType: "application/json",
  });
  expect(contents!.text).toBe(joined);
  expect(Buffer.byteLength(contents!.text)).toBe(delivery.link.size);
});

it("serves retained Evidence by template only, and refuses an ID this session does not retain", async () => {
  const client = await connect();
  expect(client.getServerCapabilities()?.resources).toBeDefined();
  const templates = await client.listResourceTemplates();
  expect(templates.resourceTemplates).toEqual([
    expect.objectContaining({
      name: "retained-evidence",
      uriTemplate: "rea://evidence/{evidence_id}",
      mimeType: "application/json",
    }),
  ]);
  // Records are linked from the results that summarize them, not listed.
  expect((await client.listResources()).resources).toEqual([]);

  // Complete Evidence that fits is delivered inline, with no link.
  const fitting = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: await entropyTarget(4096),
  });
  expect(fitting.isError).not.toBe(true);
  expect(
    (fitting.content as { type: string }[]).map(({ type }) => type),
  ).toEqual(["text"]);
  const retained = parseEvidence(fitting.structuredContent);
  // Any record the session retains reads exactly.
  const read = await client.readResource({
    uri: `rea://evidence/${retained.evidence_id}`,
  });
  expect((read.contents[0] as { text: string }).text).toBe(
    JSON.stringify(fitting.structuredContent),
  );

  // An unknown ID, one another session retained, or one a reset cleared is
  // not found.
  const other = await connect();
  const cleared = await connect();
  const before = await cleared.callTool({
    name: "inspect_byte_entropy",
    arguments: await entropyTarget(4096),
  });
  const clearedUri = `rea://evidence/${parseEvidence(before.structuredContent).evidence_id}`;
  expect(
    (await cleared.readResource({ uri: clearedUri })).contents,
  ).toHaveLength(1);
  const reset = await cleared.callTool({
    name: "reset_investigation",
    arguments: {},
  });
  expect(reset.isError).not.toBe(true);
  for (const [reader, uri] of [
    [client, `rea://evidence/ev_${"0".repeat(64)}`],
    [other, `rea://evidence/${retained.evidence_id}`],
    [cleared, clearedUri],
  ] as const)
    await expect(reader.readResource({ uri })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("is not retained in this MCP session"),
    });
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

it("budgets tools whose SDK schema defers validation to the application", async () => {
  const fixture = analysisViewLayoutFixture();
  // Enough symbol rows to exceed the smallest budget.
  const layout = {
    ...fixture,
    symbols: [
      ...fixture.symbols,
      ...Array.from({ length: 16 }, (_, index) => ({
        ...fixture.symbols[0]!,
        entry_index: fixture.symbols.length + index,
      })),
    ],
  };
  const session = createTestBinarySession(() => {
    throw new Error("Layout inspection must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      binaryLayout: new BinaryLayoutService({
        inspectAndClose(input, options) {
          return this.inspect(input, options);
        },
        identity: BINARY_LAYOUT_TEST_PROVIDER,
        inspect: () => Promise.resolve(ok(layout)),
      }),
    },
  );
  const client = new Client(
    { name: "agent-result-budget-layout", version: "1" },
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
  const lowered = await client.callTool({
    name: "update_analysis_settings",
    arguments: {
      changes: [
        {
          setting: AGENT_RESULT_BUDGET_SETTING,
          action: "set",
          value: MINIMUM_AGENT_RESULT_BUDGET_BYTES,
        },
      ],
    },
  });
  expect(lowered.isError).not.toBe(true);
  const target = { path: layout.artifact.path };
  const complete = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { ...target, detail: "complete" },
  });
  expect(textBytes(complete.content)).toBeGreaterThan(
    MINIMUM_AGENT_RESULT_BUDGET_BYTES,
  );
  const budgeted = await client.callTool({
    name: "inspect_binary_layout",
    arguments: target,
  });
  expect(budgeted.isError).not.toBe(true);
  expect(parseEvidence(budgeted.structuredContent).operation).toBe(
    "inspect_analysis_view",
  );
  expect(deliveryOf(budgeted)).toMatchObject({
    budget_bytes: MINIMUM_AGENT_RESULT_BUDGET_BYTES,
    evidence_id: parseEvidence(complete.structuredContent).evidence_id,
  });
});

it("writes nothing for CLI overflow without --evidence_output and names both rerun commands", async () => {
  const input = await entropyTarget(1024 * 1024);
  // Every location a spill could use is a fresh, empty directory.
  const home = await createTestTempDirectory("rea-agent-budget-home-");
  const temporary = await createTestTempDirectory("rea-agent-budget-tmp-");
  const cache = await createTestTempDirectory("rea-agent-budget-cache-");
  const environment = {
    HOME: home,
    TMPDIR: temporary,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: cache,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  const argv = [
    "inspect-byte-entropy",
    input.path,
    "--block-size",
    "256",
    "--json",
  ];
  let stdout = "";
  let exitCode = 0;
  await createCli(environment).serve([...argv], {
    env: environment,
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  expect(exitCode, stdout).toBe(0);
  const output = JSON.parse(stdout) as {
    readonly summary: unknown;
    readonly delivery: Delivery & {
      readonly rerun: {
        readonly complete: readonly string[];
        readonly retained: readonly string[];
      };
    };
    readonly evidence_bundle?: unknown;
  };
  expect(parseEvidence(output.summary).operation).toBe("inspect_analysis_view");
  expect(output.evidence_bundle).toBeUndefined();
  expect(output.delivery).toMatchObject({ retained: "not-retained" });
  // Only the arguments to add: caller inputs, which can carry access
  // credentials such as a browser socket ID, are never echoed.
  expect(output.delivery.rerun).toEqual({
    complete: ["--detail", "complete"],
    retained: ["--evidence_output", EVIDENCE_OUTPUT_PLACEHOLDER],
  });
  expect(JSON.stringify(output.delivery)).not.toContain(input.path);
  expect(output.delivery.note).toContain("--detail complete");
  expect(output.delivery.note).toContain("--evidence_output");
  for (const directory of [home, temporary, cache])
    expect(await readdir(directory)).toEqual([]);
  expect(await readdir(join(input.path, ".."))).toEqual(["bytes"]);
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

it("delivers a target failure unchanged by the delivery budget", async () => {
  const client = await connect();
  const updated = await client.callTool({
    name: "update_analysis_settings",
    arguments: {
      changes: [
        {
          setting: AGENT_RESULT_BUDGET_SETTING,
          action: "set",
          value: MINIMUM_AGENT_RESULT_BUDGET_BYTES,
        },
      ],
    },
  });
  expect(updated.isError).not.toBe(true);
  const root = await createTestTempDirectory("rea-agent-budget-failure-");
  const path = join(root, "not-rust");
  await writeFile(path, randomBytes(4096));
  const omitted = await client.callTool({
    name: "inspect_rust_binary",
    arguments: { path },
  });
  const complete = await client.callTool({
    name: "inspect_rust_binary",
    arguments: { path, detail: "complete" },
  });
  expect(omitted.isError).toBe(true);
  const [first] = omitted.content as { type: string; text: string }[];
  expect(JSON.parse(first!.text)).toMatchObject({
    error: { code: "unsupported_target" },
  });
  // The failure keeps its own projection: no summary, no delivery facts.
  expect(omitted._meta?.[AGENT_BUDGET_DELIVERY_META]).toBeUndefined();
  expect(omitted).toEqual(complete);
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

  const unretained = (await publish(undefined)) as {
    readonly summary: unknown;
    readonly delivery: Delivery;
  };
  const unretainedSummary = parseEvidence(unretained.summary);
  expect(unretainedSummary.operation).toBe("inspect_analysis_view");
  expect(
    (unretainedSummary.normalized_result as { parent_evidence_id: string })
      .parent_evidence_id,
  ).toBe(complete.evidence_id);
  expect(unretained.delivery).toMatchObject({
    retained: "not-retained",
    evidence_id: complete.evidence_id,
  });
  expect(unretained.delivery.next).toBeUndefined();
  expect(parseEvidence(await publish("complete")).evidence_id).toBe(
    complete.evidence_id,
  );
  // The invocation's captured seed, a valid value below the result size,
  // decides the budget.
  const seeded = (await withCliEvidencePublication(() => publish(undefined), {
    agentBudgetSeed: "8192",
  })) as { readonly delivery: Delivery & { readonly budget_source: string } };
  expect(seeded.delivery).toMatchObject({
    budget_bytes: 8192,
    budget_source: "setting",
  });

  const bundle = join(
    await createTestTempDirectory("rea-agent-budget-bundle-"),
    "evidence.json",
  );
  const published = (await publish(undefined, bundle)) as {
    readonly summary: Evidence;
    readonly evidence_bundle: { readonly path: string };
    readonly delivery: Delivery;
  };
  expect(published.summary.operation).toBe("inspect_analysis_view");
  expect(published.evidence_bundle.path).toBe(bundle);
  expect(published.delivery.next?.arguments.source).toEqual({
    kind: "evidence-file",
    path: bundle,
    evidence_id: complete.evidence_id,
  });
  const page = await inspectAnalysisView({
    ...published.delivery.next!.arguments,
    view: { kind: "evidence-json", offset: 0, limit: 1_048_576 },
  });
  if (!page.ok) throw page.error;
  const { text } = page.value.normalized_result as unknown as EvidenceJsonPage;
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(complete)));
});
