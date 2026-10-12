import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { writeJavaScriptSourceSelectionFixture } from "../../../fixtures/javascriptSourceSelection.js";

import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
import { scanCanonicalArtifactInventory } from "../../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { AnalysisCancelledError } from "../../../../src/domain/analysisErrorCore.js";
import {
  analyzeJavaScriptApplication,
  readJavaScriptArtifactFiles,
} from "../../../support/javascriptApplicationScope.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { createJavaScriptSourceAnalysis } from "../../../../src/artifacts/javascript/JavaScriptSourceAnalysis.js";
import { analyzeAndAdoptJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { createJavaScriptSemanticGraphProjection } from "../../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";

describe("JavaScript source selection cancellation boundary", () => {
  it("keeps unselected files outside scope when the real worker cancels after the last selected file", async () => {
    const root = await createTestTempDirectory(
      "rea-js-selected-last-cancellation-",
    );
    await writeJavaScriptSourceSelectionFixture(root);
    const snapshot = await scanCanonicalArtifactInventory(root, {});
    const reader = createJavaScriptArtifactReader(root, "directory");
    const controller = new AbortController();
    const sourcePaths = ["main.mjs"];
    try {
      const files = await readJavaScriptArtifactFiles(
        reader,
        snapshot,
        controller.signal,
        sourcePaths,
      );
      const worker = createJavaScriptSourceAnalysis(
        { heapMb: 512, timeoutMs: 30_000 },
        1,
      );
      let outcome: Awaited<
        ReturnType<typeof analyzeAndAdoptJavaScriptArtifactFiles>
      >;
      try {
        const realWorker = worker.analyze.bind(worker);
        outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
          files,
          {
            analyze: async (...args) => {
              const result = await realWorker(...args);
              controller.abort();
              return result;
            },
          },
          createJavaScriptSemanticGraphProjection(),
          async () => {},
          controller.signal,
        );
      } finally {
        await worker.close();
      }
      expect(outcome.interruption).toBeInstanceOf(AnalysisCancelledError);
      const unselected = outcome.analysis.files.filter(
        ({ file }) =>
          !file.text.included && file.text.reason === "outside-analysis-scope",
      );
      expect(unselected).toHaveLength(5);
      expect(
        unselected.every(
          ({ analysis_failure }) => analysis_failure === undefined,
        ),
      ).toBe(true);
      expect(
        outcome.analysis.files.find(({ file }) => file.path === "main.mjs")
          ?.javascript,
      ).toMatchObject({ parse_status: "complete" });
    } finally {
      await reader.close();
    }
  });
});

describe("Selected JavaScript source failure diagnostics", () => {
  it("analyzes selected files in first-request order and reports only selected progress", async () => {
    const root = await createTestTempDirectory("rea-js-selected-priority-");
    await writeJavaScriptSourceSelectionFixture(root);
    await writeFile(join(root, "z-later.mjs"), "export const later = 1;\n");
    const progress: string[] = [];
    const result = await analyzeJavaScriptApplication(
      {
        input_path: root,
        source_paths: ["z-later.mjs", "main.mjs", "z-later.mjs"],
      },
      {
        progress: {
          report: async (event) => {
            if (event.phase === "parse_javascript_source")
              progress.push(event.message);
          },
        },
      },
    );
    if (!result.ok) throw result.error;
    const analysis = javascriptApplicationAnalysisResultSchema.parse(
      result.value.normalized_result,
    );
    expect(analysis.source_selection).toEqual({
      requested_paths: ["z-later.mjs", "main.mjs", "z-later.mjs"],
      unselected_files: 5,
    });
    expect(analysis.statistics.parsed_javascript_files).toBe(2);
    expect(progress).toEqual([
      expect.stringContaining("z-later.mjs"),
      expect.stringContaining("main.mjs"),
    ]);
  });

  it("verifies unselected bytes against the inventoried identity without decoding them", async () => {
    const root = await createTestTempDirectory("rea-js-unselected-integrity-");
    await writeJavaScriptSourceSelectionFixture(root);
    const result = await analyzeJavaScriptApplication(
      { input_path: root, source_paths: ["main.mjs"] },
      {
        progress: {
          report: async (event) => {
            if (event.phase === "read_javascript_artifacts")
              await writeFile(
                join(root, "vendor.js"),
                "changed after inventory\n",
              );
          },
        },
      },
    );
    if (result.ok)
      throw new Error(
        "Unselected content changes must still fail integrity verification",
      );
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "artifact_operation_failed",
      details: { reason: "integrity" },
    });
  });

  it("retains selected facts and unselected scope after cancellation between selected sources", async () => {
    const root = await createTestTempDirectory("rea-js-selected-cancellation-");
    await writeJavaScriptSourceSelectionFixture(root);
    await writeFile(join(root, "z-later.mjs"), "export const later = 1;\n");
    const controller = new AbortController();
    const source_paths = ["main.mjs", "z-later.mjs"];
    const result = await analyzeJavaScriptApplication(
      { input_path: root, source_paths },
      {
        signal: controller.signal,
        progress: {
          report: async (event) => {
            if (
              event.phase === "parse_javascript_source" &&
              event.message.includes("z-later.mjs")
            )
              controller.abort();
          },
        },
      },
    );
    if (result.ok) throw new Error("Expected selected-source cancellation");
    expect(projectAnalysisError(result.error).code).toBe("cancelled");
    const evidence = parseEvidence(result.error.partialObservation);
    const partial = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expect(partial.source_selection).toEqual({
      requested_paths: source_paths,
      unselected_files: 5,
    });
    expect(
      partial.semantic_graph.nodes.some(
        ({ kind, label }) => kind === "function" && label === "selected",
      ),
    ).toBe(true);
    expect(partial.statistics.parsed_javascript_files).toBe(1);
    expect(partial.graph.coverage.status).toBe("partial");
    expect(
      partial.graph.nodes
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties),
        )
        .filter(
          (properties) => properties.text_status === "outside-analysis-scope",
        ),
    ).toHaveLength(5);
  });
});

describe("JavaScript application failure diagnostics", () => {
  it("identifies the rejected result field in caller-visible diagnostics", async () => {
    const inputPath = await createTestTempDirectory("rea-js-schema-failure-");
    await writeFile(join(inputPath, "main.js"), "export const value = 1;\n");
    const cause = new z.ZodError([
      {
        code: "custom",
        path: ["semantic_graph", "nodes", 42, "application_node_ids", 0],
        message: "Semantic node references an absent application node",
      },
    ]);
    const result = await analyzeJavaScriptApplication(
      { input_path: inputPath, format: "directory" },
      {
        progress: {
          report: async (event) => {
            if (event.terminal) throw cause;
          },
        },
      },
    );

    if (result.ok) throw new Error("Expected analysis failure");
    expect(result.error.cause).toBe(cause);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "unreadable_output",
      details: {
        operation: "analyze_javascript_application",
        reason:
          "Result schema rejected 1 issue at /semantic_graph/nodes/42/application_node_ids/0 (custom)",
      },
    });
  });

  it("retains unexpected failures and their input identity in caller-visible diagnostics", async () => {
    const inputPath = await createTestTempDirectory("rea-js-failure-");
    await writeFile(join(inputPath, "main.js"), "export const value = 1;\n");
    const cause = new RangeError("Invalid string length");
    // Retain the original failure locally, but never serialize its object graph.
    cause.cause = cause;
    const result = await analyzeJavaScriptApplication(
      { input_path: inputPath, format: "directory" },
      {
        progress: {
          report: async (event) => {
            if (event.terminal) throw cause;
          },
        },
      },
    );
    if (result.ok) throw new Error("Expected analysis failure");
    expect(result.error.cause).toBe(cause);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "execution_failure",
      details: {
        provider_id: "rea-javascript-application",
        operation: "analyze_javascript_application",
        diagnostics: {
          input_path: inputPath,
          error_name: "RangeError",
          error_message: "Invalid string length",
        },
      },
    });
    const projection = projectAnalysisError(result.error);
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
  });

  it("reports a missing selection as invalid input, not an engine failure", async () => {
    const root = await createTestTempDirectory("rea-js-missing-");
    const result = await analyzeJavaScriptApplication({
      input_path: join(root, "missing"),
      format: "directory",
    });
    if (result.ok) throw new Error("Expected missing artifact failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "analyze_javascript_application",
        issues: [{ path: ["input_path"], reason: "invalid_value" }],
      },
    });
  });

  it.each(["reported failure", null])(
    "retains non-Error failures (%s)",
    async (cause) => {
      const inputPath = await createTestTempDirectory("rea-js-non-error-");
      await writeFile(join(inputPath, "main.js"), "export const value = 1;\n");
      const result = await analyzeJavaScriptApplication(
        { input_path: inputPath, format: "directory" },
        {
          progress: {
            report: async (event) => {
              if (event.terminal) throw cause;
            },
          },
        },
      );
      if (result.ok) throw new Error("Expected analysis failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "execution_failure",
        details: {
          diagnostics: {
            error_name: "UnknownError",
            error_message:
              typeof cause === "string"
                ? cause
                : "JavaScript analysis failed with a non-Error value",
          },
        },
      });
    },
  );

  it.each([new Error("x".repeat(10_000)), "y".repeat(10_000)])(
    "preserves long failure messages through JSON projection (%#)",
    async (cause) => {
      const inputPath = await createTestTempDirectory("rea-js-oversized-");
      await writeFile(join(inputPath, "main.js"), "export const value = 1;\n");
      const message = cause instanceof Error ? cause.message : cause;
      const result = await analyzeJavaScriptApplication(
        { input_path: inputPath, format: "directory" },
        {
          progress: {
            report: async (event) => {
              if (event.terminal) throw cause;
            },
          },
        },
      );
      if (result.ok) throw new Error("Expected analysis failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "execution_failure",
        details: {
          diagnostics: {
            error_message: message,
          },
        },
      });
      const projection = projectAnalysisError(result.error);
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    },
  );
});

describe("JavaScript application cleanup diagnostics", () => {
  it("preserves cleanup and a complete inventory when translating reader failures", async () => {
    const inputPath = await createTestTempDirectory("rea-js-cleanup-failure-");
    await writeFile(join(inputPath, "main.js"), "export const value = 1;\n");
    const inventory = await scanCanonicalArtifactInventory(inputPath);
    const cleanup = {
      reason: "reader remains open",
      resources: [`JavaScript artifact reader for ${inputPath}`],
    };
    const partialObservation = {
      kind: "artifact-inventory" as const,
      inventory,
    };
    const failure = new ArtifactReaderFailure("io", "Reader cleanup failed", {
      cleanup,
      partialObservation,
    });

    const result = await analyzeJavaScriptApplication(
      { input_path: inputPath, format: "directory" },
      {
        progress: {
          report: async () => {
            throw failure;
          },
        },
      },
    );

    if (result.ok) throw new Error("Expected reader failure");
    expect(result.error).toMatchObject({
      _tag: "ArtifactOperationError",
      cleanup,
      partialObservation,
    });
  });
});
