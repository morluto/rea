import { expect, it } from "vitest";
import { freezeJsonSnapshot } from "../immutableJson.js";
import {
  analysisViewRequestSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const artifact = {
  path: "/artifacts/Example.1.0.0.nupkg",
  sha256: "0".repeat(64),
  bytes: 4096,
};

const nuspec = (path: string, id: string) => ({
  nuspec_id: `nuspec_${"1".repeat(64)}`,
  path,
  bytes: 256,
  id,
  version: "1.0.0",
  authors: "Example",
  description: "An example package.",
  license: { kind: "expression" as const, value: "MIT" },
  license_url: null,
  project_url: null,
  repository: null,
  dependency_groups: [
    {
      target_framework: "net8.0",
      dependencies: [
        {
          name: "Newtonsoft.Json",
          version_range: "[13.0.0,14.0.0)",
          exclude: null,
          include: null,
        },
      ],
    },
  ],
});

const asset = (path: string, kind: string) => ({
  asset_id: `nuget_asset_${"2".repeat(64)}`,
  path,
  bytes: 128,
  kind,
  target_framework: null,
  runtime_identifier: null,
  directory: false,
});

const report = () => ({
  package_id: `nuget_package_${"3".repeat(64)}`,
  format: "nupkg" as const,
  artifact,
  nuspecs: [nuspec("Example.nuspec", "Example.Package")],
  assets: [
    asset("lib/net8.0/Example.dll", "assemblies"),
    asset("lib/net8.0/Example.xml", "docs"),
    asset("lib/net8.0/Other.dll", "assemblies"),
  ],
  diagnostics: [],
  summary: { nuspecs: 1, assets: 3, assemblies: 2, diagnostics: 0 },
  source_coverage: {
    scope: "package-contents" as const,
    status: "complete-within-scope" as const,
    target_framework_selection: "not-applied" as const,
    dependency_resolution: "not-performed" as const,
    signatures: "not-verified" as const,
    package_contents: "not-executed" as const,
    network: "not-contacted" as const,
  },
  limitations: ["Member paths are inventoried as stored."],
});

const parent = (): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "inspect_nuget_package",
  normalizedResult: freezeJsonSnapshot(report()),
  sealedResult: true,
  provider: { id: "rea-nuget-package", name: "Fixture", version: "1" },
  artifact: null,
  subject: null,
  parameters: { path: artifact.path },
  limitations: ["Package metadata is publisher-provided."],
});

it("projects a package summary with per-kind counts and every diagnostic", () => {
  const projected = projectAnalysisView(
    parent(),
    analysisViewRequestSchema.parse({ kind: "summary" }),
  );
  if (!projected.ok) throw projected.error;
  expect(projected.value).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_nuget_package",
    artifact: { path: artifact.path, sha256: artifact.sha256 },
    summary: {
      nuspec_count: 1,
      asset_count: 3,
      assemblies: 2,
      asset_counts: expect.objectContaining({ assemblies: 2, docs: 1 }),
      source_coverage: { status: "complete-within-scope" },
    },
  });
  if (projected.value.kind !== "summary")
    throw new Error("Expected a summary view");
  const summary = projected.value.summary as {
    nuspecs: Record<string, unknown>[];
  };
  // The declaration identity survives; per-target dependency detail does not.
  expect(summary.nuspecs[0]).toMatchObject({ id: "Example.Package" });
  expect(summary.nuspecs[0]).not.toHaveProperty("dependency_groups");
});

it("refuses a view the package Evidence does not model", () => {
  const projected = projectAnalysisView(
    parent(),
    analysisViewRequestSchema.parse({ kind: "native-inventory" }),
  );
  expect(projected.ok).toBe(false);
});
