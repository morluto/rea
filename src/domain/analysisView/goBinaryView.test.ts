import { freezeOwnedJsonTreeSnapshot } from "../immutableJson.js";
import {
  changedEvidenceSubject,
  fileIdentity,
} from "../../../tests/fixtures/evidenceSubject.js";
import { expect, it } from "vitest";
import { AnalysisInputError } from "../analysisErrorCore.js";
import { createEvidence } from "../evidence.js";
import type { GoBinary } from "../go/goBinary.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

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
    if (input.subject === undefined || input.subject.identity.kind !== "file")
      throw new Error("Expected artifact subject");
    const subject = changedEvidenceSubject(
      input.subject,
      field === "digest" ? { sha256: "b".repeat(64) } : {},
    );
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
  ["amd64", null, false],
  ["future-cpu", "arm64", false],
] as const)(
  "checks report architecture %j against subject %j for every Go view",
  (architecture, subjectArchitecture, accepted) => {
    const input = parent();
    if (
      input.subject === undefined ||
      fileIdentity(input.subject).format !== "elf"
    )
      throw new Error("Expected ELF subject");
    const subject = changedEvidenceSubject(input.subject, {
      architecture: subjectArchitecture,
    });
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
  if (input.subject === undefined || input.subject.identity.kind !== "file")
    throw new Error("Expected artifact subject");
  expect(
    projectAnalysisView(
      {
        ...input,
        subject: changedEvidenceSubject(input.subject, {
          sha256: "b".repeat(64),
        }),
      },
      { kind: "summary" },
    ).ok,
  ).toBe(false);
});

it.each(["dependencies", "settings"] as const)(
  "reports decoded empty Go %s as fully examined",
  (collection) => {
    const result = projectAnalysisView(
      {
        ...parent(),
        normalizedResult: {
          ...report,
          build_info: {
            header_offset: 0,
            encoding: "inline",
            go_version: null,
            go_version_bytes_base64: "",
            module_text: null,
            module_bytes_base64: "",
            version_location: { offset: 32, bytes: 0 },
            module_location: { offset: 32, bytes: 0 },
            module: {
              path: null,
              main: null,
              dependencies: [],
              settings: [],
              unparsed_lines: [],
              unparsed_line_bytes_base64: [],
              complete: true,
            },
          },
        },
      },
      { kind: "go", collection, offset: 3, limit: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      page: { collection, rows: [] },
      source_coverage: { build_info_available: true },
    });
    expect(result.value.coverage).toEqual({
      status: "empty",
      examined: 0,
      total: 0,
      next_offset: null,
      exhausted: true,
    });
  },
);

const indexedNames = ["keep-0", "drop-1", "keep-2", "keep-3", "keep-4"];
const indexedReport: GoBinary = {
  ...report,
  build_info: {
    header_offset: 0,
    encoding: "inline",
    go_version: null,
    go_version_bytes_base64: "",
    module_text: null,
    module_bytes_base64: "",
    version_location: { offset: 32, bytes: 0 },
    module_location: { offset: 32, bytes: 0 },
    module: {
      path: null,
      main: null,
      dependencies: indexedNames.map((path) => ({
        path,
        version: "v1.0.0",
        sum: null,
        replacement: null,
      })),
      settings: indexedNames.map((key) => ({ key, value: "value" })),
      unparsed_lines: [],
      unparsed_line_bytes_base64: [],
      complete: true,
    },
  },
  string_literals: {
    evidence_kind: "inferred",
    items: indexedNames.map((value, index) => ({
      value,
      location: { offset: 256 + index * 16, bytes: Buffer.byteLength(value) },
      first_header_offset: 64 + index * 16,
      reference_count: 1,
    })),
    discovered_count: indexedNames.length,
    aggregate_bytes: Buffer.byteLength(indexedNames.join("")),
    max_items: indexedNames.length,
    truncated: false,
  },
};

const selectedNames = indexedNames.filter((name) => name.startsWith("keep-"));
it.each([
  { collection: "dependencies", paths: selectedNames },
  { collection: "settings", keys: selectedNames },
  { collection: "string_literals", contains: "keep-" },
] as const)("pages filtered $collection indices in source order", (filter) => {
  const result = projectAnalysisView(
    { ...parent(), normalizedResult: indexedReport },
    {
      kind: "go",
      indices: [3, 90, 0, 2, 1, 3],
      offset: 1,
      limit: 1,
      ...filter,
    },
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    page: {
      collection: filter.collection,
      rows: [{ index: 2 }],
    },
    coverage: {
      status: "page",
      examined: 1,
      total: 3,
      next_offset: 2,
      exhausted: false,
    },
  });
});
