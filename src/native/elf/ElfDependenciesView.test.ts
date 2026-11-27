import { expect, it } from "vitest";
import { parseElfDependenciesFromHandle } from "./ElfDependencyParser.js";
import {
  elfDependencyByteSource,
  elfDependencyFixture,
} from "./ElfDependencies.fixture.js";
import { inspectElfDependenciesInputSchema } from "../../domain/native/elfDependencies.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { projectAnalysisView } from "../../domain/analysisView/analysisView.js";
import type { AnalysisViewParent } from "../../domain/analysisView/analysisViewParent.js";
import { analysisViewRequestSchema } from "../../domain/analysisView/analysisViewRequest.js";

const input = inspectElfDependenciesInputSchema.parse({
  path: "/artifacts/program",
});

const decode = (bytes: Buffer) =>
  parseElfDependenciesFromHandle(
    elfDependencyByteSource(bytes),
    { path: input.path, sha256: "a".repeat(64), bytes: bytes.length },
    input,
    async () => {},
  );

const parent = (report: unknown): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: `ev_${"b".repeat(64)}`,
  operation: "inspect_elf_dependencies",
  normalizedResult: report,
  limitations: [],
});

const project = (report: unknown, input: unknown) => {
  const result = projectAnalysisView(
    parent(report),
    analysisViewRequestSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

const report = await decode(
  elfDependencyFixture({ needed: ["libc.so.6", "libc.so.6", "libm.so.6"] }),
);

it("pages duplicate DT_NEEDED names with original indices and selected fields", () => {
  const input = {
    kind: "elf-dependencies",
    collection: "needed",
    names: ["libc.so.6"],
    fields: ["name"],
    limit: 1,
  };
  expect(project(report, input)).toMatchObject({
    items: [{ source_index: 0, name: "libc.so.6" }],
    dependencies: { needed_count: 3, coverage: { status: "complete" } },
    coverage: { examined: 1, total: 2, next_offset: 1, exhausted: false },
  });
  expect(project(report, { ...input, offset: 1 })).toMatchObject({
    items: [{ source_index: 1, name: "libc.so.6" }],
    coverage: { total: 2, next_offset: null, exhausted: true },
  });
  expect(
    project(report, { ...input, indices: [1, 1, 99], fields: [] }),
  ).toMatchObject({ items: [{ source_index: 1 }], coverage: { total: 1 } });
  expect(project(report, { ...input, names: [] })).toMatchObject({
    items: [],
    coverage: { status: "empty", total: 0 },
  });
});

it("pages GNU version requirements independently of definition rows", () => {
  expect(
    project(report, {
      kind: "elf-dependencies",
      collection: "versions",
      names: ["GLIBC_2.34", "GLIBCXX_3.4.29"],
      fields: ["file", "name", "index"],
    }),
  ).toMatchObject({
    items: [
      {
        source_index: 1,
        file: "libc.so.6",
        name: "GLIBC_2.34",
        index: 3,
      },
      {
        source_index: 2,
        file: "libstdc++.so.6",
        name: "GLIBCXX_3.4.29",
        index: 4,
      },
    ],
    dependencies: { version_count: 3 },
    coverage: { total: 2 },
  });
});

it("keeps import library@version identity through selected fields", () => {
  expect(
    project(report, {
      kind: "elf-dependencies",
      collection: "imports",
      names: ["printf"],
      fields: ["name", "version"],
    }),
  ).toMatchObject({
    items: [
      {
        source_index: 0,
        name: "printf",
        version: {
          name: "GLIBC_2.34",
          file: "libc.so.6",
          status: "resolved",
        },
      },
    ],
  });
});

it("returns a summary without row bodies and a stable view digest", () => {
  const viewed = project(report, { kind: "summary" });
  expect(viewed).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_elf_dependencies",
    summary: {
      needed_count: 3,
      import_count: 5,
      version_count: 3,
      version_definitions: { status: "present" },
      definition_count: 1,
      derived_maximum_count: 2,
      coverage: { status: "complete" },
    },
  });
  for (const omitted of [
    "items",
    "summary.needed",
    "summary.imports",
    "summary.version_requirements",
    "summary.derived_version_maxima",
    "summary.version_definitions.names",
  ])
    expect(viewed).not.toHaveProperty(omitted);
  const { view_digest, ...content } = viewed;
  expect(view_digest).toBe(digestCanonicalValue(content, "Analysis view"));
});

it("pages version definitions and derived maxima instead of repeating them", () => {
  expect(
    project(report, {
      kind: "elf-dependencies",
      collection: "definitions",
      fields: ["name", "base"],
      limit: 1,
    }),
  ).toMatchObject({
    items: [{ source_index: 0, name: "libdemo.so.1", base: true }],
    dependencies: { definition_count: 1 },
  });
  const maxima = project(report, {
    kind: "elf-dependencies",
    collection: "maxima",
    names: ["GLIBC"],
    fields: ["maximum"],
  });
  expect(maxima).toMatchObject({
    items: [{ maximum: "GLIBC_2.34" }],
    coverage: { total: 1 },
  });
  expect(maxima).not.toHaveProperty("dependencies.derived_version_maxima");
});

it("pages issues by original index and refuses name or field selection", async () => {
  const report = await decode(
    elfDependencyFixture({
      truncateDynstr: true,
      sectionSizes: { ".dynsym": 3 * 24 + 1 },
    }),
  );
  expect(report.issues.length).toBeGreaterThan(1);
  const view = { kind: "elf-dependencies", collection: "issues" };
  expect(project(report, { ...view, indices: [1], limit: 1 })).toMatchObject({
    items: [{ ...report.issues[1], source_index: 1 }],
    coverage: { total: 1 },
  });
  for (const extra of [{ fields: ["code"] }, { names: ["name_unreadable"] }])
    expect(
      analysisViewRequestSchema.safeParse({ ...view, ...extra }).success,
    ).toBe(false);
});
