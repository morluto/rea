import { freezeOwnedJsonTreeSnapshot } from "../immutableJson.js";
import { expect, it } from "vitest";
import {
  changedEvidenceSubject,
  fileIdentity,
} from "../../../tests/fixtures/evidenceSubject.js";
import { metadataReportSubjectFormat } from "../apple/machoTargetSelection.js";
import { binaryMetadataArchitecture } from "../binaryMetadataArchitecture.js";
import { createEvidence } from "../evidence.js";
import type { RustBinary } from "../rust/rustBinary.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

const report: RustBinary = {
  artifact: { path: "/artifacts/rust", sha256: "a".repeat(64), bytes: 512 },
  format: "elf",
  architecture: "amd64",
  bits: 64,
  byte_order: "little",
  auditable_metadata: {
    section_name: ".dep-v0",
    file_offset: 32,
    section_bytes: 64,
    compressed_bytes: 64,
    uncompressed_bytes: 128,
    format_version: null,
    packages: [
      {
        name: "root",
        version: "1",
        source: "local",
        kind: null,
        root: true,
        dependencies: [0],
        features: [],
      },
    ],
    root_package_index: 0,
    dependency_edges: [{ from_index: 0, to_index: 0 }],
    cyclic_dependency_indices: [0],
  },
  rustc_commit: null,
  limitations: [],
};
const parent = (value = structuredClone(report)): AnalysisViewParent => {
  const architecture = binaryMetadataArchitecture(value.architecture);
  const evidence = createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: metadataReportSubjectFormat(value),
      ...(architecture === undefined ? {} : { architecture }),
    },
    { id: "rust-auditable", name: "Rust reader", version: "1" },
    {
      operation: "inspect_rust_binary",
      parameters: { path: value.artifact.path },
      result: value,
    },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    subject: evidence.subject,
    normalizedResult: value,
    limitations: [],
  };
};

it("revalidates mutable and merely frozen Rust imports despite a claimed seal", () => {
  const mutable = structuredClone(report);
  const input = { ...parent(mutable), sealedResult: true };
  expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(true);
  Object.freeze(mutable);
  mutable.auditable_metadata!.dependency_edges[0]!.to_index = 99;
  expect(
    projectAnalysisView(input, {
      kind: "rust",
      collection: "edges",
      offset: 0,
      limit: 1,
    }).ok,
  ).toBe(false);
});

it("checks exact artifact identity and subject architecture for every Rust view", () => {
  for (const changed of [
    { format: "pe" as const },
    { architecture: "arm64" as const },
    { sha256: "b".repeat(64) },
  ]) {
    const source = parent();
    if (
      source.subject === undefined ||
      fileIdentity(source.subject).format !== "elf"
    )
      throw new Error("Missing ELF source");
    const input = {
      ...source,
      subject: changedEvidenceSubject(source.subject, changed),
    };
    expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(false);
    expect(
      projectAnalysisView(input, {
        kind: "rust",
        collection: "packages",
        offset: 0,
        limit: 1,
      }).ok,
    ).toBe(false);
  }
});

const withSectionName = (
  value: RustBinary,
  section_name: NonNullable<RustBinary["auditable_metadata"]>["section_name"],
): RustBinary => ({
  ...value,
  auditable_metadata:
    value.auditable_metadata === null
      ? null
      : { ...value.auditable_metadata, section_name },
});

it("refuses imported reports whose container facts contradict their format", () => {
  const wasm: RustBinary = {
    ...structuredClone(report),
    format: "wasm",
    architecture: "wasm",
    bits: null,
    byte_order: "little",
  };
  const accepted = projectAnalysisView(parent(wasm), { kind: "summary" });
  if (!accepted.ok || accepted.value.kind !== "summary")
    throw new Error("WebAssembly summary failed");
  expect(accepted.value.summary).toMatchObject({
    format: "wasm",
    architecture: "wasm",
    bits: null,
    byte_order: "little",
  });
  for (const value of [
    { ...wasm, architecture: "x86_64" },
    { ...wasm, byte_order: "big" as const },
    { ...wasm, bits: 32 as const },
    { ...structuredClone(report), architecture: "wasm" },
    withSectionName(wasm, "__DATA,.dep-v0"),
    withSectionName(structuredClone(report), "__DATA,.dep-v0"),
  ])
    expect(projectAnalysisView(parent(value), { kind: "summary" }).ok).toBe(
      false,
    );
});

it("bounds inherited warnings and retains cycle counts without walking a cyclic graph", () => {
  const input = { ...parent(), limitations: ["x".repeat(300_000)] };
  const result = projectAnalysisView(input, { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: {
      format: "elf",
      bits: 64,
      auditable_metadata: {
        format_version: null,
        counts: { packages: 1, edges: 1, cyclic_packages: 1 },
      },
    },
    source_coverage: {
      embedded_records: "complete",
      runtime_dependencies: "unknown",
    },
  });
  expect(JSON.stringify(result.value).length).toBeLessThan(5000);
  expect(result.value.limitations.join(" ")).toContain(input.evidenceId);
});

it("pages matching original indices and omits dependency vectors unless selected", () => {
  const value = structuredClone(report);
  value.auditable_metadata!.packages.push({
    name: "other",
    version: "1",
    source: "local",
    kind: null,
    root: false,
    dependencies: [],
    features: [],
  });
  const source = {
    ...parent(value),
    normalizedResult: freezeOwnedJsonTreeSnapshot(value),
    sealedResult: true,
  };
  const first = projectAnalysisView(source, {
    kind: "rust",
    collection: "packages",
    offset: 0,
    limit: 1,
  });
  if (!first.ok || first.value.kind !== "rust")
    throw new Error("Rust page failed");
  expect(first.value.page.rows).toEqual([
    {
      index: 0,
      name: "root",
      version: "1",
      source: "local",
      kind: null,
      root: true,
    },
  ]);
  expect(first.value.coverage).toMatchObject({
    total: 2,
    examined: 1,
    exhausted: false,
    next_offset: 1,
  });
  const next = projectAnalysisView(source, {
    kind: "rust",
    collection: "packages",
    offset: 1,
    limit: 1,
    fields: [],
  });
  if (!next.ok || next.value.kind !== "rust")
    throw new Error("Rust continuation failed");
  expect(next.value.page.rows).toEqual([{ index: 1 }]);
  expect(next.value.coverage).toMatchObject({
    total: 2,
    examined: 1,
    exhausted: true,
    next_offset: null,
  });
  const edges = {
    kind: "rust",
    collection: "edges",
    offset: 0,
    limit: 1,
  } as const;
  expect(projectAnalysisView(source, edges)).toMatchObject({
    ok: true,
    value: {
      page: {
        collection: "edges",
        rows: [{ index: 0, from_index: 0, to_index: 0 }],
      },
      coverage: { total: 1, exhausted: true },
    },
  });
  for (const selection of [{ from_indices: [] }, { to_indices: [1] }])
    expect(
      projectAnalysisView(source, { ...edges, ...selection }),
    ).toMatchObject({
      ok: true,
      value: {
        page: { collection: "edges", rows: [] },
        coverage: { total: 0 },
      },
    });
  expect(
    projectAnalysisView(source, {
      kind: "rust",
      collection: "packages",
      offset: 0,
      limit: 1,
      versions: [],
    }),
  ).toMatchObject({
    ok: true,
    value: {
      page: { collection: "packages", rows: [] },
      coverage: { total: 0 },
    },
  });
});

it("refuses inferred_crates view when uncollected and pages/filters inferred_crates when collected", () => {
  const uncollected = parent();
  const uncollectedSummary = projectAnalysisView(uncollected, {
    kind: "summary",
  });
  if (!uncollectedSummary.ok) throw uncollectedSummary.error;
  expect(uncollectedSummary.value).toMatchObject({
    kind: "summary",
    source_coverage: { inferred_crates: "not-requested" },
  });
  expect(uncollectedSummary.value).not.toHaveProperty(
    "summary.inferred_crates",
  );
  expect(uncollectedSummary.value).not.toHaveProperty("summary.rustc_versions");
  const refused = projectAnalysisView(uncollected, {
    kind: "rust",
    collection: "inferred_crates",
    offset: 0,
    limit: 10,
  });
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(JSON.stringify(refused.error)).toContain(
      "include_inferred_crates: true",
    );
  }

  const withCrates: RustBinary = {
    ...structuredClone(report),
    inferred_crates: {
      evidence_kind: "inferred",
      items: [
        {
          name: "tokio-util",
          version: "0.7.13",
          source_kind: "registry",
          registry_index: "index.crates.io-6f17d22bba15001f",
          checkout_id: null,
          revision: null,
          first_file_offset: 100,
          reference_count: 3,
        },
        {
          name: "quinn",
          version: null,
          source_kind: "git",
          registry_index: null,
          checkout_id: "0123456789abcdef",
          revision: "a1b2c3d",
          first_file_offset: 220,
          reference_count: 1,
        },
      ],
      discovered_count: 3,
      max_items: 2,
      truncated: true,
    },
    rustc_versions: {
      evidence_kind: "inferred",
      items: [
        {
          banner: "rustc 1.85.0 (4d91de4e4 2025-02-17)",
          version: "1.85.0",
          channel: "stable",
          commit_hash: "4d91de4e4",
          commit_date: "2025-02-17",
          first_file_offset: 320,
          reference_count: 2,
        },
      ],
      discovered_count: 1,
      truncated: false,
    },
  };
  const collected = parent(withCrates);
  const summary = projectAnalysisView(collected, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value).toMatchObject({
    source_coverage: { inferred_crates: "partial" },
    summary: {
      inferred_crates: {
        evidence_kind: "inferred",
        available_count: 2,
        discovered_count: 3,
        registry_count: 1,
        git_count: 1,
        max_items: 2,
        truncated: true,
      },
      rustc_versions: {
        evidence_kind: "inferred",
        available_count: 1,
        discovered_count: 1,
        truncated: false,
      },
    },
  });

  const complete = structuredClone(withCrates);
  complete.inferred_crates!.discovered_count = 2;
  complete.inferred_crates!.truncated = false;
  const completeSummary = projectAnalysisView(parent(complete), {
    kind: "summary",
  });
  if (!completeSummary.ok) throw completeSummary.error;
  expect(completeSummary.value).toMatchObject({
    source_coverage: { inferred_crates: "complete" },
    summary: { inferred_crates: { truncated: false } },
  });

  const gitOnly = projectAnalysisView(collected, {
    kind: "rust",
    collection: "inferred_crates",
    source_kind: "git",
    contains: "quin",
    fields: ["name", "checkout_id", "revision"],
    offset: 0,
    limit: 10,
  });
  if (!gitOnly.ok || gitOnly.value.kind !== "rust")
    throw new Error("Expected inferred_crates page");
  expect(gitOnly.value.page).toEqual({
    collection: "inferred_crates",
    rows: [
      {
        index: 1,
        name: "quinn",
        checkout_id: "0123456789abcdef",
        revision: "a1b2c3d",
      },
    ],
  });

  for (const { selection, offset, rows, total } of [
    {
      selection: {},
      offset: 1,
      rows: [{ index: 1, name: "quinn" }],
      total: 2,
    },
    {
      selection: { indices: [1, 90, 0, 1] },
      offset: 1,
      rows: [{ index: 1, name: "quinn" }],
      total: 2,
    },
    {
      selection: {
        indices: [1, 90, 0, 1],
        name: "quinn",
        names: ["quinn"],
        contains: "quin",
        source_kind: "git" as const,
      },
      offset: 0,
      rows: [{ index: 1, name: "quinn" }],
      total: 1,
    },
    { selection: { indices: [] }, offset: 0, rows: [], total: 0 },
    { selection: { names: [] }, offset: 0, rows: [], total: 0 },
    {
      selection: { name: "quinn", source_kind: "registry" as const },
      offset: 0,
      rows: [],
      total: 0,
    },
  ]) {
    const page = projectAnalysisView(collected, {
      kind: "rust",
      collection: "inferred_crates",
      fields: ["name"],
      ...selection,
      offset,
      limit: 1,
    });
    if (!page.ok) throw page.error;
    expect(page.value).toMatchObject({
      page: { collection: "inferred_crates", rows },
      source_coverage: { inferred_crates: "partial" },
      coverage: {
        total,
        examined: rows.length,
        next_offset: null,
        exhausted: true,
      },
    });
  }
});

it.each(["packages", "edges"] as const)(
  "reports decoded empty Rust %s as fully examined",
  (collection) => {
    const result = projectAnalysisView(
      parent({
        ...report,
        auditable_metadata: {
          ...report.auditable_metadata!,
          packages: [],
          root_package_index: null,
          dependency_edges: [],
          cyclic_dependency_indices: [],
        },
      }),
      { kind: "rust", collection, offset: 3, limit: 1 },
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      page: { collection, rows: [] },
      source_coverage: { embedded_records: "complete" },
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
