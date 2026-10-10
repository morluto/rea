import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { analyzeJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { SEMANTIC_MODULE_SOURCE_BYTES_LIMIT } from "../../domain/javascript/javascriptSemanticResourceLimits.js";

const SHA256 = "a".repeat(64);

const fileFor = (path: string, source: string): JavaScriptArtifactFile => ({
  path,
  container_sha256: SHA256,
  sha256: createHash("sha256").update(source).digest("hex"),
  bytes: Buffer.byteLength(source),
  inventory_artifact_id: `art_${createHash("sha256")
    .update(path)
    .digest("hex")}`,
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: source },
});

it("skips deep semantics above the module payload budget instead of expanding the module in-process", () => {
  const oversized = fileFor(
    "chunk-oversized.js",
    `const pad = "${"a".repeat(SEMANTIC_MODULE_SOURCE_BYTES_LIMIT)}";\nexport { pad };\n`,
  );
  const regular = fileFor("app.js", "export const answer = 42;\n");
  const analysis = analyzeJavaScriptArtifactFiles({
    files: [oversized, regular],
    containers: [],
    text_bytes_read: oversized.bytes + regular.bytes,
    invalid_utf8_files: 0,
  });

  const degraded = analysis.files.find(
    ({ file }) => file.path === "chunk-oversized.js",
  )?.semantic?.ir;
  expect(degraded).toBeDefined();
  expect(degraded?.coverage).toMatchObject({
    status: "failed",
    resourceLimits: ["module-source-bytes"],
  });
  expect(degraded?.bindings).toEqual([]);
  expect(degraded?.limitations).toContain(
    "The module source exceeds the 2097152-byte semantic payload budget; deep semantic analysis was skipped and no semantic absence claim is available for this module.",
  );
  // Static facts survive the payload budget: the parse completed.
  const staticFacts = analysis.files.find(
    ({ file }) => file.path === "chunk-oversized.js",
  )?.javascript;
  expect(staticFacts?.parse_status).toBe("complete");

  const unaffected = analysis.files.find(({ file }) => file.path === "app.js")
    ?.semantic?.ir;
  expect(unaffected?.coverage).toMatchObject({ status: "complete" });
  expect(unaffected?.bindings.some(({ name }) => name === "answer")).toBe(true);
  expect(analysis.parse_failures).toBe(0);
});
