import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { publishCliAnalysisEvidence } from "../../src/cli/analysisEvidenceDelivery.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { ok } from "../../src/domain/result.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

vi.mock("node:v8", () => ({
  getHeapStatistics: () => ({
    total_available_size: 1,
    heap_size_limit: 1,
  }),
}));

it("publishes CLI Evidence without re-authenticating the complete graph", async () => {
  const root = await createTestTempDirectory("rea-cli-evidence-");
  const destination = join(root, "bundle.json");
  const evidence = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "fixture",
      parameters: { payload_bytes: 4_000_000 },
      result: { payload: "x".repeat(4_000_000) },
    },
    { immutable: true },
  );

  const output = await publishCliAnalysisEvidence(ok(evidence), {
    providerId: "fixture",
    operation: "fixture",
    signal: new AbortController().signal,
    detail: "complete",
    evidenceOutput: destination,
  });

  expect(output).toMatchObject({ evidence_id: evidence.evidence_id });
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(destination, "utf8")),
  );
  expect(bundle.records.map((record) => record.evidence_id)).toContain(
    evidence.evidence_id,
  );
});

it("keeps the writer heap check for mutable source Evidence", async () => {
  const root = await createTestTempDirectory("rea-cli-mutable-evidence-");
  const destination = join(root, "bundle.json");
  const evidence = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "fixture",
      parameters: { payload_bytes: 1_000 },
      result: { payload: "x".repeat(1_000) },
    },
  );
  const mutable = JSON.parse(JSON.stringify(evidence)) as typeof evidence;

  const output = await publishCliAnalysisEvidence(ok(evidence), {
    providerId: "fixture",
    operation: "fixture",
    signal: new AbortController().signal,
    detail: "complete",
    evidenceOutput: destination,
    sourceEvidence: [mutable],
  });

  expect(output).toMatchObject({ code: "resource_constraint" });
});
