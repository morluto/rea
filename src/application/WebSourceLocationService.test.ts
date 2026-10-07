import { expect, it } from "vitest";
import {
  webSourceLocationArgs as args,
  webSourceLocationFixture,
  webSourceMapDecoderFixture as decoder,
} from "../../tests/fixtures/webSourceLocation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ok } from "../domain/result.js";
import { webSourceLocationResultSchema } from "../domain/webSourceLocation.js";
import { WebSourceLocationService } from "./WebSourceLocationService.js";
import type { WebSourceMapPort } from "./WebSourceLocationPorts.js";

const service = (data = webSourceLocationFixture(), port = decoder) =>
  new WebSourceLocationService({ load: () => Promise.resolve(ok(data)) }, port);
it("joins byte identity and historical capture context while keeping selected authenticity/execution unknown", async () => {
  const data = webSourceLocationFixture();
  data.manifest.source_evidence_id = `ev_${"a".repeat(64)}`;
  const response = await service(data).trace(args);
  if (!response.ok) throw response.error;
  const result = webSourceLocationResultSchema.parse(
    response.value.normalized_result,
  );
  expect(result).toMatchObject({
    source: { sha256: data.sourceFile.sha256 },
    source_map: {
      association: "caller-selected",
      sha256: data.sourceMap.file.sha256,
    },
    matches: [{ state: "mapped", content: { text: "original" } }],
    execution: "unknown",
    source_authenticity: "unknown",
  });
  expect(response.value.raw_result).toEqual({
    source_map_text: data.sourceMap.text,
  });
});
it.each([
  { ...args, manifest_path: "relative.json" },
  { ...args, script_index: -1 },
  { ...args, source_map: { ...args.source_map, path: "relative.map" } },
  { ...args, source_map: { ...args.source_map, url: "relative.map" } },
  {
    ...args,
    source_map: {
      ...args.source_map,
      url: "https://user:password@app.test/map",
    },
  },
  { ...args, generated_position: { line: 0, column: 0 } },
])(
  "rejects invalid selected context before acquiring artifacts: %j",
  async (input) => {
    const response = await new WebSourceLocationService(
      {
        load: () => {
          throw new Error("must not acquire");
        },
      },
      decoder,
    ).trace(input);
    if (response.ok) throw new Error("expected invalid input");
    expect(projectAnalysisError(response.error).code).toBe("invalid_request");
  },
);
it.each(["file:///analysis/app.map", "webpack:///bundle/app.map"])(
  "retains an absolute inert map context without fetching: %s",
  async (url) => {
    const fixture = webSourceLocationFixture();
    const data = { ...fixture, sourceMap: { ...fixture.sourceMap, url } };
    const response = await service(data).trace({
      ...args,
      source_map: { ...args.source_map, url },
    });
    if (!response.ok) throw response.error;
    expect(
      webSourceLocationResultSchema.parse(response.value.normalized_result)
        .url_context,
    ).toBe(url);
  },
);
it.each(["source", "map", "map-path", "map-url"])(
  "rejects changed artifact identity before decoding: %s",
  async (variant) => {
    const fixture = webSourceLocationFixture();
    const data = {
      ...fixture,
      source: variant === "source" ? "different" : fixture.source,
      sourceMap: { ...fixture.sourceMap },
    };
    if (variant === "map") data.sourceMap.text += " ";
    if (variant === "map-path") data.sourceMap.file.path = "/other.map";
    if (variant === "map-url") data.sourceMap.url = "https://other.test/";
    const response = await service(data, {
      trace: () => {
        throw new Error("must not decode");
      },
    }).trace(args);
    if (response.ok) throw new Error("expected changed identity failure");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);
it.each(["digest", "url", "point"])(
  "rejects changed codec identity: %s",
  async (variant) => {
    const port: WebSourceMapPort = {
      trace: async (input) => {
        const decoded = await decoder.trace(input);
        if (!decoded.ok) return decoded;
        const report = decoded.value;
        if (variant === "digest") report.source_map_sha256 = "f".repeat(64);
        if (variant === "url") report.url_context = "https://other.test/";
        if (variant === "point") report.lookup.requested.column += 1;
        return Promise.resolve(ok(report));
      },
    };
    const response = await service(undefined, port).trace(args);
    if (response.ok) throw new Error("expected changed codec identity failure");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);
it("rejects a generated point outside retained text before decoding", async () => {
  const response = await service(undefined, {
    trace: () => {
      throw new Error("must not decode");
    },
  }).trace({ ...args, generated_position: { line: 2, column: 0 } });
  if (response.ok) throw new Error("expected invalid point");
  expect(projectAnalysisError(response.error)).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ message: expect.stringContaining("outside") }] },
  });
});
it("honors cancellation both before acquisition and across decoder completion", async () => {
  const first = new AbortController();
  first.abort();
  const response = await new WebSourceLocationService(
    {
      load: () => {
        throw new Error("must not acquire");
      },
    },
    decoder,
  ).trace(args, { signal: first.signal });
  expect(response.ok).toBe(false);
  const controller = new AbortController();
  const late = await service(undefined, {
    trace: (input) => {
      controller.abort();
      return decoder.trace(input);
    },
  }).trace(args, { signal: controller.signal });
  if (late.ok) throw new Error("expected cancellation");
  expect(late.error._tag).toBe("AnalysisCancelledError");
});
