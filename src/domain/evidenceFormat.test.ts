import { expect, it } from "vitest";

import { createEvidence } from "./evidence.js";
import {
  createEvidenceBundle,
  readEvidenceBundle,
  safeParseEvidenceBundle,
} from "./evidenceBundle.js";
import {
  EVIDENCE_FORMAT_REVISION,
  RECREATE_EVIDENCE_GUIDANCE,
} from "./evidenceFormat.js";

const record = createEvidence(
  undefined,
  { id: "fixture", name: "Fixture", version: "1" },
  { operation: "observe", parameters: {}, result: { observed: true } },
);

it("writes the current format revision and reads it back", () => {
  const bundle = createEvidenceBundle([record]);
  expect(bundle.evidence_format).toBe(EVIDENCE_FORMAT_REVISION);
  expect(safeParseEvidenceBundle(JSON.parse(JSON.stringify(bundle)))).toEqual({
    ok: true,
    value: bundle,
  });
});

it.each([
  ["an unmarked (6.x) bundle", undefined],
  ["another revision", EVIDENCE_FORMAT_REVISION + 1],
  ["a malformed revision", "1"],
])("refuses %s once, with the recreate guidance", (_name, format) => {
  const { evidence_format: _current, ...unmarked } = createEvidenceBundle([
    record,
  ]);
  const earlier =
    format === undefined ? unmarked : { ...unmarked, evidence_format: format };
  const parsed = safeParseEvidenceBundle(earlier);
  if (parsed.ok) throw new Error("Expected the earlier format to be refused");
  expect(parsed.error.kind).toBe("unsupported-format");
  expect(parsed.error.message).toContain(RECREATE_EVIDENCE_GUIDANCE);
  const read = readEvidenceBundle(earlier, {
    operation: "import_evidence_bundle",
    path: ["evidence_bundle"],
  });
  expect(read).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      userMessage: expect.stringContaining(RECREATE_EVIDENCE_GUIDANCE),
    },
  });
});

it("still names a standalone Evidence record as the wrong input kind", () => {
  const parsed = safeParseEvidenceBundle(record);
  if (parsed.ok) throw new Error("Expected a record to be refused");
  expect(parsed.error.kind).toBe("single-record");
});
