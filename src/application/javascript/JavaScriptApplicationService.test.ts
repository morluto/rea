import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

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

    expect(result.ok).toBe(false);
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
    expect(result.ok).toBe(false);
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

  it("keeps filesystem failures distinct from engine failures", async () => {
    const root = await createTestTempDirectory("rea-js-missing-");
    const result = await analyzeJavaScriptApplication({
      input_path: join(root, "missing"),
      format: "directory",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing artifact failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "artifact_operation_failed",
      details: { operation: "analyze_javascript_application", reason: "io" },
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
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
