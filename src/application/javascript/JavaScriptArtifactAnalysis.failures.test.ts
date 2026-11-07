import { expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { err } from "../../domain/result.js";
import { analyzeAndAdoptJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";
import { createJavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";

it("summarizes repeated source failures while preserving each file's reason", async () => {
  const files: JavaScriptArtifactFile[] = Array.from(
    { length: 40 },
    (_, index) => ({
      path: `src/file-${String(index)}.js`,
      container_sha256: "a".repeat(64),
      sha256: "b".repeat(64),
      bytes: 1,
      inventory_artifact_id: `artifact-${String(index)}`,
      kind: "javascript",
      unpacked: false,
      text: { included: true, value: "x" },
    }),
  );
  const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
    { files, containers: [], text_bytes_read: 40, invalid_utf8_files: 0 },
    {
      analyze: async (file) =>
        err({
          error: new AnalysisResourceConstraintError(
            "analyze",
            "memory",
            `failure for ${file.path}`,
            null,
          ),
          javascript: null,
          module: null,
          projection: null,
        }),
    },
    createJavaScriptSemanticGraphProjection(),
    async () => {},
  );
  expect(outcome.interruption).toBeNull();
  expect(outcome.analysis.limitations).toHaveLength(3);
  expect(outcome.analysis.limitations[2]).toContain("40 source file(s)");
  expect(outcome.analysis.files).toHaveLength(40);
  for (const file of outcome.analysis.files)
    expect(file.analysis_failure?.reason).toContain(
      `failure for ${file.file.path}`,
    );
});
