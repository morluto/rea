import { describe, expect, it } from "vitest";
import { WebModuleTraceService } from "./WebModuleTraceService.js";
import { err, ok } from "../domain/result.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  webModuleTraceResultSchema,
  type WebModuleResolution,
  type WebModuleResolutionRequest,
} from "../domain/webModuleTrace.js";
import {
  webModuleArtifactsFixture,
  webModuleResolverFixture,
} from "../../tests/fixtures/webModuleTrace.js";

import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { parseEvidence } from "../domain/evidence.js";

const args = { manifest_path: "/analysis/manifest.json", script_index: 0 };
it("distinguishes malformed selections and unsupported contexts before acquiring artifacts", async () => {
  const workflow = new WebModuleTraceService(
    {
      load: () => {
        throw new Error("Unexpected artifact acquisition");
      },
    },
    webModuleResolverFixture,
  );
  for (const selection of [
    { importer_url: "file:///tmp/main.js" },
    { import_map: { path: "/map.json", base_url: "file:///tmp/maps/" } },
  ]) {
    const result = await workflow.trace({ ...args, ...selection });
    if (result.ok) throw new Error("Expected unsupported context");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("file:"),
      details: { reason: "unsupported_context_scheme" },
    });
  }
  for (const [selection, path] of [
    [{ manifest_path: "relative.json" }, ["manifest_path"]],
    [
      { import_map: { path: "relative.json", base_url: "https://app.test/" } },
      ["import_map", "path"],
    ],
    [{ importer_url: "not a URL" }, ["importer_url"]],
    [
      { import_map: { path: "/map.json", base_url: "relative" } },
      ["import_map", "base_url"],
    ],
  ] as const) {
    const result = await workflow.trace({ ...args, ...selection });
    if (result.ok) throw new Error("Expected malformed context");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path, reason: "invalid_format" }] },
    });
  }
});
it("rejects source text changed across the artifact port before acquiring the resolver", async () => {
  const artifacts = {
    ...webModuleArtifactsFixture('import "./dep.js";'),
    source: 'import "./alt.js";',
  };
  const result = await new WebModuleTraceService(
    { load: () => Promise.resolve(ok(artifacts)) },
    {
      resolve: () => {
        throw new Error("must not acquire engine");
      },
    },
  ).trace(args);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
});
it("retains malformed, short and failed resolver outcomes even after cancellation", async () => {
  const artifacts = webModuleArtifactsFixture();
  const sparse: WebModuleResolution[] = [];
  sparse.length = 1;
  const report = (resolutions: WebModuleResolution[]) =>
    ok({
      engine: { id: "fixture", version: "1" },
      resolutions,
      diagnostics: [],
      rawResult: {},
    });
  const primary = new AnalysisOutputError(
    "trace_web_module_imports",
    "controlled resolver failure",
  );
  const excess: WebModuleResolution[] = [
    { state: "resolved", url: "https://app.test/dep.js" },
    { state: "resolved", url: "https://app.test/unrequested.js" },
  ];
  for (const [name, outcome, abort] of [
    ["sparse", report(sparse), false],
    ["short", report([]), true],
    ["excess", report(excess), false],
    ["failed", err(primary), true],
  ] as const) {
    const controller = new AbortController();
    const result = await new WebModuleTraceService(
      { load: async () => ok(artifacts) },
      {
        resolve: async () => {
          if (abort) controller.abort({ request: "late cancellation" });
          return outcome;
        },
      },
    ).trace(args, { signal: controller.signal });
    if (result.ok) throw new Error("Expected invalid resolver output");
    if (!outcome.ok) expect(result.error).toBe(primary);
    expect(result.error, name).toMatchObject({
      _tag: "AnalysisOutputError",
      operation: "trace_web_module_imports",
      partialObservation: {
        kind: "web-trace-observation",
        analysis: "incomplete",
        source: artifacts.sourceFile,
      },
    });
  }
});

it("honors cancellation before any artifacts are acquired", async () => {
  const controller = new AbortController();
  controller.abort(null);
  const service = new WebModuleTraceService(
    {
      load: () => {
        throw new Error("must not acquire");
      },
    },
    webModuleResolverFixture,
  );
  const result = await service.trace(args, { signal: controller.signal });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBeNull();
  }
});

describe("reported module context provenance", () => {
  it.each(["", "not a URL", "https://user:password@app.test/main.js"])(
    "retains unusable reported context as a capability limitation: %s",
    async (reportedUrl) => {
      const artifacts = webModuleArtifactsFixture();
      const script = artifacts.manifest.scripts[0];
      if (script === undefined) throw new Error("fixture script missing");
      script.url = reportedUrl;
      const service = new WebModuleTraceService(
        { load: () => Promise.resolve(ok(artifacts)) },
        {
          resolve: () => {
            throw new Error("must not resolve without a usable context");
          },
        },
      );
      const response = await service.trace(args);
      if (response.ok) throw new Error("expected unavailable context");
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "capability_unavailable",
        message: expect.stringContaining("Select importer_url explicitly"),
        details: { reason: "reported_source_context_unavailable" },
      });
      expect(projectAnalysisError(response.error).details).not.toHaveProperty(
        "issues",
      );
    },
  );
  it("keeps an unsupported reported scheme distinct from malformed context", async () => {
    const artifacts = webModuleArtifactsFixture();
    const script = artifacts.manifest.scripts[0];
    if (script === undefined) throw new Error("fixture script missing");
    script.url = "file:///captured/main.js";
    const response = await new WebModuleTraceService(
      { load: async () => ok(artifacts) },
      webModuleResolverFixture,
    ).trace(args);
    if (response.ok) throw new Error("expected unsupported context");
    expect(projectAnalysisError(response.error)).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("reported source URL"),
      details: { reason: "unsupported_context_scheme" },
    });
  });
  it("honors an explicit context while retaining the unusable reported source URL", async () => {
    const artifacts = webModuleArtifactsFixture();
    const script = artifacts.manifest.scripts[0];
    if (script === undefined) throw new Error("fixture script missing");
    script.url = "not a URL";
    const result = await new WebModuleTraceService(
      { load: async () => ok(artifacts) },
      webModuleResolverFixture,
    ).trace({ ...args, importer_url: "https://selected.test/base/main.js" });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      parameters: { importer_url: "https://selected.test/base/main.js" },
      normalized_result: {
        source: { script: { url: "not a URL" } },
        importer: {
          url: "https://selected.test/base/main.js",
          basis: "caller-selected",
        },
        imports: expect.arrayContaining([
          expect.objectContaining({
            resolution: {
              state: "resolved",
              url: "https://selected.test/base/dep.js",
            },
          }),
        ]),
      },
    });
  });
});

it.each([null, { request: "opaque cancellation" }])(
  "retains completed module Evidence and the exact late abort reason: %j",
  async (reason) => {
    const controller = new AbortController();
    const artifacts = webModuleArtifactsFixture();
    const service = new WebModuleTraceService(
      { load: async () => ok(artifacts) },
      {
        resolve: async (input) => {
          const result = await webModuleResolverFixture.resolve(input);
          controller.abort(reason);
          return result;
        },
      },
    );
    const result = await service.trace(args, { signal: controller.signal });
    if (result.ok) throw new Error("expected cancelled completion");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "trace_web_module_imports",
      confidence: "derived",
      normalized_result: {
        source: artifacts.sourceFile,
        imports: [
          {
            resolution: { state: "resolved", url: "https://app.test/dep.js" },
            execution: "unknown",
          },
          {
            resolution: { state: "unknown", reason: "computed-specifier" },
            execution: "unknown",
          },
        ],
      },
      raw_result: { fixture: true },
    });
  },
);

it("does not start the native resolver after cancellation during artifact admission", async () => {
  const controller = new AbortController();
  const reason = { request: "cancelled local artifact read" };
  const result = await new WebModuleTraceService(
    {
      load: async () => {
        controller.abort(reason);
        return ok(webModuleArtifactsFixture());
      },
    },
    {
      resolve: async () => {
        throw new Error("must not start resolver");
      },
    },
  ).trace(args, { signal: controller.signal });
  if (result.ok) throw new Error("expected cancelled admission");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
});

it("adopts complete interrupted resolution only for the exact selected request", async () => {
  const artifacts = webModuleArtifactsFixture(
    'import "./dep.js"; import(name); import "./other.js";',
  );
  const importMap = {
    file: { path: "/analysis/map.json", sha256: "c".repeat(64), bytes: 2 },
    baseUrl: "https://app.test/maps/",
    value: { imports: { dep: "./dep.js" } },
  };
  const importer = "https://app.test/main.js?build=1#entry";
  const request: WebModuleResolutionRequest = {
    importerUrl: importer,
    importMap: { baseUrl: importMap.baseUrl, value: importMap.value },
    specifiers: ["./dep.js", "./other.js"],
  };
  const decoded = await webModuleResolverFixture.resolve(request);
  if (!decoded.ok) throw decoded.error;
  const batch = decoded.value;
  const selected = {
    ...args,
    import_map: { path: importMap.file.path, base_url: importMap.baseUrl },
  };
  const map = { baseUrl: importMap.baseUrl, value: importMap.value };
  const changes: Record<string, Partial<WebModuleResolutionRequest>> = {
    complete: {},
    importer: { importerUrl: "https://other.test/" },
    "map base": { importMap: { ...map, baseUrl: "https://other.test/" } },
    "map value": {
      importMap: { ...map, value: { imports: { dep: "./changed.js" } } },
    },
    literal: { specifiers: ["./changed.js", "./other.js"] },
    order: { specifiers: ["./other.js", "./dep.js"] },
    short: {},
  };

  for (const [name, change] of Object.entries(changes)) {
    const observation = {
      kind: "web-module-resolution" as const,
      request: { ...request, ...change },
      batch:
        name === "short"
          ? { ...batch, resolutions: batch.resolutions.slice(0, 1) }
          : batch,
    };
    const failure = new AnalysisCancelledError("trace_web_module_imports", {
      cause: null,
      partialObservation: observation,
    });
    const result = await new WebModuleTraceService(
      { load: async () => ok({ ...artifacts, importMap }) },
      {
        resolve: async (input) => {
          expect(input, name).toEqual(request);
          return err(failure);
        },
      },
    ).trace(selected);
    if (result.ok) throw new Error("Expected original cancellation");
    expect(result.error, name).toBe(failure);
    expect(result.error.cause, name).toBeNull();
    if (name === "complete") {
      expect(parseEvidence(result.error.partialObservation)).toMatchObject({
        operation: "trace_web_module_imports",
        parameters: selected,
        raw_result: batch.rawResult,
        normalized_result: {
          importer: { url: importer, basis: "reported-source-url" },
          import_map: { ...importMap.file, base_url: importMap.baseUrl },
          imports: [
            {
              resolution: { state: "resolved", url: "https://app.test/dep.js" },
            },
            { resolution: { state: "unknown", reason: "computed-specifier" } },
            {
              resolution: {
                state: "resolved",
                url: "https://app.test/other.js",
              },
            },
          ],
        },
      });
    } else {
      expect(result.error.partialObservation, name).toEqual({
        kind: "web-trace-observation",
        analysis: "incomplete",
        manifest: artifacts.manifestFile,
        source: artifacts.sourceFile,
        import_map: importMap.file,
        resolver_observation: observation,
      });
    }
  }
});

it("retains a completed engine-free trace when artifact loading finishes under cancellation", async () => {
  const controller = new AbortController();
  const reason = { request: "engine-free completion" };
  const result = await new WebModuleTraceService(
    {
      load: async () => {
        controller.abort(reason);
        return ok(webModuleArtifactsFixture("import(name)"));
      },
    },
    {
      resolve: async () => {
        throw new Error("no literal imports to resolve");
      },
    },
  ).trace(args, { signal: controller.signal });
  if (result.ok) throw new Error("expected cancelled completion");
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "trace_web_module_imports",
    normalized_result: {
      engine: null,
      imports: [
        { resolution: { state: "unknown", reason: "computed-specifier" } },
      ],
    },
  });
});

it("resolves imports from relational JavaScript using the selected source grammar", async () => {
  const artifacts = webModuleArtifactsFixture(
    'const order = left < import("./dep.js") > (right);',
  );
  const result = await new WebModuleTraceService(
    { load: async () => ok(artifacts) },
    webModuleResolverFixture,
  ).trace(args);
  if (!result.ok) throw result.error;
  expect(
    webModuleTraceResultSchema.parse(result.value.normalized_result),
  ).toMatchObject({
    parser: { state: "parsed", diagnostics: [] },
    imports: [
      {
        kind: "dynamic-import",
        specifier: "./dep.js",
        resolution: { state: "resolved", url: "https://app.test/dep.js" },
      },
    ],
  });
});
