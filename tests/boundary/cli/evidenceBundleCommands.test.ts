import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
} from "../../../src/domain/residualUnknown.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const revisionBundle = () => {
  const records = ["open", "investigate"].map((operation) =>
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation, parameters: {}, result: { observed: operation } },
    ),
  );
  const [opened, investigated] = records;
  if (opened === undefined || investigated === undefined)
    throw new Error("Missing mutation Evidence");
  const details = {
    severity: "high" as const,
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: null,
    required_confidence: "observed" as const,
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  };
  const initial = createResidualUnknown(
    { question: "How is this input handled?", domain: "protocol", ...details },
    opened.evidence_id,
    null,
  );
  const revised = updateResidualUnknown(
    initial,
    {
      unknown_id: initial.unknown_id,
      expected_revision: initial.revision,
      status: "investigating",
      ...details,
      resolution: null,
    },
    investigated.evidence_id,
  );
  return createEvidenceBundle(records, [initial, revised]);
};

cliTest(
  "reports standalone import counts for every unknown revision",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-import-");
    const path = join(root, "bundle.json");
    await writeFile(path, JSON.stringify(revisionBundle()));
    const result = await cli.run({
      arguments: ["evidence-import", path, "--json"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ imported: 2, unknowns_added: 2, total: 2 });
  },
);

cliTest(
  "reports a standalone Evidence record as the wrong input file kind",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-record-input-");
    const path = join(root, "record.json");
    const record = revisionBundle().records[0];
    if (record === undefined) throw new Error("Missing fixture Evidence");
    await writeFile(path, JSON.stringify(record));
    const result = await cli.run({
      arguments: ["evidence-import", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: { path },
      message: expect.stringContaining("this JSON is one Evidence record"),
    });
  },
);

cliTest(
  "rejects altered Evidence and incomplete unknown history before reporting counts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-import-invalid-");
    const path = join(root, "bundle.json");
    const bundle = revisionBundle();
    for (const invalid of [
      {
        ...bundle,
        records: bundle.records.map((record) => ({
          ...record,
          normalized_result: "altered",
        })),
      },
      { ...bundle, unknowns: bundle.unknowns.slice(1) },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      const result = await cli.run({
        arguments: ["evidence-import", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "evidence_integrity_mismatch",
      });
      expect(result.json).not.toHaveProperty("imported");
    }
  },
);
