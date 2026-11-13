import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import {
  nugetNupkgSummaryViewResultSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";
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
      dependencies: [
        {
          id: "Newtonsoft.Json",
          version: "13.0.1",
          include: null,
          exclude: null,
          development_dependency: null,
        },
      ],
    },
  ],
  contents: [
    {
      name: "./Demo.Package.nuspec",
      path: "Demo.Package.nuspec",
      uncompressed_size: 12,
      compressed_size: 12,
      role: "nuspec",
      encrypted: false,
    },
  ],
  nuspec: { path: "Demo.Package.nuspec", bytes: 12, source: "root-nuspec" },
  coverage: { status: "complete", entries: 1, examined_nuspec_bytes: 12 },
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
      limitations: ["Parent condition"],
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

it("summarizes NuGet package Evidence with identity and counts", () => {
  const result = projectAnalysisView(
    parent(),
    analysisViewRequestSchema.parse({ kind: "summary" }),
  );
  if (!result.ok) throw result.error;
  const view = nugetNupkgSummaryViewResultSchema.parse(result.value);
  expect(view.summary).toMatchObject({
    identity: { id: "Demo.Package", version: "1.2.3" },
    dependency_group_count: 1,
    dependency_count: 1,
    content_count: 1,
    limitation_count: 1,
  });
  expect(view.limitations).toEqual(
    expect.arrayContaining(["Parent condition", "Package condition"]),
  );
});
