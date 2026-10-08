import { setImmediate } from "node:timers";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

describe("JavaScript analysis cancellation before publication", () => {
  it.each([
    "parse_javascript_source",
    "build_javascript_application_graph",
    "seal_javascript_application_graph",
    "build_javascript_semantic_graph",
    "seal_javascript_semantic_graph",
    "validate_javascript_application_result",
    "create_javascript_application_evidence",
    "seal_javascript_application_result",
    "validate_javascript_application_evidence",
    "hash_javascript_application_evidence",
  ])("rejects cancellation scheduled during %s", async (phase) => {
    const root = await createTestTempDirectory("rea-js-cancel-phase-");
    await writeFile(
      join(root, "main.js"),
      "export function inspect(value) { return JSON.stringify(value); }\n",
    );
    const controller = new AbortController();
    let requested = false;
    const terminal: string[] = [];
    const result = await analyzeJavaScriptApplication(
      { input_path: root, format: "directory" },
      {
        signal: controller.signal,
        progress: {
          async report(event) {
            if (event.terminal) terminal.push(event.phase);
            if (event.phase === phase) {
              requested = true;
              setImmediate(() => controller.abort());
            }
          },
        },
      },
    );
    expect(requested).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("Cancelled analysis must not publish Evidence");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cancelled",
      details: { reason: "cancelled" },
    });
    expect(terminal).toEqual([]);
  });

  it("honors cancellation observed during the terminal publication race", async () => {
    const root = await createTestTempDirectory("rea-js-cancel-terminal-");
    await writeFile(join(root, "main.js"), "export const value = 1;\n");
    const controller = new AbortController();
    const result = await analyzeJavaScriptApplication(
      { input_path: root, format: "directory" },
      {
        signal: controller.signal,
        progress: {
          async report(event) {
            if (event.terminal) controller.abort();
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected cancellation before admission");
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: { reason: "cancelled" },
    });
  });
});
