import { webSourceLocationInputSchema } from "../../domain/webSourceLocation.js";
import { analyzeWebBundleInputSchema } from "../../domain/webBundleAnalysis.js";
import { webSourceLocationArgs } from "../../../tests/fixtures/webSourceLocation.js";
import { selectedSourceMapLimits } from "../../domain/sourceMapLimits.js";
import { expect, it } from "vitest";

import { traceSourceMap } from "./TraceSourceMap.js";

it("recovers the same finite map by raising the exact decoder record admission", () => {
  const text = JSON.stringify({
    version: 3,
    sources: ["a.ts"],
    sourcesContent: ["original"],
    names: [],
    mappings: "AAAA",
  });
  const position = { line: 1, column: 0 };
  expect(() =>
    traceSourceMap(
      text,
      "https://example.test/app.map",
      position,
      selectedSourceMapLimits({ decoded_records: 4 }),
    ),
  ).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        format: "source-map",
        limit: { name: "decoded_records", maximum: 4 },
        detail: expect.stringContaining(
          "source_map_limits.decoded_records is 4",
        ),
      }),
    }),
  );
  expect(
    traceSourceMap(
      text,
      "https://example.test/app.map",
      position,
      selectedSourceMapLimits({ decoded_records: 5 }),
    ).matches,
  ).toMatchObject([{ reported_source: "a.ts", content: { text: "original" } }]);
});

it("rejects invalid and inapplicable budget selections at the public owning contracts", () => {
  for (const selection of [
    { map_bytes: 0 },
    { output_bytes: 536870888 },
    { decoded_records: 0 },
    { decoded_records: undefined },
    { codec_heap_mib: 127 },
    { fetch_bytes: 1024 },
  ]) {
    expect(
      webSourceLocationInputSchema.safeParse({
        ...webSourceLocationArgs,
        source_map_limits: selection,
      }).success,
    ).toBe(false);
  }
  const bundle = {
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: ["https://app.test"],
    target_id: "page",
    fetch_source_maps: true,
  };
  expect(
    analyzeWebBundleInputSchema.safeParse({
      ...bundle,
      fetch_source_maps: false,
      source_map_limits: { decoded_records: 5 },
    }).success,
  ).toBe(false);
  for (const selection of [{ map_bytes: 1024 }, { codec_heap_mib: 256 }]) {
    expect(
      analyzeWebBundleInputSchema.safeParse({
        ...bundle,
        source_map_limits: selection,
      }).success,
    ).toBe(false);
  }
});
