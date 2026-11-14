import { expect, it } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { deliverApplicationEvidence } from "../../../src/server/registerApplicationTools/helpers.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";

it("retains the completed parent when delivery is cancelled without a view", async () => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const parent = createEvidence(undefined, provider, {
    operation: "inspect_perf_data",
    parameters: { path: "/fixtures/perf.data" },
    result: { format: "perf-data", events: [] },
  });
  const recorded: string[] = [];
  const contract = toolContract("inspect_perf_data");
  // Abort before delivery so the handler's post-selection wait sees it.
  const result = await deliverApplicationEvidence(
    { delivery: new ToolResultDelivery(1_000_000) },
    {
      artifactResources: { close: async () => undefined } as never,
      logger: { debug() {} } as never,
      evidenceById: undefined,
      recordEvidence: (value) => {
        recorded.push(value.evidence_id);
        return { ok: true, value: "added" };
      },
      recordEvidenceWithUnknown: undefined,
    },
    contract,
    { evidence: parent, sources: [] },
    undefined,
    AbortSignal.abort(new Error("cancelled before view delivery")),
  );

  expect(recorded).toEqual([parent.evidence_id]);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: "cancelled",
      details: {
        partial_observation: {
          kind: "retained-evidence",
          evidence_id: parent.evidence_id,
        },
      },
    },
  });
});

it("keeps an unknown the session refused as a secondary cause of the cancellation", async () => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const parent = createEvidence(undefined, provider, {
    operation: "compare_source_to_bundle",
    parameters: { path: "/fixtures/app.asar" },
    result: { format: "source-to-bundle", matches: [] },
  });
  const refusal = new Error("session has no room for the unknown");
  const recordedWithUnknown: string[] = [];
  const contract = toolContract("compare_source_to_bundle");
  const result = await deliverApplicationEvidence(
    { delivery: new ToolResultDelivery(1_000_000) },
    {
      artifactResources: { close: async () => undefined } as never,
      logger: { debug() {} } as never,
      evidenceById: undefined,
      recordEvidence: (value) => {
        recordedWithUnknown.push(value.evidence_id);
        return { ok: true, value: "added" };
      },
      recordEvidenceWithUnknown: () => ({
        ok: false,
        error: new AnalysisInputError("compare_source_to_bundle", {
          cause: refusal,
        }),
      }),
    },
    contract,
    { evidence: parent, sources: [] },
    undefined,
    AbortSignal.abort(new Error("cancelled before view delivery")),
    "source-to-bundle-comparison",
  );

  expect(result.structuredContent).toMatchObject({
    error: {
      code: "cancelled",
      details: {
        secondary_failures: [{ code: "invalid_request" }],
      },
    },
  });
  // The paired save was rejected as a whole, so the parent must not be recorded
  // on its own: that would keep the comparison without the unknown it carries
  // and hand the caller an Evidence record the session was told to refuse.
  expect(result.structuredContent).toMatchObject({
    error: {
      details: {
        partial_observation: {
          kind: "unretained-evidence",
          evidence: { evidence_id: parent.evidence_id },
        },
      },
    },
  });
  expect(recordedWithUnknown).toEqual([]);
});

it("records the parent with its unknown when the paired save succeeds", async () => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const parent = createEvidence(undefined, provider, {
    operation: "compare_source_to_bundle",
    parameters: { path: "/fixtures/app.asar" },
    result: { format: "source-to-bundle", matches: [] },
  });
  const recordedWithUnknown: string[] = [];
  const contract = toolContract("compare_source_to_bundle");
  const result = await deliverApplicationEvidence(
    { delivery: new ToolResultDelivery(1_000_000) },
    {
      artifactResources: { close: async () => undefined } as never,
      logger: { debug() {} } as never,
      evidenceById: undefined,
      recordEvidence: () => ({ ok: true, value: "added" }),
      recordEvidenceWithUnknown: (value) => {
        recordedWithUnknown.push(value.evidence_id);
        return { ok: true, value: null };
      },
    },
    contract,
    { evidence: parent, sources: [] },
    undefined,
    AbortSignal.abort(new Error("cancelled before view delivery")),
    "source-to-bundle-comparison",
  );

  expect(recordedWithUnknown).toEqual([parent.evidence_id]);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: "cancelled",
      details: {
        partial_observation: {
          kind: "retained-evidence",
          evidence_id: parent.evidence_id,
        },
      },
    },
  });
});
