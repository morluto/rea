import { unknownTarget } from "./targetIdentity.js";
import { expect, it } from "vitest";

import { createEvidence } from "./evidence.js";
import {
  createEvidenceBundle,
  safeParseEvidenceBundle,
} from "./evidenceBundle.js";
import {
  EVIDENCE_FORMAT_REVISION,
  RECREATE_EVIDENCE_GUIDANCE,
} from "./evidenceFormat.js";
import { PRE_66_NULL_COVERAGE_EVIDENCE } from "./evidenceLegacy.fixture.js";
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
  expect(parsed.error.cause).toMatchObject({
    failure: {
      kind: "unsupported",
      format: "evidence-bundle",
      field: "evidence_format",
      undecodedContent: true,
    },
  });
});

it("distinguishes earlier records from malformed unmarked input", () => {
  const unsupported = {
    kind: "unsupported",
    format: "evidence-record",
    field: "evidence_format",
    undecodedContent: true,
  };
  const bundle = createEvidenceBundle([record]);
  for (const [fixture, read] of [
    [PRE_66_NULL_COVERAGE_EVIDENCE, readEvidence],
    [{ ...record, evidence_format: 1 }, readImmutableEvidence],
  ] as const) {
    const earlier = structuredClone(fixture);
    expect(read(earlier)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        userMessage: expect.stringContaining(RECREATE_EVIDENCE_GUIDANCE),
        cause: { failure: unsupported },
      },
    });
    expect(
      safeParseEvidenceBundle({ ...bundle, records: [earlier] }),
    ).toMatchObject({
      ok: false,
      error: { kind: "unsupported-format", cause: { failure: unsupported } },
    });
    expect(earlier).toEqual(fixture);
  }
  expect(
    readEvidence({ evidence_id: record.evidence_id }, { side: "left" }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      side: "left",
      issuePath: ["evidence_format"],
    },
  });
});
