import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { EvidenceLedger } from "../application/investigation/EvidenceLedger.js";
import { createByteEntropyService } from "../composition/binaryDiagnostics/byteEntropy.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AGENT_RESULT_BUDGET_ENVIRONMENT } from "../domain/agentResultBudget.js";
import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "../domain/analysisResourceLimits.js";

/** In range, and far below the complete entropy Evidence. */
const VALID_SEED_BYTES = 8192;
import type { Evidence } from "../domain/evidence.js";
import { McpToolRequest, runMcpToolRequest } from "./McpToolRequest.js";
import {
  AGENT_BUDGET_DELIVERY_META,
  ToolResultDelivery,
} from "./ToolResultDelivery.js";
import { measureMcpResultWithinBudget } from "./toolResultEncoding.js";

const contract = toolContract("inspect_byte_entropy");

/** Complete entropy Evidence far over the default agent budget. */
const largeEntropyEvidence = async (): Promise<Evidence> => {
  const root = await createTestTempDirectory("rea-delivery-budget-");
  const path = join(root, "bytes");
  await writeFile(path, randomBytes(1024 * 1024));
  const inspected = await createByteEntropyService().inspect({
    path,
    block_size: 256,
  });
  if (!inspected.ok) throw inspected.error;
  return inspected.value;
};

/** Deliver as a request whose caller omitted `detail`. */
const deliver = (
  delivery: ToolResultDelivery,
  evidence: Evidence,
  ledger: EvidenceLedger,
) => {
  const request = new McpToolRequest(1, contract.name);
  request.deliverySelection = { detail: undefined };
  return runMcpToolRequest(request, () =>
    delivery.toEvidenceToolResult(
      evidence,
      contract,
      ledger.record(evidence),
      undefined,
      (summary) => ledger.record(summary),
    ),
  );
};

const frameBytes = (result: unknown): number => {
  const measured = measureMcpResultWithinBudget(
    result,
    Number.MAX_SAFE_INTEGER,
  );
  if (!measured.ok) throw new Error("unbounded measurement failed");
  return measured.bytes;
};

it("counts the delivery facts in the frame check, at the exact boundary", async () => {
  const evidence = await largeEntropyEvidence();
  const unlimited = deliver(
    new ToolResultDelivery(1024 * 1024 * 1024),
    evidence,
    new EvidenceLedger(),
  );
  expect(unlimited.isError).not.toBe(true);
  expect(unlimited._meta?.[AGENT_BUDGET_DELIVERY_META]).toBeDefined();
  const total = frameBytes(unlimited);

  // A frame budget one byte short of the complete response refuses it with
  // recovery instead of sending an oversized frame.
  const short = deliver(
    new ToolResultDelivery(total - 1 + 1024),
    evidence,
    new EvidenceLedger(),
  );
  expect(short.isError).toBe(true);
  expect(short.structuredContent).toMatchObject({
    error: {
      details: {
        reported_limits: {
          evidence_reference: { evidence_id: evidence.evidence_id },
          agent_budget: { evidence_id: evidence.evidence_id },
        },
      },
    },
  });

  // The reservation is an upper bound: with room for it the response is sent
  // and the whole frame, delivery facts included, fits the frame budget.
  const roomy = new ToolResultDelivery(total + 64 + 1024);
  const sent = deliver(roomy, evidence, new EvidenceLedger());
  expect(sent.isError).not.toBe(true);
  expect(frameBytes(sent)).toBeLessThanOrEqual(roomy.resultBudgetBytes);
});

it("reads the budget seed from the environment the server captured, not the process", async () => {
  const evidence = await largeEntropyEvidence();
  const previous = process.env[AGENT_RESULT_BUDGET_ENVIRONMENT];
  // The ambient seed would raise the budget; the captured one keeps the default.
  process.env[AGENT_RESULT_BUDGET_ENVIRONMENT] = String(10 * 1024 * 1024);
  try {
    const defaulted = deliver(
      new ToolResultDelivery(64 * 1024 * 1024),
      evidence,
      new EvidenceLedger(),
    );
    expect(defaulted._meta?.[AGENT_BUDGET_DELIVERY_META]).toMatchObject({
      budget_bytes: DEFAULT_AGENT_RESULT_BUDGET_BYTES,
      budget_source: "default",
    });
    const seeded = deliver(
      new ToolResultDelivery(
        64 * 1024 * 1024,
        undefined,
        undefined,
        // A valid seed below the result size, so the seed itself decides.
        String(VALID_SEED_BYTES),
      ),
      evidence,
      new EvidenceLedger(),
    );
    expect(seeded._meta?.[AGENT_BUDGET_DELIVERY_META]).toMatchObject({
      budget_bytes: VALID_SEED_BYTES,
      budget_source: "setting",
    });
    // An out-of-range seed is rejected rather than defaulted: unbudgeted.
    const invalid = deliver(
      new ToolResultDelivery(
        64 * 1024 * 1024,
        undefined,
        undefined,
        String(MAXIMUM_AGENT_RESULT_BUDGET_BYTES + 1),
      ),
      evidence,
      new EvidenceLedger(),
    );
    expect(invalid._meta?.[AGENT_BUDGET_DELIVERY_META]).toBeUndefined();
    expect((invalid.structuredContent as Evidence).operation).toBe(
      "inspect_byte_entropy",
    );
  } finally {
    if (previous === undefined)
      delete process.env[AGENT_RESULT_BUDGET_ENVIRONMENT];
    else process.env[AGENT_RESULT_BUDGET_ENVIRONMENT] = previous;
  }
});
