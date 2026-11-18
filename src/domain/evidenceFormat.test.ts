import { unknownTarget } from "./targetIdentity.js";
import { expect, it } from "vitest";

import { createEvidence, parseEvidence } from "./evidence.js";
import {
  createEvidenceBundle,
  readEvidenceBundle,
  safeParseEvidenceBundle,
} from "./evidenceBundle.js";
import {
  EVIDENCE_FORMAT_REVISION,
  RECREATE_EVIDENCE_GUIDANCE,
} from "./evidenceFormat.js";
import { PRE_66_NULL_COVERAGE_EVIDENCE } from "./evidenceLegacy.fixture.js";
import { ParseFailureError } from "./parseFailure.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import { readEvidence, readImmutableEvidence } from "./evidenceValidation.js";

const record = createEvidence(
  unknownTarget("not-observed"),
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
  expect(parsed.error.cause).toBeInstanceOf(ParseFailureError);
  expect(parsed.error.cause).toMatchObject({
    failure: {
      kind: "unsupported",
      format: "evidence-bundle",
      field: "evidence_format",
      undecodedContent: true,
    },
  });
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

it.each([
  ["a pre-6.6 record", PRE_66_NULL_COVERAGE_EVIDENCE],
  ["a revision 1 record", { ...record, evidence_format: 1 }],
])(
  "refuses %s alone or inside a current bundle, with the recreate guidance",
  (_name, fixture) => {
    const earlier = structuredClone(fixture);
    expect(() => parseEvidence(earlier)).toThrow(RECREATE_EVIDENCE_GUIDANCE);
    for (const read of [readEvidence, readImmutableEvidence]) {
      const refused = read(earlier);
      if (refused.ok) throw new Error("Expected the earlier record refused");
      expect(refused.error).toBeInstanceOf(EvidenceIntegrityError);
      expect(refused.error.userMessage).toContain(RECREATE_EVIDENCE_GUIDANCE);
    }
    const parsed = safeParseEvidenceBundle({
      ...createEvidenceBundle([record]),
      records: [earlier],
    });
    if (parsed.ok) throw new Error("Expected the earlier record to be refused");
    expect(parsed.error.kind).toBe("unsupported-format");
    expect(parsed.error.cause).toMatchObject({
      failure: { format: "evidence-record", field: "evidence_format" },
    });
    expect(earlier).toEqual(fixture);
  },
);
