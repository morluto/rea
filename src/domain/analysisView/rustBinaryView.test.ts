import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import type { RustBinary } from "../rust/rustBinary.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
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

it("refuses inferred_crates view when uncollected and pages/filters inferred_crates when collected", () => {
  const uncollected = parent();
  const uncollectedSummary = projectAnalysisView(uncollected, {
    kind: "summary",
  });
  if (!uncollectedSummary.ok) throw uncollectedSummary.error;
  expect(uncollectedSummary.value).toMatchObject({
    source_coverage: { inferred_crates: "not-requested" },
  });
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
          revision: null,
          first_file_offset: 100,
          reference_count: 3,
        },
        {
          name: "quinn",
          version: null,
          source_kind: "git",
          registry_index: null,
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
    source_coverage: { inferred_crates: "truncated" },
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

  const gitOnly = projectAnalysisView(collected, {
    kind: "rust",
    collection: "inferred_crates",
    source_kind: "git",
    contains: "quin",
    fields: ["name", "revision"],
    offset: 0,
    limit: 10,
  });
  if (!gitOnly.ok || gitOnly.value.kind !== "rust")
    throw new Error("Expected inferred_crates page");
  expect(gitOnly.value.page).toEqual({
    collection: "inferred_crates",
    rows: [{ index: 1, name: "quinn", revision: "a1b2c3d" }],
  });
});
