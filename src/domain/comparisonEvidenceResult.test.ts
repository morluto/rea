import { describe, expect, it } from "vitest";

import { readComparisonResult } from "./comparisonEvidenceResult.js";
import type { Evidence } from "./evidence.js";
import {
  functionComparisonDimensionNameSchema,
  functionComparisonResultSchema,
  NORMALIZED_VIEW_DIMENSIONS,
} from "./functionComparisonSchemas.js";

const source = `ev_${"a".repeat(64)}`;
const hash = "b".repeat(64);
const other = "c".repeat(64);

const evidence = (
  result: unknown,
  links: readonly string[] = [source],
): Evidence =>
  ({
    evidence_id: `ev_${"d".repeat(64)}`,
    evidence_links: links,
    parameters: {
      left_evidence_id: source,
      right_evidence_id: source,
      ...(typeof result === "object" &&
      result !== null &&
      "normalized_views" in result
        ? { include_normalized_views: true }
        : {}),
    },
    normalized_result: result,
  }) as unknown as Evidence;

const baseline = () => ({
  status: "unchanged" as const,
  function_match: {
    status: "matched" as const,
    method: "same-evidence" as const,
    left_name: "main",
    right_name: "main",
  },
  left_subject_sha256: hash,
  right_subject_sha256: hash,
  summary: { unchanged: 8, changed: 0, unknown: 0 },
  dimensions: functionComparisonDimensionNameSchema.options.map(
    (dimension) => ({
      dimension,
      left_count: 1,
      right_count: 1,
      evidence_links: [source, source],
      limitations: [],
      status: "unchanged" as const,
      left_digest: hash,
      right_digest: hash,
      text_delta: null,
      conclusion_kind: "derived_relationship" as const,
    }),
  ),
  changes: [],
  limitations: [],
});

describe("same-evidence comparison admission", () => {
  it("accepts a consistent complete comparison", () => {
    const result = baseline();
    expect(functionComparisonResultSchema.safeParse(result).success).toBe(true);
    expect(readComparisonResult(evidence(result), "compare_functions").ok).toBe(
      true,
    );
  });

  it("rejects a changed dimension for one source", () => {
    const result = baseline();
    const changed = {
      ...result.dimensions[0]!,
      status: "changed" as const,
      right_digest: other,
    };
    const candidate = {
      ...result,
      status: "changed" as const,
      summary: { unchanged: 7, changed: 1, unknown: 0 },
      dimensions: [changed, ...result.dimensions.slice(1)],
      changes: [changed],
    };
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });

  it("rejects unequal subject hashes for one source", () => {
    const candidate = { ...baseline(), right_subject_sha256: other };
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });

  it("rejects unequal unchanged digests for one source", () => {
    const result = baseline();
    const candidate = {
      ...result,
      dimensions: [
        { ...result.dimensions[0]!, right_digest: other },
        ...result.dimensions.slice(1),
      ],
    };
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });
});

const counts = {
  address_derived_identifiers: 1,
  unmasked_address_derived_identifiers: 0,
  corroborated_addresses: 1,
  visible_addresses: 0,
};
const view = (
  dimension: (typeof NORMALIZED_VIEW_DIMENSIONS)[number],
  links: readonly string[] = [source, source],
) => ({
  dimension,
  status: "unchanged" as const,
  left_digest: hash,
  right_digest: hash,
  left_count: 1,
  right_count: 1,
  text_delta: { added_lines: 0, removed_lines: 0, hunks: 0 },
  evidence_links: links,
  masking: {
    policy: "rea-address-normalized-text-v1" as const,
    provider_id: "ghidra",
    rules: [{ rule: "entry", description: "Entry address" }],
    left: counts,
    right: counts,
  },
  limitations: [],
  conclusion_kind: "derived_relationship" as const,
});
const withViews = (views: readonly unknown[]) => ({
  ...baseline(),
  normalized_views: {
    policy: "rea-address-normalized-text-v1" as const,
    views,
    limitations: [],
  },
});
const pseudocode = () => view("pseudocode_normalized");
const assembly = () => view("assembly_normalized");

describe("same-evidence comparison admission with normalized views", () => {
  it("accepts unchanged views of the same source", () => {
    const candidate = withViews([pseudocode(), assembly()]);
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(true);
  });

  it("rejects a changed view for one source", () => {
    const candidate = withViews([
      {
        ...pseudocode(),
        status: "changed" as const,
        right_digest: other,
        text_delta: { added_lines: 1, removed_lines: 1, hunks: 1 },
      },
      assembly(),
    ]);
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });

  it.each(["true", null, 1])(
    "rejects a non-boolean include_normalized_views selection (%j)",
    (selection) => {
      const recorded = {
        ...evidence(baseline()),
        parameters: {
          left_evidence_id: source,
          right_evidence_id: source,
          include_normalized_views: selection,
        },
      } as unknown as Evidence;
      expect(readComparisonResult(recorded, "compare_functions").ok).toBe(
        false,
      );
    },
  );

  it("accepts views when the sources are recorded as lists", () => {
    const candidate = withViews([pseudocode(), assembly()]);
    const listed = {
      ...evidence(candidate),
      parameters: {
        left_evidence_ids: [source],
        right_evidence_ids: [source],
        include_normalized_views: true,
      },
    } as unknown as Evidence;
    expect(readComparisonResult(listed, "compare_functions").ok).toBe(true);
  });

  it("rejects an unknown view whose projected facts differ for one source", () => {
    const candidate = withViews([
      {
        ...pseudocode(),
        status: "unknown" as const,
        right_digest: other,
        text_delta: null,
        conclusion_kind: "unresolved_branch" as const,
      },
      assembly(),
    ]);
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });

  it("rejects a view that cites another closure member", () => {
    const member = `ev_${"e".repeat(64)}`;
    const candidate = withViews([
      view("pseudocode_normalized", [source, source, member]),
      assembly(),
    ]);
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(
        evidence(candidate, [source, member]),
        "compare_functions",
      ).ok,
    ).toBe(false);
  });
});

describe("recorded named-symbol allowance", () => {
  it.each([
    { allowance: 0, views: true },
    { allowance: 1.5, views: true },
    { allowance: "16", views: true },
    { allowance: 2 ** 53, views: true },
    { allowance: 16, views: false },
  ])(
    "rejects a recorded max_named_symbol_code_units of $allowance (views $views)",
    ({ allowance, views }) => {
      const candidate = views
        ? withViews([pseudocode(), assembly()])
        : baseline();
      const recorded = {
        ...evidence(candidate),
        parameters: {
          ...evidence(candidate).parameters,
          max_named_symbol_code_units: allowance,
        },
      } as unknown as Evidence;
      const read = readComparisonResult(recorded, "compare_functions");
      expect(read.ok ? undefined : read.error.message).toMatch(
        /max_named_symbol_code_units/u,
      );
    },
  );

  it("accepts a recorded max_named_symbol_code_units with its views", () => {
    const candidate = withViews([pseudocode(), assembly()]);
    const recorded = {
      ...evidence(candidate),
      parameters: {
        ...evidence(candidate).parameters,
        max_named_symbol_code_units: 16,
      },
    } as unknown as Evidence;
    expect(readComparisonResult(recorded, "compare_functions").ok).toBe(true);
  });
});

it("locates a comparison payload failure within its Evidence record", () => {
  const parsed = readComparisonResult(
    evidence({ ...baseline(), status: "changed" }),
    "compare_functions",
  );
  if (parsed.ok) throw new Error("Expected a status contradiction");
  expect(parsed.error.issuePath).toEqual(["normalized_result", "status"]);
});
