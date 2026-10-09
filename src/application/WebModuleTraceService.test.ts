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
it.each([
  { ...args, importer_url: "file:///tmp/main.js" },
  { ...args, import_map: { path: "/map.json", base_url: "file:///tmp/maps/" } },
])(
  "distinguishes valid unsupported URL contexts from malformed input: %j",
  async (input) => {
    const result = await new WebModuleTraceService(
      {
        load: () => {
          throw new Error("must not acquire artifacts");
        },
      },
      webModuleResolverFixture,
    ).trace(input);
    if (result.ok) throw new Error("expected unsupported context");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("file:"),
    });
  },
);
it("rejects source text changed across the artifact port while retaining the original digest", async () => {
  const artifacts = {
    ...webModuleArtifactsFixture("import(name)"),
    source: "import(other)",
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
it("rejects sparse resolver arrays rather than relabeling literal imports as computed unknowns", async () => {
  const artifacts = webModuleArtifactsFixture('import "./dep.js";');
  const resolutions: WebModuleResolution[] = [];
  resolutions.length = 1;
  const service = new WebModuleTraceService(
    { load: () => Promise.resolve(ok(artifacts)) },
    {
      resolve: () =>
        Promise.resolve(
          ok({
            engine: { id: "fixture", version: "1" },
            resolutions,
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
  it.each([
    { ...args, manifest_path: "relative.json" },
    {
      ...args,
      import_map: { path: "relative.json", base_url: "https://app.test/" },
    },
    { ...args, importer_url: "not a URL" },
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
