import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import {
  cliDeliveredEvidence,
  withCliResultControls,
} from "../../../src/cli/cliResultControls.js";
import { createByteEntropyService } from "../../../src/composition/binaryDiagnostics/byteEntropy.js";
import {
  AGENT_RESULT_BUDGET_SETTING,
  PARTIAL_OBSERVATION_DELIVERY,
} from "../../../src/domain/agentResultBudget.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "../../../src/domain/analysisResourceLimits.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { analysisViewLayoutFixture } from "../../fixtures/analysisView.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

type Delivery = {
  readonly kind: string;
  readonly budget_bytes: number;
  readonly complete_bytes: number;
  readonly evidence_id: string;
  readonly retained: string;
  readonly next?: {
    readonly operation: string;
    readonly arguments: {
      readonly source: Record<string, string>;
      readonly view: Record<string, unknown>;
    };
  };
  readonly rerun?: unknown;
};

type Failure = {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly [key: string]: unknown;
};

/** A capacity stop that keeps the completed work as its partial observation. */
const stoppedWith = (partial: Evidence | undefined, operation: string) =>
  new AnalysisResourceConstraintError(
    operation,
    "capacity",
    "The fixture stopped after completing its observation.",
    { fixture_rows: 1 },
    partial === undefined ? {} : { partialObservation: partial },
  );

/** The failure's facts besides its partial observation and its delivery. */
const failureFacts = (failure: Failure) => {
  const {
    partial_observation: _partial,
    [PARTIAL_OBSERVATION_DELIVERY]: _delivery,
    ...details
  } = failure.details;
  return { ...failure, details };
};

/** Join every evidence-json page the cursor names. */
const pageAll = async (
  read: (offset: number) => Promise<{ text: string; next: number | null }>,
): Promise<string> => {
  const pages: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await read(offset);
    pages.push(page.text);
    offset = page.next;
  }
  return pages.join("");
};

const pageText = (evidence: Evidence) => {
  const { text, coverage } = evidence.normalized_result as unknown as {
    readonly text: string;
    readonly coverage: { readonly next_offset: number | null };
  };
  return { text, next: coverage.next_offset };
};

it("delivers an over-budget partial observation as its summary with a cursor on MCP, never budgeting the failure facts", async () => {
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
  let partial: Evidence | undefined;
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
        inspect: () =>
          Promise.resolve(
            partial === undefined
              ? ok(layout)
              : err(stoppedWith(partial, "inspect_binary_layout")),
          ),
      }),
    },
  );
  const client = new Client(
    { name: "partial-observation-budget", version: "1" },
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
  const setBudget = async (value: number) => {
    const updated = await client.callTool({
      name: "update_analysis_settings",
      arguments: {
        changes: [
          { setting: AGENT_RESULT_BUDGET_SETTING, action: "set", value },
        ],
      },
    });
    expect(updated.isError).not.toBe(true);
  };
  await setBudget(MINIMUM_AGENT_RESULT_BUDGET_BYTES);
  const target = { path: layout.artifact.path };
  const complete = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { ...target, detail: "complete" },
  });
  partial = parseEvidence(complete.structuredContent);
  const completeText = JSON.stringify(complete.structuredContent);
  expect(Buffer.byteLength(completeText)).toBeGreaterThan(
    MINIMUM_AGENT_RESULT_BUDGET_BYTES,
  );

  const budgetedResult = await client.callTool({
    name: "inspect_binary_layout",
    arguments: target,
  });
  const budgeted = parseMcpToolError(budgetedResult)
    .error as unknown as Failure;
  const summary = parseEvidence(budgeted.details.partial_observation);
  expect(summary.operation).toBe("inspect_analysis_view");
  expect(summary.normalized_result).toMatchObject({
    kind: "summary",
    parent_evidence_id: partial.evidence_id,
  });
  const delivery = budgeted.details[PARTIAL_OBSERVATION_DELIVERY] as Delivery;
  expect(delivery).toMatchObject({
    kind: "agent-budget-summary",
    budget_bytes: MINIMUM_AGENT_RESULT_BUDGET_BYTES,
    complete_bytes: Buffer.byteLength(completeText),
    evidence_id: partial.evidence_id,
    retained: "session",
  });
  // The retained partial pages back byte-identical through the cursor.
  const next = delivery.next!;
  const joined = await pageAll(async (offset) => {
    const page = await client.callTool({
      name: next.operation,
      arguments: {
        ...next.arguments,
        view: { ...next.arguments.view, offset },
      },
    });
    expect(page.isError).not.toBe(true);
    return pageText(parseEvidence(page.structuredContent));
  });
  expect(joined).toBe(completeText);
  // The error also links the complete partial, and one read returns it.
  const [, link] = budgetedResult.content as {
    readonly type: string;
    readonly uri: string;
    readonly size: number;
  }[];
  expect(link).toMatchObject({
    type: "resource_link",
    uri: `rea://evidence/${partial.evidence_id}`,
    size: Buffer.byteLength(completeText),
  });
  const read = await client.readResource({ uri: link!.uri });
  expect((read.contents[0] as { text: string }).text).toBe(completeText);

  // Explicit complete detail, and a budget it fits, keep the failure as it
  // was: the session's retained reference.
  const explicit = parseMcpToolError(
    await client.callTool({
      name: "inspect_binary_layout",
      arguments: { ...target, detail: "complete" },
    }),
  ).error as unknown as Failure;
  await setBudget(MAXIMUM_AGENT_RESULT_BUDGET_BYTES);
  const fitting = parseMcpToolError(
    await client.callTool({ name: "inspect_binary_layout", arguments: target }),
  ).error as unknown as Failure;
  for (const unchanged of [explicit, fitting])
    expect(unchanged.details).toMatchObject({
      partial_observation: {
        kind: "retained-evidence",
        evidence_id: partial.evidence_id,
      },
    });
  expect(fitting.details).not.toHaveProperty(PARTIAL_OBSERVATION_DELIVERY);

  // The failure's own facts are delivered whole, whatever the budget did.
  expect(failureFacts(budgeted)).toEqual(failureFacts(fitting));
  expect(budgeted).toMatchObject({
    code: "resource_constraint",
    retryable: expect.any(Boolean),
    remediation: { action: expect.any(String) },
  });
});

/** Complete entropy Evidence far over the default agent budget, and a small one. */
const entropyEvidence = async (bytes: number): Promise<Evidence> => {
  const root = await createTestTempDirectory("rea-partial-budget-");
  const path = join(root, "bytes");
  await writeFile(path, randomBytes(bytes));
  const inspected = await createByteEntropyService().inspect({
    path,
    block_size: 256,
  });
  if (!inspected.ok) throw inspected.error;
  return inspected.value;
};

it("delivers an over-budget partial observation as its summary on the CLI, with the bundle or the rerun arguments", async () => {
  const large = await entropyEvidence(1024 * 1024);
  const publish = (partial: Evidence, evidenceOutput?: string) =>
    publishCliAnalysisEvidence(
      {
        ok: false,
        error: projectAnalysisError(
          stoppedWith(partial, "inspect_byte_entropy"),
        ) as unknown as JsonValue,
      },
      {
        operation: "inspect_byte_entropy",
        signal: new AbortController().signal,
        detail: undefined,
        evidenceOutput,
      },
    ) as Promise<unknown> as Promise<Failure>;

  // The complete partial is recorded for the CLI's control hints before its
  // summary replaces it.
  const unretained = await withCliResultControls(async () => {
    const output = await publish(large);
    expect((cliDeliveredEvidence() as Evidence | undefined)?.evidence_id).toBe(
      large.evidence_id,
    );
    return output;
  });
  expect(parseEvidence(unretained.details.partial_observation).operation).toBe(
    "inspect_analysis_view",
  );
  expect(unretained.details[PARTIAL_OBSERVATION_DELIVERY]).toMatchObject({
    retained: "not-retained",
    evidence_id: large.evidence_id,
    rerun: { complete: ["--detail", "complete"] },
  });
  const complete = projectAnalysisError(
    stoppedWith(large, "inspect_byte_entropy"),
  ) as unknown as Failure;
  expect(failureFacts(unretained)).toEqual(failureFacts(complete));

  const bundle = join(
    await createTestTempDirectory("rea-partial-budget-bundle-"),
    "evidence.json",
  );
  const published = await publish(large, bundle);
  expect(parseEvidence(published.details.partial_observation).operation).toBe(
    "inspect_analysis_view",
  );
  const delivery = published.details[PARTIAL_OBSERVATION_DELIVERY] as Delivery;
  expect(delivery.next?.arguments.source).toEqual({
    kind: "evidence-file",
    path: bundle,
    evidence_id: large.evidence_id,
  });
  const joined = await pageAll(async (offset) => {
    const page = await inspectAnalysisView({
      ...delivery.next!.arguments,
      view: { kind: "evidence-json", offset },
    });
    if (!page.ok) throw page.error;
    return pageText(page.value);
  });
  // The bundle owns its record's serialization; the record is the same.
  expect(JSON.parse(joined)).toEqual(JSON.parse(JSON.stringify(large)));

  // A partial observation that fits is delivered complete, as before.
  const small = await entropyEvidence(4096);
  const fitting = await publish(small);
  expect(fitting).toEqual(
    projectAnalysisError(stoppedWith(small, "inspect_byte_entropy")),
  );
});

it("keeps the paging call when a summarized partial's bundle commits but its cleanup fails", async () => {
  const large = await entropyEvidence(1024 * 1024);
  const root = await createTestTempDirectory("rea-partial-budget-committed-");
  const bundle = join(root, "evidence.json");
  // Every removal of this bundle's staging directory fails, after the
  // bundle itself is committed.
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    rmdir: (...arguments_: unknown[]) => Promise<void>;
  };
  const rmdir = fs.rmdir;
  fs.rmdir = async (...arguments_: unknown[]) => {
    if (String(arguments_[0]).startsWith(root))
      throw Object.assign(new Error("injected staging cleanup failure"), {
        code: "EBUSY",
      });
    return rmdir(...arguments_);
  };
  syncBuiltinESMExports();
  let failure: Failure;
  try {
    failure = (await publishCliAnalysisEvidence(
      {
        ok: false,
        error: projectAnalysisError(
          stoppedWith(large, "inspect_byte_entropy"),
        ) as unknown as JsonValue,
      },
      {
        operation: "inspect_byte_entropy",
        signal: new AbortController().signal,
        detail: undefined,
        evidenceOutput: bundle,
      },
    )) as unknown as Failure;
  } finally {
    fs.rmdir = rmdir;
    syncBuiltinESMExports();
  }
  expect(failure).toMatchObject({ code: "cleanup_incomplete" });
  expect(parseEvidence(failure.details.partial_observation).operation).toBe(
    "inspect_analysis_view",
  );
  expect(failure.details[PARTIAL_OBSERVATION_DELIVERY]).toMatchObject({
    evidence_id: large.evidence_id,
    next: {
      arguments: {
        source: {
          kind: "evidence-file",
          path: bundle,
          evidence_id: large.evidence_id,
        },
      },
    },
  });
});
