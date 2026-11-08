import { freezeOwnedJsonTreeSnapshot } from "../immutableJson.js";
import { expect, it } from "vitest";
import { AnalysisInputError } from "../analysisErrorCore.js";
import { createEvidence } from "../evidence.js";
import type { GoBinary } from "../go/goBinary.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const report: GoBinary = {
  artifact: { path: "/artifacts/program", sha256: "a".repeat(64), bytes: 512 },
  format: "elf",
  architecture: "amd64",
  bits: 64,
  byte_order: "little",
  build_info: null,
  limitations: [],
};
const parent = (): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "elf",
      architecture: "x86_64",
    },
    {
      id: "go-build-info",
      name: "REA Go build-information reader",
      version: "1",
    },
    {
      operation: "inspect_go_binary",
      parameters: { path: report.artifact.path },
      result: report,
      confidence: "observed",
    },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    subject: evidence.subject,
    normalizedResult: structuredClone(report),
    limitations: [],
  };
};

it("validates mutable inline reports again after an earlier successful view", () => {
  const mutable = structuredClone(report);
  const input = { ...parent(), normalizedResult: mutable };
  expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(true);
  mutable.artifact.bytes = -1;
  expect(
    projectAnalysisView({ ...input, sealedResult: true }, { kind: "summary" })
      .ok,
  ).toBe(false);
});

it("bounds inherited messages while keeping their complete parent reference", () => {
  const note = "Large source note: " + "x".repeat(300_000);
  const input = {
    ...parent(),
    limitations: [note],
  };
  const result = projectAnalysisView(input, { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value.limitations.join(" ")).toContain(input.evidenceId);
  expect(result.value.limitations.join(" ")).toContain("omitted");
  expect(result.value.unknowns.join(" ")).toContain("runtime dependencies");
  expect(input.limitations[0]).toBe(note);
});

it.each(["digest", "format"] as const)(
  "rejects a Go parent whose authenticated %s conflicts with its report",
  (field) => {
    const input = parent();
    if (input.subject == null) throw new Error("Expected artifact subject");
    const subject = {
      ...input.subject,
      ...(field === "digest" ? { digest: { sha256: "b".repeat(64) } } : {}),
    };
    const result = projectAnalysisView(
      {
        ...input,
        subject,
        ...(field === "format"
          ? { normalizedResult: { ...report, format: "pe" } }
          : {}),
      },
      { kind: "summary" },
    );
    expect(result.ok).toBe(false);
  },
);

it.each([
  ["386", "x86", true],
  ["x86", "x86", true],
  ["amd64", "x86_64", true],
  ["x86_64", "x86_64", true],
  ["arm64", "arm64", true],
  ["future-cpu", null, true],
  ["", null, true],
  ["amd64", "arm64", false],
  ["amd64", null, false],
  ["future-cpu", "arm64", false],
] as const)(
  "checks report architecture %j against subject %j for every Go view",
  (architecture, subjectArchitecture, accepted) => {
    const input = parent();
    if (input.subject?.format !== "elf")
      throw new Error("Expected ELF subject");
    const subject = {
      ...input.subject,
      architecture: subjectArchitecture,
    };
    const normalizedResult = { ...report, architecture };
    for (const view of [
      { kind: "summary" },
      { kind: "go", collection: "dependencies", offset: 0, limit: 64 },
    ] as const) {
      const result = projectAnalysisView(
        { ...input, subject, normalizedResult },
        view,
      );
      expect(result.ok).toBe(accepted);
      if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
    }
  },
);

it("revalidates the parent subject after immutable Go report facts have been cached", () => {
  const input = {
    ...parent(),
    normalizedResult: freezeOwnedJsonTreeSnapshot(structuredClone(report)),
    sealedResult: true,
  };
  expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(true);
  if (input.subject == null) throw new Error("Expected artifact subject");
  expect(
    projectAnalysisView(
      {
        ...input,
        subject: { ...input.subject, digest: { sha256: "b".repeat(64) } },
      },
      { kind: "summary" },
    ).ok,
  ).toBe(false);
});

it("refuses string_literals view when unrequested and projects filtered/truncated string_literals when present", () => {
  const unrequested = projectAnalysisView(parent(), {
    kind: "go",
    collection: "string_literals",
    offset: 0,
    limit: 64,
  });
  expect(unrequested.ok).toBe(false);
  if (!unrequested.ok) {
    expect(unrequested.error).toBeInstanceOf(AnalysisInputError);
    if (unrequested.error instanceof AnalysisInputError)
      expect(unrequested.error.issues[0]?.path).toEqual(["view", "collection"]);
  }

  const withStrings: GoBinary = {
    ...report,
    string_literals: {
      evidence_kind: "inferred",
      discovered_count: 5,
      aggregate_bytes: 52,
      max_items: 3,
      truncated: true,
      items: [
        {
          value: "ListResourceProviders",
          location: { offset: 128, bytes: 21 },
          first_header_offset: 300,
          reference_count: 1,
        },
        {
          value: "genai",
          location: { offset: 149, bytes: 5 },
          first_header_offset: 316,
          reference_count: 2,
        },
        {
          value: "https://example.invalid/v1",
          location: { offset: 154, bytes: 26 },
          first_header_offset: 332,
          reference_count: 1,
        },
      ],
    },
  };
  const stringParent = { ...parent(), normalizedResult: withStrings };
  const summary = projectAnalysisView(stringParent, { kind: "summary" });
  expect(summary.ok).toBe(true);
  if (
    !summary.ok ||
    summary.value.kind !== "summary" ||
    summary.value.parent_operation !== "inspect_go_binary"
  )
    throw new Error("Expected Go summary view");
  expect(summary.value.source_coverage.string_literals).toBe("truncated");
  expect(summary.value.summary).toMatchObject({
    string_literals: {
      evidence_kind: "inferred",
      available_count: 3,
      discovered_count: 5,
      aggregate_bytes: 52,
      max_items: 3,
      truncated: true,
    },
  });
  expect(summary.value.unknowns.join(" ")).toContain("truncated");

  const filtered = projectAnalysisView(stringParent, {
    kind: "go",
    collection: "string_literals",
    contains: "example.invalid",
    fields: ["value", "reference_count"],
    offset: 0,
    limit: 10,
  });
  expect(filtered.ok).toBe(true);
  if (!filtered.ok || filtered.value.kind !== "go")
    throw new Error("Expected Go string_literals page");
  expect(filtered.value.page).toEqual({
    collection: "string_literals",
    rows: [
      {
        index: 2,
        value: "https://example.invalid/v1",
        reference_count: 1,
      },
    ],
  });
});
