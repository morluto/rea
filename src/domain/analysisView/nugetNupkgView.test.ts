import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { nugetNupkgSummaryViewResultSchema } from "./analysisViewResult.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";

const report = {
  artifact: {
    path: "/artifacts/Demo.Package.nupkg",
    sha256: "a".repeat(64),
    bytes: 100,
  },
  identity: {
    id: "Demo.Package",
    version: "1.2.3",
    authors: null,
    description: null,
  },
  license: null,
  repository: null,
  dependency_groups: [
    {
      target_framework: "net8.0",
      dependencies: ["Newtonsoft.Json", "Demo.Support"].map((id) => ({
        id,
        version: "13.0.1",
        include: null,
        exclude: null,
        development_dependency: null,
      })),
    },
  ],
  contents: ["Demo.Package.nuspec", "README.md", "build.props"].map((path) => ({
    name: path,
    path,
    uncompressed_size: 12,
    compressed_size: 12,
    role: path.endsWith(".nuspec") ? "nuspec" : "unknown",
    encrypted: false,
  })),
  nuspec: { path: "Demo.Package.nuspec", bytes: 12, source: "root-nuspec" },
  coverage: { status: "unknown", entries: 3, examined_nuspec_bytes: 12 },
  limitations: ["Package condition"],
};

const parent = (): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "file",
    },
    { id: "rea-nuget-nupkg", name: "REA NuGet package reader", version: "1" },
    {
      operation: "inspect_nuget_nupkg",
      parameters: {},
      result: report,
      limitations: ["Parent condition", "Selection condition"],
    },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: report,
    subject: evidence.subject,
    limitations: evidence.limitations,
  };
};

it("keeps source coverage and both limitation owners in the retained summary", () => {
  const input = parent();
  const result = projectAnalysisView(
    input,
    analysisViewRequestSchema.parse({ kind: "summary" }),
  );
  if (!result.ok) throw result.error;
  const view = nugetNupkgSummaryViewResultSchema.parse(result.value);
  expect(view.summary).toMatchObject({
    identity: { id: "Demo.Package", version: "1.2.3" },
    dependency_group_count: 1,
    dependency_count: 2,
    content_count: 3,
    limitation_count: 1,
    coverage: { status: "unknown", entries: 3, examined_nuspec_bytes: 12 },
  });
  expect(view).toMatchObject({
    parent_evidence_id: input.evidenceId,
    parent_digest: input.evidenceId.slice(3),
    coverage: { status: "complete-within-view", examined: 3, total: 3 },
  });
  expect(view.limitations).toEqual([
    "Package condition",
    "Parent condition",
    "Selection condition",
  ]);
});
