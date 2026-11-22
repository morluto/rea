import { describe, expect, it } from "vitest";
import { analyzeAndAdoptJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";
import { parseApplicationGraphEvidence } from "./JavaScriptApplicationEvidenceGraph.js";
import { preloadTargetKey } from "./JavaScriptPreloadDiscovery.js";
import { reconcileJavaScriptRuntimeEvidence } from "./JavaScriptRuntimeReconciliationService.js";
import { createJavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import { fileSubjectTarget } from "../../../tests/fixtures/evidenceSubject.js";
import { analyzeParsedJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { JAVASCRIPT_FEATURE_TRACE_EXAMPLE } from "../../contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  immutableEvidence,
  isImmutableEvidence,
} from "../../domain/evidence.js";
import { isImmutableJsonSnapshot } from "../../domain/immutableJson.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  parseJavaScriptSource,
  type JavaScriptPackageType,
} from "../../domain/javascript/javascriptSourceParser.js";
import { err, ok } from "../../domain/result.js";

const container = "a".repeat(64);
const hash = "b".repeat(64);

const includedFile = (
  path: string,
  kind: JavaScriptArtifactFile["kind"],
  text: string,
): JavaScriptArtifactFile => ({
  path,
  container_sha256: container,
  sha256: hash,
  bytes: Buffer.byteLength(text),
  inventory_artifact_id: path,
  kind,
  unpacked: false,
  text: { included: true, value: text },
});

const fileSetFor = (
  files: readonly JavaScriptArtifactFile[],
): JavaScriptArtifactFileSet => ({
  files,
  unavailable_relevant_files: [],
  containers: [],
  text_bytes_read: 0,
  invalid_utf8_files: 0,
});

const countingStaticWorker = (
  calls: { path: string; packageType: JavaScriptPackageType | undefined }[],
) => ({
  analyze: async (
    file: JavaScriptArtifactFile,
    _capacity: unknown,
    _signal?: AbortSignal,
    _onPhase?: unknown,
    packageType?: JavaScriptPackageType,
  ) => {
    calls.push({ path: file.path, packageType });
    const text = file.text.included ? file.text.value : "";
    const parsed = parseJavaScriptSource(text, file.path, packageType);
    if (parsed === null)
      return err({
        error: new AnalysisResourceConstraintError(
          "analyze_javascript_application",
          "capacity",
          "source-parse-skipped",
          { parent_result_budget_exhausted: false },
        ),
        javascript: null,
        module: null,
        projection: null,
      });
    return ok({
      javascript: analyzeParsedJavaScriptStaticSource(text, parsed),
      module: null,
      projection: null,
    });
  },
});

const esmPreloadWindow = (relativePreload: string): string =>
  `import { BrowserWindow } from "electron"; import { fileURLToPath } from "node:url"; new BrowserWindow({webPreferences:{sandbox:false,preload:fileURLToPath(new URL(${JSON.stringify(relativePreload)},import.meta.url))}});`;

describe("single-pass optimistic preload discovery", () => {
  it("analyzes non-preload files once and re-analyzes only discovered .js preloads", async () => {
    const files = [
      includedFile("package.json", "package-json", '{"type":"module"}'),
      includedFile(
        "a-preload.js",
        "javascript",
        'const { ipcRenderer } = require("electron"); ipcRenderer.send("secret", 1);',
      ),
      includedFile("b-lib.js", "javascript", "export const libValue = 1;"),
      includedFile(
        "z-main.mjs",
        "javascript",
        esmPreloadWindow("./a-preload.js"),
      ),
    ];
    const autoCalls: {
      path: string;
      packageType: JavaScriptPackageType | undefined;
    }[] = [];
    const autoOutcome = await analyzeAndAdoptJavaScriptArtifactFiles(
      fileSetFor(files),
      countingStaticWorker(autoCalls),
      createJavaScriptSemanticGraphProjection(),
      async () => {},
    );
    expect(autoOutcome.interruption).toBeNull();
    expect(autoCalls).toEqual([
      { path: "a-preload.js", packageType: "module" },
      { path: "b-lib.js", packageType: "module" },
      { path: "z-main.mjs", packageType: "module" },
      { path: "a-preload.js", packageType: "commonjs" },
    ]);

    const explicitCalls: {
      path: string;
      packageType: JavaScriptPackageType | undefined;
    }[] = [];
    const preloadTarget = files[1];
    if (preloadTarget === undefined) throw new Error("Missing preload file");
    const explicitOutcome = await analyzeAndAdoptJavaScriptArtifactFiles(
      fileSetFor(files),
      countingStaticWorker(explicitCalls),
      createJavaScriptSemanticGraphProjection(),
      async () => {},
      undefined,
      undefined,
      new Set([preloadTargetKey(preloadTarget)]),
    );
    expect({
      visited_ast_nodes: autoOutcome.analysis.visited_ast_nodes,
      findings: autoOutcome.analysis.findings,
      modules: autoOutcome.analysis.modules,
      parse_failures: autoOutcome.analysis.parse_failures,
    }).toEqual({
      visited_ast_nodes: explicitOutcome.analysis.visited_ast_nodes,
      findings: explicitOutcome.analysis.findings,
      modules: explicitOutcome.analysis.modules,
      parse_failures: explicitOutcome.analysis.parse_failures,
    });
    expect(autoOutcome.analysis.files).toEqual(explicitOutcome.analysis.files);
    expect(autoOutcome.analysis.limitations).toEqual(
      explicitOutcome.analysis.limitations,
    );
  });

  it("avoids Pass-2 re-analysis when main precedes preload or no preloads exist", async () => {
    const mainFirstFiles = [
      includedFile("package.json", "package-json", '{"type":"module"}'),
      includedFile(
        "a-main.mjs",
        "javascript",
        esmPreloadWindow("./z-preload.js"),
      ),
      includedFile(
        "z-preload.js",
        "javascript",
        'const { ipcRenderer } = require("electron"); ipcRenderer.send("ok", 1);',
      ),
    ];
    const mainFirstCalls: {
      path: string;
      packageType: JavaScriptPackageType | undefined;
    }[] = [];
    await analyzeAndAdoptJavaScriptArtifactFiles(
      fileSetFor(mainFirstFiles),
      countingStaticWorker(mainFirstCalls),
      createJavaScriptSemanticGraphProjection(),
      async () => {},
    );
    expect(mainFirstCalls).toEqual([
      { path: "a-main.mjs", packageType: "module" },
      { path: "z-preload.js", packageType: "commonjs" },
    ]);

    const noPreloadCalls: {
      path: string;
      packageType: JavaScriptPackageType | undefined;
    }[] = [];
    await analyzeAndAdoptJavaScriptArtifactFiles(
      fileSetFor([
        includedFile("package.json", "package-json", '{"type":"module"}'),
        includedFile("a.js", "javascript", "export const a = 1;"),
        includedFile("b.js", "javascript", "export const b = 2;"),
      ]),
      countingStaticWorker(noPreloadCalls),
      createJavaScriptSemanticGraphProjection(),
      async () => {},
    );
    expect(noPreloadCalls).toEqual([
      { path: "a.js", packageType: "module" },
      { path: "b.js", packageType: "module" },
    ]);
  });
});

describe("transitive preload discovery and Pass-1 limitations", () => {
  it("handles transitive preloads and preserves Pass-1 discovery failure limitations", async () => {
    const files = [
      includedFile("package.json", "package-json", '{"type":"module"}'),
      includedFile("a-nested.js", "javascript", "exports.nested = 1;"),
      includedFile(
        "b-preload.js",
        "javascript",
        'const path = require("node:path"); const { BrowserWindow } = require("electron"); new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "a-nested.js") } });',
      ),
      includedFile("c-broken.js", "javascript", "export const ok = 1;"),
      includedFile(
        "z-main.mjs",
        "javascript",
        esmPreloadWindow("./b-preload.js"),
      ),
    ];
    const calls: {
      path: string;
      packageType: JavaScriptPackageType | undefined;
    }[] = [];
    const base = countingStaticWorker(calls);
    const worker = {
      analyze: async (
        file: JavaScriptArtifactFile,
        capacity: unknown,
        signal?: AbortSignal,
        onPhase?: unknown,
        packageType?: JavaScriptPackageType,
      ) => {
        if (file.path === "c-broken.js") {
          calls.push({ path: file.path, packageType });
          return err({
            error: new AnalysisResourceConstraintError(
              "analyze_javascript_application",
              "file-size",
              "parse skipped by limit",
              { source_max_bytes: 1 },
            ),
            javascript: null,
            module: null,
            projection: null,
          });
        }
        return base.analyze(file, capacity, signal, onPhase, packageType);
      },
    };
    const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
      fileSetFor(files),
      worker,
      createJavaScriptSemanticGraphProjection(),
      async () => {},
    );
    expect(outcome.interruption).toBeNull();
    expect(calls).toEqual([
      { path: "a-nested.js", packageType: "module" },
      { path: "b-preload.js", packageType: "module" },
      { path: "c-broken.js", packageType: "module" },
      { path: "z-main.mjs", packageType: "module" },
      { path: "b-preload.js", packageType: "commonjs" },
      { path: "a-nested.js", packageType: "commonjs" },
    ]);
    expect(outcome.analysis.limitations).toContainEqual(
      expect.stringMatching(/^Preload discovery could not read c-broken\.js /u),
    );
  });
});

describe("immutable Evidence graph WeakMap caching", () => {
  it("memoizes bundle-loaded and reconciled immutable Evidence with sealed graphs", () => {
    const original = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
    const bundleEvidence = immutableEvidence(
      createEvidence(fileSubjectTarget(original.subject), original.provider, {
        operation: original.operation,
        predicateType: original.predicate_type,
        parameters: original.parameters,
        result: structuredClone(original.normalized_result),
        confidence: original.confidence,
        authority: original.authority,
      }),
    );
    expect(isImmutableEvidence(bundleEvidence)).toBe(true);
    const firstStatic = parseApplicationGraphEvidence(bundleEvidence);
    const secondStatic = parseApplicationGraphEvidence(bundleEvidence);
    if (!firstStatic.ok || !secondStatic.ok)
      throw new Error("Expected valid bundle Evidence");
    expect(firstStatic.value).toBe(secondStatic.value);
    expect(isImmutableJsonSnapshot(firstStatic.value.graph)).toBe(true);
    expect(isImmutableJsonSnapshot(firstStatic.value.semanticGraph)).toBe(true);

    const reconciled = reconcileJavaScriptRuntimeEvidence(
      JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE,
    );
    if (!reconciled.ok) throw reconciled.error;
    const cachedRuntime = parseApplicationGraphEvidence(
      reconciled.value.evidence,
    );
    if (!cachedRuntime.ok)
      throw new Error("Expected cached reconciled Evidence");
    expect(isImmutableJsonSnapshot(cachedRuntime.value.graph)).toBe(true);
    expect(isImmutableJsonSnapshot(cachedRuntime.value.semanticGraph)).toBe(
      true,
    );
  });
});
