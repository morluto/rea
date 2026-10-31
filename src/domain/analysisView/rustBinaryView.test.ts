import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import type { RustBinary } from "../rust/rustBinary.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
  type AnalysisViewRequest,
} from "./analysisView.js";

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
  const evidence = createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: "elf",
      architecture: "x86_64",
    },
    { id: "rust-auditable", name: "Rust reader", version: "1" },
    {
      operation: "inspect_rust_binary",
      parameters: { path: value.artifact.path },
      result: value,
    },
  );
  return {
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

it.each([false, true])(
  "pages historical Rust feature omissions with a sealed source: %s",
  (sealed) => {
    const previous = structuredClone(report);
    const metadata = previous.auditable_metadata;
    if (metadata === null) throw new Error("Expected Rust metadata");
    const legacy = {
      ...previous,
      auditable_metadata: {
        ...metadata,
        packages: metadata.packages.map(
          ({ features: _features, ...pkg }) => pkg,
        ),
      },
    } as unknown as RustBinary;
    if (sealed) freezeJsonSnapshot(legacy);
    const input = { ...parent(legacy), sealedResult: sealed };
    const result = projectAnalysisView(input, {
      kind: "rust",
      collection: "packages",
      fields: ["features"],
      offset: 0,
      limit: 10,
    });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      page: { rows: [{ index: 0, features: null }] },
    });
  },
);

it("checks exact artifact identity and subject architecture for every Rust view", () => {
  for (const changed of [
    { format: "pe" as const },
    { architecture: "arm64" as const },
    { digest: { sha256: "b".repeat(64) } },
  ]) {
    const source = parent();
    if (source.subject == null || source.subject.format !== "elf")
      throw new Error("Missing ELF source");
    const input = { ...source, subject: { ...source.subject, ...changed } };
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

it("bounds inherited warnings and retains cycle counts without walking a cyclic graph", () => {
  const input = { ...parent(), limitations: ["x".repeat(300_000)] };
  const result = projectAnalysisView(input, { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: {
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
  expect(value.auditable_metadata?.packages[0]?.features).toEqual([]);
  value.auditable_metadata!.packages.push({
    name: "other",
    version: "1",
    source: "local",
    kind: null,
    root: false,
    dependencies: [],
    features: [],
  });
  const source = parent(value);
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
});

it("filters packages by name, version, and indices, projecting requested dependencies", () => {
  const value = structuredClone(report);
  value.auditable_metadata!.packages.push(
    {
      name: "serde",
      version: "1.0.100",
      source: "crates.io",
      kind: null,
      root: false,
      dependencies: [],
      features: ["derive"],
    },
    {
      name: "serde",
      version: "2.0.0",
      source: "crates.io",
      kind: null,
      root: false,
      dependencies: [],
      features: [],
    },
  );
  const source = parent(value);
  const filtered = projectAnalysisView(source, {
    kind: "rust",
    collection: "packages",
    offset: 0,
    limit: 10,
    names: ["serde"],
    versions: ["1.0.100"],
    fields: ["name", "version", "dependencies"],
  });
  if (!filtered.ok || filtered.value.kind !== "rust")
    throw new Error("Rust package filter failed");
  expect(filtered.value.page.rows).toEqual([
    {
      index: 1,
      name: "serde",
      version: "1.0.100",
      dependencies: [],
    },
  ]);
  expect(filtered.value.coverage.total).toBe(1);
});

it("filters dependency edges by from_indices, to_indices, and indices", () => {
  const value = structuredClone(report);
  value.auditable_metadata!.packages = [
    {
      name: "root",
      version: "1",
      source: "local",
      kind: null,
      root: true,
      dependencies: [1, 2],
      features: [],
    },
    {
      name: "a",
      version: "1",
      source: "local",
      kind: null,
      root: false,
      dependencies: [2],
      features: [],
    },
    {
      name: "b",
      version: "1",
      source: "local",
      kind: null,
      root: false,
      dependencies: [],
      features: [],
    },
  ];
  value.auditable_metadata!.dependency_edges = [
    { from_index: 0, to_index: 1 },
    { from_index: 0, to_index: 2 },
    { from_index: 1, to_index: 2 },
  ];
  value.auditable_metadata!.cyclic_dependency_indices = [];
  const source = parent(value);
  const filtered = projectAnalysisView(source, {
    kind: "rust",
    collection: "edges",
    offset: 0,
    limit: 10,
    from_indices: [0],
    to_indices: [2],
    fields: ["to_index"],
  });
  if (!filtered.ok || filtered.value.kind !== "rust")
    throw new Error("Rust edge filter failed");
  expect(filtered.value.page.rows).toEqual([
    {
      index: 1,
      to_index: 2,
    },
  ]);
  expect(filtered.value.coverage.total).toBe(1);
});

it("handles null auditable metadata and projects compiler commit hashes count", () => {
  const value: RustBinary = {
    ...report,
    auditable_metadata: null,
    rustc_commit: {
      evidence_kind: "inferred",
      hashes: [
        { hash: "1".repeat(40), file_offset: 0 },
        { hash: "2".repeat(40), file_offset: 48 },
      ],
    },
  };
  const source = parent(value);
  const summary = projectAnalysisView(source, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value).toMatchObject({
    summary: {
      auditable_metadata: null,
      rustc_commit: {
        evidence_kind: "inferred",
        hashes_count: 2,
      },
    },
    source_coverage: {
      auditable_metadata_available: false,
      embedded_records: "unknown",
      runtime_dependencies: "unknown",
    },
  });
  expect(summary.value.unknowns).toEqual(
    expect.arrayContaining([
      expect.stringContaining("No cargo-auditable metadata was observed"),
    ]),
  );

  const emptyPackages = projectAnalysisView(source, {
    kind: "rust",
    collection: "packages",
    offset: 0,
    limit: 10,
  });
  if (!emptyPackages.ok || emptyPackages.value.kind !== "rust")
    throw new Error("Rust packages on null metadata failed");
  expect(emptyPackages.value.page.rows).toEqual([]);
  expect(emptyPackages.value.coverage.total).toBe(0);
});

it("rejects unsupported view kinds with an input error", () => {
  const source = parent();
  const invalid = projectAnalysisView(source, {
    kind: "cve",
  } as unknown as AnalysisViewRequest);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) {
    expect(invalid.error).toMatchObject({
      operation: "inspect_analysis_view",
      issues: [{ path: ["view"], reason: "invalid_value" }],
    });
  }
});
