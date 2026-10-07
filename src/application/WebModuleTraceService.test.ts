import { describe, expect, it } from "vitest";
import { WebModuleTraceService } from "./WebModuleTraceService.js";
import { ok } from "../domain/result.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  webModuleTraceResultSchema,
  type WebModuleResolution,
} from "../domain/webModuleTrace.js";
import {
  webModuleArtifactsFixture,
  webModuleResolverFixture,
} from "../../tests/fixtures/webModuleTrace.js";

const args = { manifest_path: "/analysis/manifest.json", script_index: 0 };
it("rejects sparse resolver arrays rather than relabeling literal imports as computed unknowns", async () => {
  const artifacts = webModuleArtifactsFixture('import "./dep.js";');
  const service = new WebModuleTraceService(
    { load: () => Promise.resolve(ok(artifacts)) },
    {
      resolve: () =>
        Promise.resolve(
          ok({
            engine: { id: "fixture", version: "1" },
            resolutions: new Array<WebModuleResolution>(1),
            diagnostics: [],
            rawResult: {},
          }),
        ),
    },
  );
  const result = await service.trace(args);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
});
describe("selected module trace workflow", () => {
  it("composes selected source, derived resolution and explicit computed/execution unknowns", async () => {
    const artifacts = webModuleArtifactsFixture();
    const service = new WebModuleTraceService(
      { load: () => Promise.resolve(ok(artifacts)) },
      webModuleResolverFixture,
    );
    const response = await service.trace(args);
    if (!response.ok) throw response.error;
    const result = webModuleTraceResultSchema.parse(
      response.value.normalized_result,
    );
    expect(result.importer).toEqual({
      url: artifacts.manifest.scripts[0]?.url,
      basis: "reported-source-url",
    });
    expect(result.imports[0]?.resolution).toEqual({
      state: "resolved",
      url: "https://app.test/dep.js",
    });
    expect(result.imports[1]?.resolution).toEqual({
      state: "unknown",
      reason: "computed-specifier",
    });
    expect(result.imports.every((item) => item.execution === "unknown")).toBe(
      true,
    );
    expect(response.value.subject).toMatchObject({
      local_path: artifacts.sourceFile.path,
      digest: { sha256: artifacts.sourceFile.sha256 },
    });
  });
  it.each([
    { ...args, manifest_path: "relative.json" },
    {
      ...args,
      import_map: { path: "relative.json", base_url: "https://app.test/" },
    },
    { ...args, importer_url: "file:///tmp/main.js" },
    { ...args, import_map: { path: "/map.json", base_url: "relative" } },
  ])(
    "rejects malformed context before acquiring artifacts: %j",
    async (input) => {
      const service = new WebModuleTraceService(
        {
          load: () => {
            throw new Error("must not acquire");
          },
        },
        webModuleResolverFixture,
      );
      const response = await service.trace(input);
      if (response.ok) throw new Error("expected invalid input");
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [expect.objectContaining({ reason: "invalid_format" })],
        },
      });
    },
  );
  it("handles computed-only sources without acquiring the optional engine", async () => {
    const artifacts = webModuleArtifactsFixture("import(name)");
    const service = new WebModuleTraceService(
      { load: () => Promise.resolve(ok(artifacts)) },
      {
        resolve: () => {
          throw new Error("engine must not start");
        },
      },
    );
    const result = await service.trace(args);
    if (!result.ok) throw result.error;
    expect(
      webModuleTraceResultSchema.parse(result.value.normalized_result).engine,
    ).toBeNull();
  });
  it("rejects incomplete resolution rather than fabricating unknown values", async () => {
    const artifacts = webModuleArtifactsFixture();
    const service = new WebModuleTraceService(
      { load: () => Promise.resolve(ok(artifacts)) },
      {
        resolve: () =>
          Promise.resolve(
            ok({
              engine: { id: "fixture", version: "1" },
              resolutions: [],
              diagnostics: [],
              rawResult: {},
            }),
          ),
      },
    );
    const response = await service.trace(args);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error._tag).toBe("AnalysisOutputError");
  });
  it("preserves an explicit selected importer context", async () => {
    const artifacts = webModuleArtifactsFixture();
    const result = await new WebModuleTraceService(
      { load: () => Promise.resolve(ok(artifacts)) },
      webModuleResolverFixture,
    ).trace({ ...args, importer_url: "https://selected.test/base/main.js" });
    if (!result.ok) throw result.error;
    expect(
      webModuleTraceResultSchema.parse(result.value.normalized_result)
        .imports[0]?.resolution,
    ).toEqual({ state: "resolved", url: "https://selected.test/base/dep.js" });
  });
  it("honors cancellation before any artifacts are acquired", async () => {
    const controller = new AbortController();
    controller.abort();
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
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  });
});
