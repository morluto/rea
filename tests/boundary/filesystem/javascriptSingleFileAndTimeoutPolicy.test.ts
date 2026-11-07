import { createHash } from "node:crypto";
import { realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";
import { z } from "zod";

import { analyzeAndAdoptJavaScriptArtifactFiles } from "../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { createJavaScriptRuntimeObservationEvidence } from "../../../src/application/javascript/JavaScriptRuntimeObservationEvidence.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { createJavaScriptSemanticGraphProjection } from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  type JavaScriptApplicationAnalysisResult,
  javascriptApplicationAnalysisResultSchema,
} from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { javascriptRuntimeObservationSchema } from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { err } from "../../../src/domain/result.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "../../../src/inspector/providerIdentity.js";
import { JavaScriptAnalysisWorker } from "../../../src/javascript/analysis/JavaScriptAnalysisWorker.js";
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

const makeJavaScriptFile = (
  path: string,
  value: string,
): JavaScriptArtifactFile => ({
  path,
  container_sha256: "1".repeat(64),
  sha256: createHash("sha256").update(value).digest("hex"),
  bytes: Buffer.byteLength(value),
  inventory_artifact_id: `fixture-${path}`,
  kind: "javascript",
  unpacked: false,
  text: { included: true, value },
});

const createV8InspectorEvidence = (
  targetFilePath: string,
  scriptFilePaths: readonly string[],
) => {
  const observation = javascriptRuntimeObservationSchema.parse({
    runtime: {
      product: "node.js/v24.22.1",
      protocol_version: "1.3",
      v8_version: null,
    },
    target: {
      target_id: "node-single-file",
      protocol_type: "node",
      attached: true,
      location: { kind: "file", file_path: targetFilePath },
      runtime_kind: "node",
      runtime_kind_authority: "caller-declared-unverified",
    },
    capture: {
      observation_ms: 100,
      events_observed: scriptFilePaths.length,
      events_retained: scriptFilePaths.length,
      events_dropped: 0,
      metadata_bytes_retained: 0,
      truncated: false,
      truncation_reasons: [],
    },
    scripts: {
      items: scriptFilePaths.map((filePath, index) => ({
        script_key: `v8_script_${String(index + 1)
          .repeat(64)
          .slice(0, 64)}`,
        location: { kind: "file", file_path: filePath },
        execution_context_key: null,
        cdp_hash: null,
        length: null,
        is_module: true,
        status: "observed-loaded",
      })),
      observed_total: scriptFilePaths.length,
      excluded: { unsupported_location: 0, invalid_protocol_value: 0 },
    },
    execution_contexts: [],
    directly_observed: [],
    unavailable_without_instrumentation: [],
    unknowns: ["Synthetic V8 Inspector capture."],
    limitations: ["Synthetic fixture without source bytes."],
  });
  return createJavaScriptRuntimeObservationEvidence(
    "observe_javascript_runtime",
    {
      inspector_endpoint: "http://127.0.0.1:9229",
      target_id: "node-single-file",
      runtime_kind: "node",
      observation_ms: 100,
    },
    observation,
    V8_INSPECTOR_PROVIDER_IDENTITY,
  );
};

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
    expect(result.route_inventory?.routes.map((entry) => entry.path)).toContain(
      expectedRoute,
    );
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

it("reconciles exact same-file V8 Inspector scripts without authorizing sibling files", async () => {
  const root = await createTestTempDirectory("rea-js-single-file-reconcile-");
  const canonicalRoot = await realpath(root);
  const bundlePath = join(canonicalRoot, "bundle.mjs");
  const siblingPath = join(canonicalRoot, "sibling.mjs");
  await Promise.all([
    writeFile(
      bundlePath,
      'export const loadLazy = () => import("./lazy.mjs");\n',
    ),
    writeFile(siblingPath, "export const sibling = 1;\n"),
  ]);

  const analysisOutcome = await analyzeJavaScriptApplication({
    input_path: bundlePath,
  });
  if (!analysisOutcome.ok) throw analysisOutcome.error;

  const reconciled = reconcileJavaScriptRuntimeEvidence({
    static_layers: [{ role: "application", analysis: analysisOutcome.value }],
    runtime_observations: [
      createV8InspectorEvidence(bundlePath, [bundlePath, siblingPath]),
    ],
  });
  if (!reconciled.ok) throw reconciled.error;
  const result = javascriptRuntimeReconciliationResultSchema.parse(
    reconciled.value.evidence.normalized_result,
  );
  const scriptMatches = result.reconciliations.filter(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(scriptMatches).toHaveLength(2);
  expect(scriptMatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "matched",
        basis: "artifact-path",
        reason: "unique-location-match",
      }),
      expect.objectContaining({
        status: "unknown",
        basis: "none",
        reason: "no-authorized-location-mapping",
      }),
    ]),
  );
  expect(result.static_load_states).toContainEqual(
    expect.objectContaining({
      kind: "javascript-asset",
      status: "loaded",
      reason: "runtime-script-correspondence",
    }),
  );

  const targetOnly = reconcileJavaScriptRuntimeEvidence({
    static_layers: [{ role: "application", analysis: analysisOutcome.value }],
    runtime_observations: [createV8InspectorEvidence(bundlePath, [])],
  });
  if (!targetOnly.ok) throw targetOnly.error;
  const targetOnlyResult = javascriptRuntimeReconciliationResultSchema.parse(
    targetOnly.value.evidence.normalized_result,
  );
  expect(targetOnlyResult.static_load_states).toContainEqual(
    expect.objectContaining({
      kind: "javascript-asset",
      status: "unknown",
      reason: "static-or-runtime-coverage-incomplete",
    }),
  );
  expect(
    targetOnlyResult.static_load_states.some(
      ({ kind, reason }) =>
        kind === "javascript-module" &&
        reason === "layer-outside-runtime-scope",
    ),
  ).toBe(true);

  const aliasPath = join(canonicalRoot, "alias-entry.tsx");
  await symlink(bundlePath, aliasPath);
  const aliasAnalysis = await analyzeJavaScriptApplication({
    input_path: aliasPath,
  });
  if (!aliasAnalysis.ok) throw aliasAnalysis.error;
  const aliasReconciled = reconcileJavaScriptRuntimeEvidence({
    static_layers: [{ role: "application", analysis: aliasAnalysis.value }],
    runtime_observations: [createV8InspectorEvidence(bundlePath, [bundlePath])],
  });
  if (!aliasReconciled.ok) throw aliasReconciled.error;
  const aliasResult = javascriptRuntimeReconciliationResultSchema.parse(
    aliasReconciled.value.evidence.normalized_result,
  );
  expect(
    aliasResult.reconciliations.find(
      ({ entity_kind }) => entity_kind === "script",
    ),
  ).toMatchObject({
    status: "matched",
    basis: "artifact-path",
    reason: "unique-location-match",
  });
});

it("deterministically stops by default and continues across remaining files under a controlled worker port", async () => {
  const files = [
    makeJavaScriptFile(
      "a-entry.mjs",
      'export function bootEntry() { return "ready"; }\n',
    ),
    makeJavaScriptFile("m-vendor.js", "export const slowVendor = true;\n"),
    makeJavaScriptFile(
      "z-routes.mjs",
      'export function registerHealthRoute(router) { router.push("/recovered-health"); }\n',
    ),
  ];
  const fileSet: JavaScriptArtifactFileSet = {
    files,
    unavailable_relevant_files: [],
    containers: [],
    text_bytes_read: files.reduce((sum, file) => sum + file.bytes, 0),
    invalid_utf8_files: 0,
  };

  const realWorker = new JavaScriptAnalysisWorker({
    heapMb: 128,
    timeoutMs: 30_000,
  });
  try {
    const runWithPolicy = async (policy: "stop" | "record-and-continue") => {
      const calls: string[] = [];
      const projection = createJavaScriptSemanticGraphProjection();
      const controlledPort = {
        analyze: async (
          ...args: Parameters<JavaScriptAnalysisWorker["analyze"]>
        ) => {
          const [file] = args;
          calls.push(file.path);
          if (file.path === "m-vendor.js") {
            return err({
              javascript: null,
              module: null,
              projection: null,
              error: new AnalysisTimeoutError(
                "analyze_javascript_application",
                450,
              ),
            });
          }
          return realWorker.analyze(...args);
        },
      };
      const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
        fileSet,
        controlledPort,
        projection,
        async () => {},
        undefined,
        undefined,
        new Set(),
        [],
        policy,
      );
      return { calls, outcome, projection };
    };

    const stopped = await runWithPolicy("stop");
    expect(stopped.calls).toEqual(["a-entry.mjs", "m-vendor.js"]);
    expect(stopped.outcome.interruption).toBeInstanceOf(AnalysisTimeoutError);
    const stoppedStatuses = new Map(
      stopped.outcome.analysis.files.map((entry) => [
        entry.file.path,
        entry.analysis_failure?.status ?? "completed",
      ]),
    );
    expect(stoppedStatuses.get("a-entry.mjs")).toBe("completed");
    expect(stoppedStatuses.get("m-vendor.js")).toBe("interrupted");
    expect(stoppedStatuses.get("z-routes.mjs")).toBe("not-started");

    const continued = await runWithPolicy("record-and-continue");
    expect(continued.calls).toEqual([
      "a-entry.mjs",
      "m-vendor.js",
      "z-routes.mjs",
    ]);
    expect(continued.outcome.interruption).toBeNull();
    const continuedByPath = new Map(
      continued.outcome.analysis.files.map((entry) => [entry.file.path, entry]),
    );
    expect(continuedByPath.get("m-vendor.js")?.analysis_failure).toMatchObject({
      status: "interrupted",
      limits: { worker_timeout_ms: 450 },
    });
    expect(continuedByPath.get("z-routes.mjs")?.javascript?.parse_status).toBe(
      "complete",
    );
  } finally {
    await realWorker.close();
  }
});

it("recovers with a fresh real worker subprocess after a phase-gated timeout when timeout_policy is record-and-continue", async () => {
  const root = await createTestTempDirectory("rea-js-timeout-policy-");
  await Promise.all([
    writeFile(
      join(root, "a-entry.mjs"),
      'export function bootEntry() { return "ready"; }\n',
    ),
    writeFile(
      join(root, "m-vendor.js"),
      "export function vendorOnly() { return 1; }\n",
    ),
    writeFile(
      join(root, "z-routes.mjs"),
      [
        "export function registerHealthRoute(router) {",
        '  router.push("/recovered-health");',
        "}",
      ].join("\n") + "\n",
    ),
  ]);

  const timeoutMs = 3_000;
  const gateVendorPhase = {
    report: async (event: {
      readonly phase: string;
      readonly message: string;
    }) => {
      if (
        event.phase === "javascript_worker_parse" &&
        event.message.endsWith(": m-vendor.js")
      ) {
        await delay(timeoutMs + 150);
      }
    },
  };

  const stopped = await analyzeJavaScriptApplication(
    {
      input_path: root,
      max_heap_mb: 256,
      analysis_timeout_ms: timeoutMs,
    },
    { progress: gateVendorPhase },
  );
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

  const continued = await analyzeJavaScriptApplication(
    {
      input_path: root,
      max_heap_mb: 256,
      analysis_timeout_ms: timeoutMs,
      timeout_policy: "record-and-continue",
    },
    { progress: gateVendorPhase },
  );
  if (!continued.ok) throw continued.error;

  const evidence = parseEvidence(continued.value);
  expect(evidence.parameters).toMatchObject({
    timeout_policy: "record-and-continue",
    analysis_timeout_ms: timeoutMs,
  });
  expect(parseApplicationGraphEvidence(evidence).ok).toBe(true);

  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  expect(result.graph.coverage.status).toBe("partial");
  expect(result.graph.coverage.limits).toContainEqual({
    name: "javascript_analysis_worker_timeout_ms",
    value: timeoutMs,
    unit: "milliseconds",
  });
  expect(result.semantic_graph.coverage.status).toBe("partial");
  expect(result.statistics).toMatchObject({
    relevant_files: 3,
  });

  const continuedUnknownsByPath = collectUnknownObservationsByPath(result);
  expect(continuedUnknownsByPath.get("m-vendor.js")).toMatchObject({
    operation: "analyze-javascript-source",
    analysis_status: "interrupted",
  });
  expect(continuedUnknownsByPath.has("z-routes.mjs")).toBe(false);

  const functionModules = result.semantic_graph.nodes
    .filter((node) => node.kind === "function")
    .map((node) => node.identity.module_path);
  expect(functionModules).not.toContain("m-vendor.js");
  expect(functionModules).toEqual(
    expect.arrayContaining(["a-entry.mjs", "z-routes.mjs"]),
  );
  expect(result.route_inventory?.routes.map((entry) => entry.path)).toContain(
    "/recovered-health",
  );
}, 30_000);
