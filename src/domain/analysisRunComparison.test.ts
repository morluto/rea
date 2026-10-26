import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "./analysisErrorCore.js";
import {
  type AnalysisRunEnvelope,
  analysisRunComparisonReportSchema,
  checkAnalysisRunCompatibility,
  compareAnalysisRuns,
  compareCompatibleAnalysisRuns,
} from "./analysisRunComparison.js";

const EV_LEFT = `ev_${"1".repeat(64)}`;
const EV_RIGHT = `ev_${"2".repeat(64)}`;
const EV_PROC_LEFT = `ev_${"3".repeat(64)}`;
const EV_PROC_RIGHT = `ev_${"4".repeat(64)}`;
const SUBJECT_SHA_1 = "a".repeat(64);
const SUBJECT_SHA_2 = "b".repeat(64);

const makeBaseRun = (
  overrides: Partial<AnalysisRunEnvelope> = {},
): AnalysisRunEnvelope => ({
  run_id: "run-left-1",
  evidence_id: EV_LEFT,
  result_type: "binary-analysis",
  operation: "analyze_binary",
  predicate_type: "rea.analysis",
  subject: {
    sha256: SUBJECT_SHA_1,
    format: "elf",
    architecture: "x86_64",
    local_path: "/workspace/left/target.elf",
  },
  provider: {
    id: "ghidra",
    name: "Ghidra",
    version: "11.2",
  },
  relationship_coverage: {
    status: "complete",
    truncated: false,
    omitted_count: 0,
    reason: null,
  },
  procedures: [
    {
      address: "0x00401000",
      name: "main",
      signature: "int main(int argc, char **argv)",
      size_bytes: 64,
      callees: ["0x00401100", "0x00401200"],
      callers: ["0x00400f00"],
      pseudocode_sha256: "c".repeat(64),
      evidence_id: EV_PROC_LEFT,
    },
  ],
  findings: [
    {
      finding_id: "F-AUTH-001",
      category: "authentication",
      severity: "high",
      confidence: "observed",
      title: "Hardcoded token check",
      summary: "Compares input buffer against static constant.",
      locations: ["0x00401020", "0x00401034"],
      evidence_id: EV_LEFT,
    },
  ],
  obligations: [
    {
      obligation_id: "OBL-CFG-01",
      category: "control-flow",
      description: "Resolve indirect jump table at 0x00401050",
      status: "open",
      evidence_ids: [EV_LEFT],
    },
  ],
  unknowns: [
    {
      unknown_id: "unk_1",
      question: "What validates the secondary signature block?",
      status: "open",
      disposition: null,
      revision: 1,
      evidence_ids: [EV_LEFT],
    },
  ],
  limitations: [],
  ...overrides,
});

describe("analysisRunComparison baseline and permutation invariance (#6338)", () => {
  it("reports identical runs as unchanged even when per-item evidence_ids differ and does not mutate inputs", () => {
    const left = makeBaseRun();
    const right = makeBaseRun({
      run_id: "run-right-1",
      evidence_id: EV_RIGHT,
      procedures: [{ ...left.procedures![0]!, evidence_id: EV_PROC_RIGHT }],
      findings: [{ ...left.findings![0]!, evidence_id: EV_RIGHT }],
      obligations: [{ ...left.obligations![0]!, evidence_ids: [EV_RIGHT] }],
      unknowns: [{ ...left.unknowns![0]!, evidence_ids: [EV_RIGHT] }],
    });
    const leftSnapshotBefore = JSON.stringify(left);
    const rightSnapshotBefore = JSON.stringify(right);

    const report = compareCompatibleAnalysisRuns(left, right);

    expect(JSON.stringify(left)).toBe(leftSnapshotBefore);
    expect(JSON.stringify(right)).toBe(rightSnapshotBefore);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.items)).toBe(true);
    expect(report.status).toBe("unchanged");
    expect(report.same_artifact_sha256).toBe(true);
    expect(report.changes).toEqual([]);
    expect(report.summary).toMatchObject({
      total_items: 4,
      unchanged: 4,
      presentation_only: 0,
      changed: 0,
      added: 0,
      removed: 0,
      unknown: 0,
    });
  });

  it("separates reordered records and presentation-only metadata from semantic changes with permutation-invariant comparison_id", () => {
    const left = makeBaseRun({
      procedures: [
        {
          address: "0x00401000",
          name: "main",
          callees: ["0x00401100", "0x00401200"],
          metadata: {
            recorded_at: "2026-10-26T08:00:00Z",
            display_label: "main_v1",
            custom_ui_hint: "collapsed",
          },
        },
        { address: "0x00402000", name: "helper", callees: [] },
      ],
      findings: [
        {
          finding_id: "F-01",
          category: "crypto",
          severity: "medium",
          confidence: "derived",
          title: "AES ECB mode",
          summary: "Block cipher without IV",
          locations: ["0x00402010", "0x00402020"],
          metadata: { timestamp: 1761465600, local_path: "/tmp/left/a.elf" },
        },
      ],
    });

    const right = makeBaseRun({
      run_id: "run-right-reordered",
      evidence_id: EV_RIGHT,
      procedures: [
        { address: "0x00402000", name: "helper", callees: [] },
        {
          address: "0x00401000",
          name: "main",
          callees: ["0x00401200", "0x00401100"],
          metadata: {
            recorded_at: "2026-10-26T09:00:00Z",
            display_label: "main_v2",
            custom_ui_hint: "expanded",
          },
        },
      ],
      findings: [
        {
          finding_id: "F-01",
          category: "crypto",
          severity: "medium",
          confidence: "derived",
          title: "AES ECB mode",
          summary: "Block cipher without IV",
          locations: ["0x00402020", "0x00402010"],
          metadata: { timestamp: 1761469200, local_path: "/tmp/right/b.elf" },
        },
      ],
    });

    const report = compareCompatibleAnalysisRuns(left, right, {
      ignore_fields: ["custom_ui_hint"],
    });
    expect(report.status).toBe("unchanged");
    expect(report.changes).toEqual([]);
    expect(report.summary.unchanged).toBe(5);
    expect(report.summary.presentation_only).toBe(2);

    const mainDelta = report.items.find(
      (item) => item.item_key === "procedure:0x00401000",
    );
    expect(mainDelta).toMatchObject({
      status: "unchanged",
      presentation_only_change: true,
      changed_fields: [],
      presentation_fields_changed: [
        "custom_ui_hint",
        "display_label",
        "recorded_at",
      ],
    });

    const rightUnpermuted = {
      ...right,
      procedures: [...right.procedures!].reverse(),
    };
    const reportUnpermuted = compareCompatibleAnalysisRuns(
      left,
      rightUnpermuted,
      { ignore_fields: ["custom_ui_hint"] },
    );
    expect(reportUnpermuted.comparison_id).toBe(report.comparison_id);
    expect(reportUnpermuted.summary).toEqual(report.summary);
  });
});

describe("analysisRunComparison semantic deltas and coverage limits (#6338)", () => {
  it("classifies added, removed, and changed items with altered semantic fields and retains source evidence links", () => {
    const left = makeBaseRun();
    const right = makeBaseRun({
      run_id: "run-right-v2",
      evidence_id: EV_RIGHT,
      subject: { sha256: SUBJECT_SHA_2, format: "elf", architecture: "x86_64" },
      procedures: [
        {
          address: "0x00401000",
          name: "main",
          signature: "int main(int argc, char **argv)",
          size_bytes: 96,
          callees: ["0x00401100", "0x00401300"],
          callers: ["0x00400f00"],
          pseudocode_sha256: "d".repeat(64),
          evidence_id: EV_PROC_RIGHT,
        },
        {
          address: "0x00401300",
          name: "verify_hmac",
          size_bytes: 48,
          evidence_id: EV_PROC_RIGHT,
        },
      ],
      findings: [
        {
          finding_id: "F-CRYPTO-002",
          category: "cryptography",
          severity: "info",
          confidence: "observed",
          title: "HMAC verification added",
          summary: "Calls verify_hmac before accepting payload.",
          locations: ["0x00401300"],
          evidence_id: EV_RIGHT,
        },
      ],
      obligations: [
        {
          obligation_id: "OBL-CFG-01",
          category: "control-flow",
          description: "Resolve indirect jump table at 0x00401050",
          status: "verified",
          evidence_ids: [EV_RIGHT],
        },
      ],
      unknowns: [
        {
          unknown_id: "unk_1",
          question: "What validates the secondary signature block?",
          status: "resolved",
          disposition: "verified",
          revision: 2,
          evidence_ids: [EV_RIGHT],
        },
      ],
    });

    const report = compareCompatibleAnalysisRuns(left, right);
    expect(report.status).toBe("changed");
    expect(report.same_artifact_sha256).toBe(false);
    expect(report.summary).toMatchObject({
      total_items: 6,
      unchanged: 0,
      changed: 3,
      added: 2,
      removed: 1,
      unknown: 0,
    });
    expect(report.summary.by_kind.obligation.improved).toBe(1);
    expect(report.summary.by_kind.residual_unknown.resolved).toBe(1);

    const changedProc = report.changes.find(
      (item) => item.item_key === "procedure:0x00401000",
    );
    expect(changedProc).toMatchObject({
      status: "changed",
      changed_fields: ["callees", "pseudocode_sha256", "size_bytes"],
      left_record_ref: {
        run_id: "run-left-1",
        evidence_id: EV_LEFT,
        record_pointer: "/procedures/0",
      },
      right_record_ref: {
        run_id: "run-right-v2",
        evidence_id: EV_RIGHT,
        record_pointer: "/procedures/0",
      },
      evidence_links: [EV_LEFT, EV_RIGHT, EV_PROC_LEFT, EV_PROC_RIGHT],
    });
  });

  it("identifies incomplete inputs and avoids treating missing results as proof that a finding disappeared", () => {
    const completeLeft = makeBaseRun();
    const incompleteRight = makeBaseRun({
      run_id: "run-right-truncated",
      evidence_id: EV_RIGHT,
      relationship_coverage: {
        status: "partial",
        truncated: true,
        omitted_count: 15,
        limitations: ["Function table scan stopped at 85%"],
        reason: "Decompiler timed out after 30 seconds",
      },
      procedures: [],
      findings: [],
      obligations: [],
      unknowns: [],
    });

    const report = compareCompatibleAnalysisRuns(completeLeft, incompleteRight);
    expect(report.status).toBe("unknown");
    expect(report.coverage_delta).toEqual({
      left_status: "complete",
      right_status: "partial",
      left_complete: true,
      right_complete: false,
      left_omitted_count: 0,
      right_omitted_count: 15,
      omitted_count_delta: 15,
      transition: "regressed",
    });

    expect(report.summary.removed).toBe(0);
    expect(report.summary.unknown).toBe(4);
    for (const item of report.changes) {
      expect(item.status).toBe("unknown");
      expect(item.conclusion_kind).toBe("unresolved_branch");
      expect(item.unknown_reason).toBe("right_run_incomplete");
    }
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "items absent from the right run are classified as unknown rather than removed",
        ),
        expect.stringContaining("Function table scan stopped at 85%"),
        expect.stringContaining("Decompiler timed out after 30 seconds"),
      ]),
    );
  });
});

describe("analysisRunComparison adversarial compatibility and prototype safety (#6338)", () => {
  it("fails closed with a clear explanation when comparing incompatible or unsupported analysis runs", () => {
    const base = makeBaseRun();

    const unsupported = checkAnalysisRunCompatibility(
      { ...base, result_type: "ad-hoc-untyped-dump" },
      base,
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.code).toBe("unsupported_result_type");
    }

    const diffResultType = compareAnalysisRuns(
      base,
      makeBaseRun({
        result_type: "function-analysis",
        operation: "analyze_function",
      }),
    );
    expect(diffResultType.ok).toBe(false);
    if (!diffResultType.ok) {
      expect(diffResultType.error.code).toBe("incompatible_result_type");
    }

    const asymmetricNullSubject = compareAnalysisRuns(
      base,
      makeBaseRun({ subject: null }),
    );
    expect(asymmetricNullSubject.ok).toBe(false);
    if (!asymmetricNullSubject.ok) {
      expect(asymmetricNullSubject.error.code).toBe(
        "incompatible_subject_format",
      );
    }

    const asymmetricNullArch = compareAnalysisRuns(
      base,
      makeBaseRun({
        subject: { sha256: SUBJECT_SHA_2, format: "elf", architecture: null },
      }),
    );
    expect(asymmetricNullArch.ok).toBe(false);
    if (!asymmetricNullArch.ok) {
      expect(asymmetricNullArch.error.code).toBe(
        "incompatible_subject_architecture",
      );
    }

    const duplicateFindingRun = makeBaseRun({
      findings: [
        base.findings![0]!,
        { ...base.findings![0]!, title: "Duplicate ID finding" },
      ],
    });
    const dupCheck = compareAnalysisRuns(duplicateFindingRun, base);
    expect(dupCheck.ok).toBe(false);
    if (!dupCheck.ok) {
      expect(dupCheck.error.code).toBe("duplicate_item_identity");
    }

    expect(() =>
      compareCompatibleAnalysisRuns(
        base,
        makeBaseRun({ operation: "inspect_elf_notes" }),
      ),
    ).toThrow(AnalysisInputError);
  });

  it("handles Object.prototype keys and Unicode NFC vs NFD strings safely", () => {
    const protoMetaLeft = JSON.parse(
      '{"__proto__":{"tag":"v1"},"constructor":"ctor-1","toString":"str-1"}',
    ) as Record<string, string | Record<string, string>>;
    const protoMetaRight = JSON.parse(
      '{"__proto__":{"tag":"v2"},"constructor":"ctor-1","toString":"str-2"}',
    ) as Record<string, string | Record<string, string>>;

    const left = makeBaseRun({
      findings: [
        {
          finding_id: "__proto__",
          category: "constructor",
          severity: "high",
          confidence: "observed",
          title: "Caf\u00e9 \uD835\uDD38 stra\u00dfe",
          summary: "Tests Object.prototype key safety",
          attributes: protoMetaLeft,
          metadata: { valueOf: "val-1" },
        },
      ],
      obligations: [
        {
          obligation_id: "constructor",
          category: "proof",
          description: "Initial obligation description",
          status: "verified",
        },
      ],
    });

    const right = makeBaseRun({
      run_id: "run-right-proto",
      evidence_id: EV_RIGHT,
      findings: [
        {
          finding_id: "__proto__",
          category: "constructor",
          severity: "high",
          confidence: "observed",
          title: "Cafe\u0301 \uD835\uDD38 strasse",
          summary: "Tests Object.prototype key safety",
          attributes: protoMetaRight,
          metadata: { valueOf: "val-1" },
        },
      ],
      obligations: [
        {
          obligation_id: "constructor",
          category: "proof",
          description: "Updated obligation description with same status",
          status: "verified",
        },
      ],
    });

    const report = compareCompatibleAnalysisRuns(left, right, {
      ignore_fields: ["toString", "valueOf"],
    });

    expect(report.status).toBe("changed");
    const protoFinding = report.changes.find(
      (item) => item.item_key === "finding:__proto__",
    );
    expect(protoFinding?.changed_fields).toEqual(["attributes", "title"]);
    expect(protoFinding?.presentation_fields_changed).toEqual(["toString"]);

    const ctorObligation = report.changes.find(
      (item) => item.item_key === "obligation:constructor",
    );
    expect(ctorObligation?.status).toBe("changed");
    expect(ctorObligation?.changed_fields).toEqual(["description"]);
    expect(report.summary.by_kind.obligation.unchanged).toBe(1);
    expect(report.summary.by_kind.obligation.regressed).toBe(0);
  });
});

describe("Run Comparison Unicode code-point order, truncation delta, and schema contradiction guards (#6338)", () => {
  it("orders astral-plane keys by Unicode code point, detects positive change under partial coverage, and rejects contradictory report totals", () => {
    const left = makeBaseRun({
      run_id: "run-astral-left",
      relationship_coverage: {
        status: "partial",
        truncated: true,
        omitted_count: 4,
        limitations: ["Indirect jump table truncated"],
      },
      findings: [
        {
          finding_id: "F-\u{10400}",
          category: "crypto",
          severity: "low",
          confidence: "observed",
          title: "Astral finding",
          summary: "Initial low severity",
          evidence_id: EV_LEFT,
        },
        {
          finding_id: "F-\uE000",
          category: "crypto",
          severity: "high",
          confidence: "observed",
          title: "BMP private-use finding",
          summary: "Stable high severity",
          evidence_id: EV_LEFT,
        },
      ],
      procedures: [],
      obligations: [],
      unknowns: [],
    });

    const right = makeBaseRun({
      run_id: "run-astral-right",
      relationship_coverage: {
        status: "partial",
        truncated: false,
        omitted_count: 4,
        limitations: [],
      },
      findings: [
        {
          finding_id: "F-\uE000",
          category: "crypto",
          severity: "high",
          confidence: "observed",
          title: "BMP private-use finding",
          summary: "Stable high severity",
          evidence_id: EV_RIGHT,
        },
        {
          finding_id: "F-\u{10400}",
          category: "crypto",
          severity: "critical",
          confidence: "observed",
          title: "Astral finding",
          summary: "Escalated to critical severity",
          evidence_id: EV_RIGHT,
        },
      ],
      procedures: [],
      obligations: [],
      unknowns: [],
    });

    const res = compareAnalysisRuns(left, right);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const report = res.value;
    expect(report.items.map((i) => i.item_key)).toEqual([
      "finding:F-\uE000",
      "finding:F-\u{10400}",
    ]);
    expect(report.summary.unknown).toBe(0);
    expect(report.summary.changed).toBe(1);
    expect(report.status).toBe("changed");
    expect(report.coverage_delta.transition).toBe("improved");

    const emptyPartialLeft = makeBaseRun({
      relationship_coverage: {
        status: "partial",
        truncated: true,
        omitted_count: 2,
      },
      procedures: [],
      findings: [],
      obligations: [],
      unknowns: [],
    });
    const emptyCompleteRight = makeBaseRun({
      procedures: [],
      findings: [],
      obligations: [],
      unknowns: [],
    });
    const emptyCmp = compareAnalysisRuns(emptyPartialLeft, emptyCompleteRight);
    expect(emptyCmp.ok).toBe(true);
    if (emptyCmp.ok) {
      expect(emptyCmp.value.status).toBe("unknown");
    }

    expect(() =>
      analysisRunComparisonReportSchema.parse({
        ...report,
        status: "unchanged",
      }),
    ).toThrow(/cannot claim status .*unchanged/i);
  });
});
