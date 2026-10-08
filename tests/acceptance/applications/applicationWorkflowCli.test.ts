import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
  JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";

const execute = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("JavaScript application path CLI", () => {
  it("accepts a relative local application path and preserves canonical Evidence identity", async () => {
    const root = await createTestTempDirectory("rea-relative-application-cli-");
    temporary.push(root);
    await writeFile(join(root, "app.js"), "export const value = 1;\n");
    const absolute = await analyzeJavaScriptApplication({ input_path: root });
    if (!absolute.ok) throw absolute.error;
    const absoluteAnalysis = javascriptApplicationAnalysisResultSchema.parse(
      absolute.value.normalized_result,
    );

    const relativePath = relative(process.cwd(), root);
    const fromCli = await runCli([
      "analyze-javascript-application",
      relativePath,
      "--json",
    ]);

    expect(fromCli).toMatchObject({
      evidence_id: absolute.value.evidence_id,
      normalized_result: {
        input_path: absoluteAnalysis.input_path,
      },
      subject: { local_path: absolute.value.subject?.local_path },
    });
  }, 20_000);
});

describe("application workflow CLI parity", () => {
  it("accepts inline trace JSON and file-backed comparison JSON", async () => {
    const traced = await runCli([
      "trace-application-feature",
      JSON.stringify(JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE),
      "--json",
    ]);
    expect(traced).toMatchObject({
      operation: "trace_application_feature",
      predicate_type: "rea.application-feature-trace",
      normalized_result: {
        seed: { kind: "module", value: "renderer.js", match: "exact" },
        summary: {
          matched_seeds: 1,
          traced_nodes: 1,
          traced_edges: 0,
          terminal_paths: 0,
          native_handoffs: 0,
          observed_facts: 1,
          inferred_facts: 0,
          unknown_facts: 0,
          unavailable_facts: 0,
        },
        coverage: {
          status: "complete-within-source",
          source_graph_status: "complete",
          total_seed_matches: 1,
        },
      },
    });

    const root = await createTestTempDirectory("rea-application-cli-");
    temporary.push(root);
    const comparisonPath = join(root, "comparison.json");
    await writeFile(
      comparisonPath,
      JSON.stringify(JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE),
    );
    const compared = await runCli([
      "compare-application-versions",
      comparisonPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_application_versions",
      predicate_type: "rea.application-version-comparison",
      normalized_result: {
        summary: {
          unchanged: 0,
          added: 2,
          removed: 0,
          changed: 1,
          unknown: 0,
        },
        coverage: {
          left_graph_status: "complete",
          right_graph_status: "complete",
          left_graph_omitted_count: 0,
          right_graph_omitted_count: 0,
          status: "complete-within-inputs",
        },
      },
    });
    const sourceCompared = await runCli([
      "compare-source-to-bundle",
      JSON.stringify({
        reference: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference,
        application: JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
      }),
      "--json",
    ]);
    expect(sourceCompared).toMatchObject({
      operation: "compare_source_to_bundle",
      predicate_type: "rea.source-to-bundle-comparison",
      normalized_result: {
        reference: { inventory_state: "complete" },
        summary: {
          unchanged: 0,
          modified: 0,
          removed: 1,
          split: 0,
          merged: 0,
          duplicated: 0,
          unknown: 0,
        },
        coverage: {
          status: "complete-within-inputs",
          reference_inventory_state: "complete",
          application_graph_status: "complete",
          retained_source_files: 1,
          retained_application_nodes: 1,
        },
      },
    });
  }, 20_000);

  // The inline Evidence argument exceeds the Windows command-line limit.
  it.skipIf(process.platform === "win32")(
    "traces the same authenticated semantic graph through the CLI",
    async () => {
      const root = await createTestTempDirectory("rea-semantic-cli-");
      temporary.push(root);
      await writeFile(
        join(root, "app.js"),
        "function add(value) { return value + 1; } add(2);",
      );
      const analyzed = await analyzeJavaScriptApplication({
        input_path: root,
      });
      if (!analyzed.ok) throw analyzed.error;
      const result = javascriptApplicationAnalysisResultSchema.parse(
        analyzed.value.normalized_result,
      );
      const seed = result.semantic_graph.relations[0]?.source_node_id;
      if (seed === undefined)
        throw new TypeError("Expected at least one semantic relation");

      const traced = await runCli([
        "trace-javascript-semantics",
        JSON.stringify({
          application: analyzed.value,
          query: {
            seed: { kind: "semantic-node", node_id: seed },
            direction: "forward-influence",
            include_ambiguous_dynamic_edges: true,
          },
        }),
        "--json",
      ]);
      expect(traced).toMatchObject({
        operation: "trace_javascript_semantics",
        predicate_type: "rea.javascript-semantic-trace",
        normalized_result: {
          source_evidence_id: analyzed.value.evidence_id,
          source_graph_id: result.semantic_graph.graph_id,
        },
      });
    },
    20_000,
  );
});

describe("rest parameter semantic trace CLI", () => {
  // The inline Evidence argument exceeds the Windows command-line limit.
  it.skipIf(process.platform === "win32")(
    "traces each ordinary rest argument to its parameter through public application Evidence",
    async () => {
      const root = await createTestTempDirectory("rea-rest-arguments-cli-");
      await writeFile(
        join(root, "app.js"),
        "function collect(first, ...rest) { return rest; } collect('first', 'second', 'third');",
      );
      const application = await runCli([
        "analyze-javascript-application",
        root,
        "--json",
      ]);
      const analyzed = await analyzeJavaScriptApplication({ input_path: root });
      if (!analyzed.ok) throw analyzed.error;
      const graph = javascriptApplicationAnalysisResultSchema.parse(
        analyzed.value.normalized_result,
      ).semantic_graph;
      for (const index of [1, 2]) {
        const argument = graph.nodes.find(
          ({ kind, label }) =>
            kind === "expression" && label === `argument ${String(index)}`,
        );
        if (argument === undefined) throw new Error("Missing argument node");
        const traced = await runCli([
          "trace-javascript-semantics",
          JSON.stringify({
            application,
            query: {
              seed: { kind: "semantic-node", node_id: argument.node_id },
              direction: "forward-influence",
              allowed_relations: ["argument-to-parameter"],
              expected: { role: "sink", classes: ["parameter"] },
            },
          }),
          "--json",
        ]);
        expect(traced).toMatchObject({
          normalized_result: {
            status: "found",
            nodes: expect.arrayContaining([
              expect.objectContaining({ kind: "parameter", label: "rest" }),
            ]),
          },
        });
      }
    },
    20_000,
  );
});

describe("empty property key application CLI", () => {
  it.each(["const root = routes[''];", "const {'': root} = routes;"])(
    "analyzes a root-route dictionary with %s",
    async (read) => {
      const root = await createTestTempDirectory("rea-empty-key-cli-");
      await writeFile(
        join(root, "app.js"),
        `const routes = {'': 'HOME'}; ${read}`,
      );
      const evidence = await runCli([
        "analyze-javascript-application",
        root,
        "--json",
      ]);
      expect(evidence).toMatchObject({
        operation: "analyze_javascript_application",
        normalized_result: {
          semantic_graph: {
            nodes: expect.arrayContaining([
              expect.objectContaining({
                kind: "property-slot",
                label: '""',
                properties: expect.objectContaining({ name: "" }),
              }),
            ]),
          },
        },
      });
    },
    20_000,
  );
});

describe("application workflow CLI input", () => {
  it("rejects Evidence ID-only workflow inputs", async () => {
    const result = await runCli([
      "compare-application-versions",
      JSON.stringify({
        left: JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left
          .evidence_id,
        right:
          JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right.evidence_id,
      }),
      "--json",
    ]);
    expect(result).toMatchObject({ code: "invalid_request" });
  });
});

describe("application workflow CLI export Evidence", () => {
  it("compares exact export shapes from file-backed Evidence", async () => {
    const root = await createTestTempDirectory("rea-export-shape-cli-");
    temporary.push(root);
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser.mjs"),
        join(leftRoot, "parser.mjs"),
      ),
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser-v2.mjs"),
        join(rightRoot, "parser.mjs"),
      ),
    ]);
    const [left, right] = await Promise.all([
      analyzeJavaScriptApplication({
        input_path: leftRoot,
      }),
      analyzeJavaScriptApplication({
        input_path: rightRoot,
      }),
    ]);
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    const inputPath = join(root, "comparison.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        left: left.value,
        right: right.value,
        left_module_path: "parser.mjs",
        left_export_name: "default",
        right_module_path: "parser.mjs",
        right_export_name: "default",
      }),
    );
    const compared = await runCli([
      "compare-javascript-export-shapes",
      inputPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_javascript_export_shapes",
      predicate_type: "rea.javascript-export-shape-comparison",
      normalized_result: {
        summary: { added: 1, removed: 0, changed: 0, unknown: 0 },
        changes: [
          {
            status: "added",
            path: "/depth",
            right: { availability: "literal", value: 1 },
          },
        ],
      },
    });
  }, 20_000);
});

describe("application workflow CLI validation", () => {
  it("returns safe actionable JSON validation details", async () => {
    const malformed = await runCli([
      "trace-application-feature",
      "{not-json",
      "--json",
    ]);
    expect(malformed).toMatchObject({
      code: "invalid_request",
      retryable: true,
      details: {
        issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
      },
    });
    expect(JSON.stringify(malformed)).not.toContain("not-json");

    const missing = await runCli(["trace-application-feature", "{}", "--json"]);
    expect(missing).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["seed"],
            reason: "missing_argument",
          }),
        ]),
      },
    });
  }, 20_000);
});

const runCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...environment },
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};
