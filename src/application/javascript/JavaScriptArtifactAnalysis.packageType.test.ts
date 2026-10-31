import { expect, it } from "vitest";
import { analyzeAndAdoptJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";
import { createJavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import { analyzeJavaScriptStaticSource } from "../../domain/javascript/javascriptStaticAnalysis.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptUnanalyzedArtifactFile,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptPackageType } from "../../domain/javascript/javascriptSourceParser.js";
import { ok } from "../../domain/result.js";

const container = "a".repeat(64);

const included = (
  path: string,
  kind: JavaScriptArtifactFile["kind"],
  text: string,
): JavaScriptArtifactFile => ({
  path,
  container_sha256: container,
  sha256: "b".repeat(64),
  bytes: Buffer.byteLength(text),
  inventory_artifact_id: path,
  kind,
  unpacked: false,
  text: { included: true, value: text },
});

it("leaves the package type unknown behind a nearer unavailable manifest", async () => {
  const files = [
    included("package.json", "package-json", '{"type":"module"}'),
    included("main.js", "javascript", 'require("./dep.cjs");'),
    included("nested/main.js", "javascript", 'require("../dep.cjs");'),
    included(
      "nested/inner/package.json",
      "package-json",
      '{"type":"commonjs"}',
    ),
    included("nested/inner/main.js", "javascript", 'require("../../dep.cjs");'),
  ];
  const unavailable: JavaScriptUnanalyzedArtifactFile = {
    path: "nested/package.json",
    container_sha256: container,
    sha256: null,
    bytes: null,
    inventory_artifact_id: null,
    kind: "package-json",
    limitations: ["Inventoried package bytes are unavailable."],
  };
  const observed = new Map<string, JavaScriptPackageType | undefined>();
  const javascript = analyzeJavaScriptStaticSource("");
  const worker = {
    analyze: async (
      file: JavaScriptArtifactFile,
      _capacity: unknown,
      _signal?: AbortSignal,
      _onPhase?: unknown,
      packageType?: JavaScriptPackageType,
    ) => {
      observed.set(file.path, packageType);
      return ok({ javascript, module: null, projection: null });
    },
  };
  await analyzeAndAdoptJavaScriptArtifactFiles(
    {
      files,
      unavailable_relevant_files: [unavailable],
      containers: [],
      text_bytes_read: 0,
      invalid_utf8_files: 0,
    },
    worker,
    createJavaScriptSemanticGraphProjection(),
    async () => {},
  );
  // The nearest package.json owns a source's scope even when its bytes are
  // unavailable, so the root type must not reach nested/main.js.
  expect(Object.fromEntries(observed)).toEqual({
    "main.js": "module",
    "nested/main.js": "unknown",
    "nested/inner/main.js": "commonjs",
  });
});
