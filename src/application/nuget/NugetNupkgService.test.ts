import { expect, it } from "vitest";
import { NugetNupkgService } from "./NugetNupkgService.js";
import type { NugetNupkg } from "../../domain/nuget/nupkg.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";

const identity = {
  id: "fixture-nuget-nupkg",
  name: "Source-owned nupkg reader seam",
  version: "1",
};
const report: NugetNupkg = {
  artifact: {
    path: "/artifacts/pkg.nupkg",
    sha256: "a".repeat(64),
    bytes: 64,
  },
  identity: {
    id: "Demo.Package",
    version: "1.0.0",
    authors: "Alice",
    description: "Demo",
  },
  license: { type: "expression", value: "MIT" },
  repository: {
    type: "git",
    url: "https://example.invalid/demo",
    commit: null,
    branch: null,
  },
  dependency_groups: [],
  contents: [
    {
      name: "Demo.Package.nuspec",
      path: "Demo.Package.nuspec",
      uncompressed_size: 12,
      compressed_size: 12,
      role: "nuspec",
      encrypted: false,
    },
  ],
  nuspec: {
    path: "Demo.Package.nuspec",
    bytes: 12,
    source: "root-nuspec",
  },
  coverage: { status: "complete", entries: 1, examined_nuspec_bytes: 12 },
  limitations: [
    "This workflow reads the .nupkg ZIP and .nuspec metadata without restoring, executing, or contacting a NuGet feed.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new NugetNupkgService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "pkg.nupkg" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  const nul = await service.inspect({ path: "/artifacts/pkg\0.nupkg" });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  expect(nul.ok).toBe(false);
  if (!relative.ok)
    expect(relative.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["path"] }],
    });
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  if (!nul.ok)
    expect(nul.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["path"] }],
    });
  expect(calls).toBe(0);
});

it("discards an observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const reason = { source: "caller-request", operation: "cancel" };
  const service = new NugetNupkgService({
    close: async () => {},
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
  }
});
