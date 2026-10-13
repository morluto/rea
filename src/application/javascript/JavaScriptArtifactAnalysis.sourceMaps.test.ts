import { expect, it } from "vitest";
import { TraceMap } from "@jridgewell/trace-mapping";

import { analyzeJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";

const HASH = "a".repeat(64);

it("retains batched TraceMap-resolved paths and null source positions", () => {
  const sourceMapText = JSON.stringify({
    version: 3,
    file: "main.js",
    sourceRoot: "../src/",
    sources: ["cafe\u0301.ts", null, "other.ts"],
    sourcesContent: ["export const value = 1;", null, "export {};"],
    names: [],
    mappings: "",
  });
  const analysis = analyzeJavaScriptArtifactFiles({
    files: [
      {
        path: "dist/main.js.map",
        container_sha256: HASH,
        sha256: HASH,
        bytes: Buffer.byteLength(sourceMapText),
        inventory_artifact_id: "artifact_test",
        kind: "source-map",
        unpacked: false,
        text: { included: true, value: sourceMapText },
      },
    ],
    containers: [],
    text_bytes_read: Buffer.byteLength(sourceMapText),
    invalid_utf8_files: 0,
  });
  const originals = analysis.source_maps[0]?.sources;
  const original = originals?.[0];
  const producerPath = new TraceMap(
    {
      version: 3,
      file: "main.js",
      sourceRoot: "../src/",
      sources: ["cafe\u0301.ts", "", "other.ts"],
      names: [],
      mappings: "",
    },
    "file:///artifact/dist/main.js.map",
  ).resolvedSources[0];

  if (producerPath === undefined)
    throw new Error("TraceMap should resolve its single source declaration");
  expect(originals?.[1]?.reference).toBeNull();
  expect(originals?.[2]?.reference?.resolution).toEqual({
    kind: "artifact-relative",
    path: "src/other.ts",
  });
  expect(original?.reference).toMatchObject({
    source_name: "cafe\u0301.ts",
    source_root: "../src/",
    map_path: "dist/main.js.map",
    resolution: {
      kind: "artifact-relative",
      path: "src/cafe\u0301.ts",
    },
  });
  expect(original?.reference?.resolution).toEqual({
    kind: "artifact-relative",
    path: decodeURIComponent(
      new URL(producerPath).pathname.slice("/artifact/".length),
    ),
  });
});
