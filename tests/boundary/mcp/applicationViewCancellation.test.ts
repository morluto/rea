import { expect, it } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
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
