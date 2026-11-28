import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import { render, validate } from "./triage.mjs";

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`fixture/${name}`, import.meta.url)));
const bundle = parseEvidenceBundle(await fixture("bundle.ndjson"));
const triage = await fixture("triage.json");
const finding = (copy, verdict) =>
  copy.findings.find((item) => item.verdict === verdict);
const analysis = bundle.records.find(
  ({ operation }) => operation === "analyze_javascript_application",
);
const mutationId = bundle.records.find(
  ({ operation }) => operation === "record_unknown",
).evidence_id;
const resolvedId = bundle.unknowns.find(
  (unknown) => unknown.status === "resolved",
).unknown_id;
const codes = (input, source = bundle) =>
  [...new Set(validate(input, source).issues.map(({ code }) => code))].sort();
const mutate = (change) => {
  const copy = structuredClone(triage);
  change(copy);
  return copy;
};
// validate() receives parsed bundles and does not re-authenticate them, so a
// record appended here stands in for one REA would have produced.
const withRecord = (fields) => {
  const source = structuredClone(bundle);
  const record = { ...structuredClone(analysis), ...fields };
  source.records.push(record);
  return source;
};

test("the fixture triage is valid against the real bundle", () => {
  assert.deepEqual(validate(triage, bundle).issues, []);
});

const triageMutations = [
  [
    "defect cites a missing record",
    ["evidence_not_in_bundle", "verdict_requires_observed_basis"],
    (copy) => (finding(copy, "defect").evidence_ids = [`ev_${"0".repeat(64)}`]),
  ],
  [
    "suspect cites nothing",
    ["finding_without_evidence"],
    (copy) => (finding(copy, "suspect").evidence_ids = []),
  ],
  [
    "defect cites only registry mutation Evidence",
    ["verdict_requires_observed_basis"],
    (copy) => (finding(copy, "defect").evidence_ids = [mutationId]),
  ],
  [
    "acceptable cites only registry mutation Evidence",
    ["verdict_requires_observed_basis"],
    (copy) => (finding(copy, "acceptable").evidence_ids = [mutationId]),
  ],
  [
    "runtime-behavior defect cites only static Evidence",
    ["runtime_claim_without_runtime_authority"],
    (copy) => (finding(copy, "defect").claim_type = "runtime-behavior"),
  ],
  [
    "runtime-behavior suspect and unknown cite only static Evidence",
    [],
    (copy) => {
      finding(copy, "suspect").claim_type = "runtime-behavior";
      finding(copy, "unknown").claim_type = "runtime-behavior";
    },
  ],
  [
    "target digest is absent from the bundle",
    ["evidence_subject_mismatch", "target_not_in_bundle"],
    (copy) => (copy.target.artifact_digest = "0".repeat(64)),
  ],
  [
    "unknown links a missing residual unknown",
    ["unknown_not_in_bundle", "unknown_not_triaged"],
    (copy) => (finding(copy, "unknown").unknown_id = `unk_${"0".repeat(64)}`),
  ],
  [
    "unknown links a resolved residual unknown",
    ["unknown_not_triaged", "unknown_resolved"],
    (copy) => (finding(copy, "unknown").unknown_id = resolvedId),
  ],
  [
    "defect links an open residual unknown",
    ["verdict_conflicts_with_open_unknown"],
    (copy) =>
      (finding(copy, "defect").unknown_id = finding(
        copy,
        "suspect",
      ).unknown_id),
  ],
  [
    "acceptable links an open residual unknown",
    ["verdict_conflicts_with_open_unknown"],
    (copy) =>
      (finding(copy, "acceptable").unknown_id = finding(
        copy,
        "suspect",
      ).unknown_id),
  ],
  [
    "open residual unknown is not linked",
    ["unknown_not_triaged"],
    (copy) => delete finding(copy, "unknown").unknown_id,
  ],
  [
    "defect lacks severity",
    ["severity_missing"],
    (copy) => delete finding(copy, "defect").severity,
  ],
  [
    "suspect lacks disclosure",
    ["disclosure_missing"],
    (copy) => delete finding(copy, "suspect").disclosure,
  ],
  [
    "suspect lacks impact",
    ["impact_missing"],
    (copy) => delete finding(copy, "suspect").impact,
  ],
  [
    "defect lacks remediation",
    ["remediation_missing"],
    (copy) => delete finding(copy, "defect").remediation,
  ],
  [
    "unknown lacks next_probe",
    ["next_probe_missing"],
    (copy) => delete finding(copy, "unknown").next_probe,
  ],
  [
    "finding IDs differ only by case",
    ["duplicate_finding_id"],
    (copy) =>
      (finding(copy, "suspect").id = finding(copy, "defect").id.toUpperCase()),
  ],
  [
    "target has an unknown key",
    ["schema_violation"],
    (copy) => (copy.target.version = 1),
  ],
  [
    "defect cites one record twice",
    ["schema_violation"],
    (copy) => {
      const { evidence_ids: ids } = finding(copy, "defect");
      ids.push(ids[0]);
    },
  ],
  [
    "suspect title has a newline",
    ["schema_violation"],
    (copy) => (finding(copy, "suspect").title += "\nx"),
  ],
  [
    "document title has a control character",
    ["schema_violation"],
    (copy) => (copy.title += "\u0007"),
  ],
];

for (const [name, expected, change] of triageMutations)
  test(`${name}: ${expected.join(", ") || "valid"}`, () => {
    assert.deepEqual(codes(mutate(change)), expected);
  });

test("inferred-only Evidence cannot support defect or acceptable", () => {
  const source = structuredClone(bundle);
  source.records.find(
    ({ evidence_id: id }) => id === analysis.evidence_id,
  ).confidence = "inferred";
  assert.deepEqual(codes(triage, source), ["verdict_requires_observed_basis"]);
});

test("one record must carry both the basis and the runtime authority", () => {
  const replayId = `ev_${"1".repeat(64)}`;
  const runtimeDefect = mutate((copy) => {
    const defect = finding(copy, "defect");
    defect.claim_type = "runtime-behavior";
    defect.evidence_ids.push(replayId);
  });
  const inferredReplay = withRecord({
    evidence_id: replayId,
    confidence: "inferred",
    authority: "controlled-replay",
  });
  assert.deepEqual(codes(runtimeDefect, inferredReplay), [
    "runtime_claim_without_runtime_authority",
  ]);
  const derivedReplay = withRecord({
    evidence_id: replayId,
    confidence: "derived",
    authority: "controlled-replay",
  });
  assert.deepEqual(codes(runtimeDefect, derivedReplay), []);
});

test("the highest revision is current regardless of bundle order", () => {
  const source = structuredClone(bundle);
  source.unknowns.reverse();
  assert.deepEqual(validate(triage, source).issues, []);
});

test("an unknown whose resolving revision is absent must be triaged", () => {
  const source = structuredClone(bundle);
  source.unknowns = source.unknowns.filter(({ revision }) => revision === 1);
  const { issues } = validate(triage, source);
  assert.deepEqual(
    issues.map(({ code, message }) => [code, message.split(" ")[0]]),
    [["unknown_not_triaged", resolvedId]],
  );
});

test("finding IDs are safe ASCII file names", () => {
  const unsafe = [
    "../escape",
    "a/b",
    "a\\b",
    ".hidden",
    "-flag",
    "",
    "a b",
    "x".repeat(65),
    "CON",
    "nul.md",
    "Com1",
    // Case-insensitive Unicode matching folds these into ASCII letters.
    "\u212Aey",
    "\u017Fx",
  ];
  for (const id of unsafe) {
    const { issues } = validate(
      mutate((copy) => (copy.findings[0].id = id)),
      bundle,
    );
    assert.deepEqual(
      issues.map(({ code, path }) => [code, path]),
      [["schema_violation", "findings.0.id"]],
      JSON.stringify(id),
    );
  }
  for (const id of ["a.b_c-1", "x".repeat(64), "console"])
    assert.deepEqual(
      validate(
        mutate((copy) => (copy.findings[0].id = id)),
        bundle,
      ).issues,
      [],
      id,
    );
});

test("findings are ordered by severity, then ID, within a section", () => {
  const input = mutate((copy) => {
    const defect = finding(copy, "defect");
    copy.findings.push(
      { ...defect, id: "a-same-severity" },
      { ...defect, id: "z-critical", severity: "critical" },
    );
  });
  const { triage: parsed, issues } = validate(input, bundle);
  assert.deepEqual(issues, []);
  const report = render(parsed, bundle, "0".repeat(64)).get("report.md");
  const defects = report.slice(
    report.indexOf("## Defects"),
    report.indexOf("## Suspects"),
  );
  assert.deepEqual(
    [...defects.matchAll(/^### ([^:]+):/gmu)].map((match) => match[1]),
    ["z-critical", "a-same-severity", "notes-save-unchecked-path"],
  );
});

test("rendered files never copy local paths or raw provider data", () => {
  const { triage: parsed } = validate(triage, bundle);
  for (const [path, content] of render(parsed, bundle, "0".repeat(64)))
    for (const forbidden of ["/tmp/", "local_path", "raw_result", "parameters"])
      assert.ok(!content.includes(forbidden), `${path} contains ${forbidden}`);
});
