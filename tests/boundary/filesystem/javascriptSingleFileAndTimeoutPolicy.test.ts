import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  type JavaScriptApplicationAnalysisResult,
  javascriptApplicationAnalysisResultSchema,
} from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

const collectUnknownObservationsByPath = (
  result: JavaScriptApplicationAnalysisResult,
): Map<string, Record<string, unknown>> =>
  new Map(
    result.graph.nodes
      .filter((node) => node.kind === "unknown")
      .flatMap((node) =>
        node.observations.flatMap((observation) => {
          const path = observation.properties.path;
          return typeof path === "string"
            ? [[path, observation.properties] as const]
            : [];
        }),
      ),
  );

const buildSlowVendorSource = (): string => {
  const lines = ["const registry = {};"];
  for (let index = 0; index < 35_000; index += 1) {
    lines.push(
      `export function vendorChunk_${String(index)}(input) { registry[${String(index)}] = { a: input?.x ?? ${String(index)}, b: [input, ${String(index + 1)}, { nested: input?.y }] }; return registry[${String(index)}]; }`,
    );
  }
  return `${lines.join("\n")}\n`;
};

describe("single-file JavaScript application analysis", () => {
  it.each([
    ["bundle.js", "auto"],
    ["bundle.js", "file"],
    ["bundle.mjs", "auto"],
    ["bundle.mjs", "file"],
  ] as const)(
    "reconstructs standalone %s directly with format %s and produces authenticated Evidence",
    async (filename, requestedFormat) => {
      const root = await createTestTempDirectory("rea-js-single-file-");
      const filePath = join(root, filename);
      const source = filename.endsWith(".mjs")
        ? [
            "export async function submitCheckout(router) {",
            '  router.push("/checkout");',
            '  return fetch("https://api.example.test/v1/checkout");',
            "}",
          ].join("\n")
        : [
            "(() => {",
            "  const __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);",
            "  const requireOrders = __commonJS((exports) => {",
            '    exports.navigateOrders = (router) => router.push("/orders/detail");',
            "  });",
            "  requireOrders();",
            "})();",
          ].join("\n");
      await writeFile(filePath, `${source}\n`);

      const outcome = await analyzeJavaScriptApplication({
        input_path: filePath,
        format: requestedFormat,
      });
      if (!outcome.ok) throw outcome.error;

      const evidence = parseEvidence(outcome.value);
      expect(evidence.subject).toMatchObject({
        name: filename,
        format: "file",
      });
      const parsedGraph = parseApplicationGraphEvidence(evidence);
      expect(parsedGraph.ok).toBe(true);

      const result = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      );
      expect(result.format).toBe("file");
      expect(result.statistics).toMatchObject({
        relevant_files: 1,
        parsed_javascript_files: 1,
        parse_failures: 0,
      });
      expect(result.graph.coverage.status).toBe("complete");
      expect(
        result.graph.nodes.some(
          (node) =>
            node.kind === "javascript-asset" &&
            node.observations.some(
              (observation) => observation.properties.path === filename,
            ),
        ),
      ).toBe(true);

      const expectedRoute = filename.endsWith(".mjs")
        ? "/checkout"
        : "/orders/detail";
      expect(
        result.route_inventory?.routes.map((entry) => entry.path),
      ).toContain(expectedRoute);
      expect(
        result.semantic_graph.nodes.some(
          (node) => node.identity.module_path === filename,
        ),
      ).toBe(true);
    },
  );

  it("supports exact source_paths and symlink classification on a single JavaScript file", async () => {
    const root = await createTestTempDirectory("rea-js-single-file-selection-");
    const stored = join(root, "content-addressed-blob");
    await writeFile(
      stored,
      "export const greet = (name: string): string => `hello ${name}`;\n",
    );
    const alias = join(root, "entry.tsx");
    await symlink(stored, alias);

    const selected = await analyzeJavaScriptApplication({
      input_path: alias,
      source_paths: ["entry.tsx"],
    });
    if (!selected.ok) throw selected.error;
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(selected.value).normalized_result,
    );
    expect(result.format).toBe("file");
    expect(result.source_selection).toEqual({
      requested_paths: ["entry.tsx"],
      unselected_files: 0,
    });

    const invalid = await analyzeJavaScriptApplication({
      input_path: alias,
      source_paths: ["other.tsx"],
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("Expected unknown source_paths to fail");
    expect(projectAnalysisError(invalid.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["source_paths", 0],
            reason: "invalid_value",
          },
        ],
      },
    });
  });
});

describe("JavaScript per-file worker timeout continuation", () => {
  it("stops on timeout by default and continues with a fresh worker when timeout_policy is record-and-continue", async () => {
    const root = await createTestTempDirectory("rea-js-timeout-policy-");
    await Promise.all([
      writeFile(
        join(root, "a-entry.mjs"),
        'export function bootEntry() { return "ready"; }\n',
      ),
      writeFile(join(root, "m-vendor.js"), buildSlowVendorSource()),
      writeFile(
        join(root, "z-routes.mjs"),
        [
          "export function registerHealthRoute(router) {",
          '  router.push("/recovered-health");',
          "}",
        ].join("\n") + "\n",
      ),
    ]);

    const stopped = await analyzeJavaScriptApplication({
      input_path: root,
      max_heap_mb: 256,
      analysis_timeout_ms: 450,
    });
    expect(stopped.ok).toBe(false);
    if (stopped.ok) throw new Error("Expected default stop policy to fail");

    const projectedStop = projectAnalysisError(stopped.error);
    expect(projectedStop).toMatchObject({
      code: "provider_timeout",
      remediation: {
        action: expect.stringContaining("record-and-continue"),
      },
    });
    const stopPartialRaw = z
      .object({ partial_observation: z.unknown() })
      .parse(projectedStop.details).partial_observation;
    const stopPartial = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(stopPartialRaw).normalized_result,
    );
    const stopUnknownsByPath = collectUnknownObservationsByPath(stopPartial);
    expect(stopUnknownsByPath.get("m-vendor.js")).toMatchObject({
      operation: "analyze-javascript-source",
      analysis_status: "interrupted",
    });
    expect(stopUnknownsByPath.get("z-routes.mjs")).toMatchObject({
      operation: "analyze-javascript-source",
      analysis_status: "not-started",
    });
    expect(
      stopPartial.route_inventory?.routes.map((entry) => entry.path) ?? [],
    ).not.toContain("/recovered-health");

    const continued = await analyzeJavaScriptApplication({
      input_path: root,
      max_heap_mb: 256,
      analysis_timeout_ms: 450,
      timeout_policy: "record-and-continue",
    });
    if (!continued.ok) throw continued.error;

    const evidence = parseEvidence(continued.value);
    expect(evidence.parameters).toMatchObject({
      timeout_policy: "record-and-continue",
      analysis_timeout_ms: 450,
    });
    expect(parseApplicationGraphEvidence(evidence).ok).toBe(true);

    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.graph.coverage.status).toBe("partial");
    expect(result.graph.coverage.limits).toContainEqual({
      name: "javascript_analysis_worker_timeout_ms",
      value: 450,
      unit: "milliseconds",
    });
    expect(result.semantic_graph.coverage.status).toBe("partial");
    expect(result.statistics).toMatchObject({
      relevant_files: 3,
      parsed_javascript_files: 2,
    });

    const continuedUnknownsByPath = collectUnknownObservationsByPath(result);
    expect(continuedUnknownsByPath.get("m-vendor.js")).toMatchObject({
      operation: "analyze-javascript-source",
      analysis_status: "interrupted",
    });
    expect(continuedUnknownsByPath.has("z-routes.mjs")).toBe(false);

    expect(
      result.semantic_graph.nodes.map((node) => node.identity.module_path),
    ).toEqual(expect.arrayContaining(["a-entry.mjs", "z-routes.mjs"]));
    expect(result.route_inventory?.routes.map((entry) => entry.path)).toContain(
      "/recovered-health",
    );
  }, 30_000);
});
