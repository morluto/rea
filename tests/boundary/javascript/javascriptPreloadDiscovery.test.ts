import { beforeEach, expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
} from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { analyzeParsedJavaScriptStaticSource } from "../../../src/domain/javascript/javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "../../../src/domain/javascript/javascriptSourceParser.js";
import { ok, err } from "../../../src/domain/result.js";
import { discoverJavaScriptPreloadPaths } from "../../../src/application/javascript/JavaScriptPreloadDiscovery.js";
const acquire = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../src/artifacts/javascript/JavaScriptSourceAnalysis.js",
  () => ({
    createJavaScriptSourceAnalysis: acquire,
  }),
);
const file = (
  path: string,
  text: string,
  container = "a".repeat(64),
): JavaScriptArtifactFile => ({
  path,
  container_sha256: container,
  sha256: "b".repeat(64),
  bytes: text.length,
  inventory_artifact_id: path,
  kind: path.endsWith("json") ? "package-json" : "javascript",
  unpacked: false,
  text: { included: true, value: text },
});
const declaration =
  'import { BrowserWindow } from "electron"; import { fileURLToPath } from "node:url"; new BrowserWindow({webPreferences:{sandbox:false,preload:fileURLToPath(new URL("./preload.js",import.meta.url))}});';
const fixture = (): JavaScriptArtifactFileSet => ({
  files: [
    file("package.json", '{"type":"module"}'),
    file("preload.js", 'require("./helper.cjs");'),
    file("main.mjs", declaration),
  ],
  unavailable_relevant_files: [],
  containers: [],
  text_bytes_read: 0,
  invalid_utf8_files: 0,
});
const limits = { heapMb: 128, timeoutMs: 5000 };
const close = vi.fn(async () => {});
const analyze = vi.fn(
  async (
    source: JavaScriptArtifactFile,
    _capacity: unknown,
    _signal: AbortSignal | undefined,
    _phase: unknown,
    packageType: "module" | "commonjs" | "unknown" | "unspecified",
  ) => {
    const parsed = parseJavaScriptSource(
      source.text.included ? source.text.value : "",
      source.path,
      packageType,
    )!;
    return ok({
      javascript: analyzeParsedJavaScriptStaticSource(
        source.text.included ? source.text.value : "",
        parsed,
      ),
      module: null,
      projection: null,
    });
  },
);
beforeEach(() => {
  close.mockReset();
  analyze.mockClear();
  acquire.mockReset();
  acquire.mockResolvedValue({ analyze, close });
});
it("resolves an exact preload before its declaring source regardless of inventory order", async () => {
  const result = await discoverJavaScriptPreloadPaths(
    fixture(),
    limits,
    new ArtifactResourceScope(),
  );
  expect([...result]).toEqual(["a".repeat(64) + ":preload.js"]);
  expect(close).toHaveBeenCalledOnce();
  expect(analyze.mock.calls.every((call) => call[2] === undefined)).toBe(true);
});
it("does not turn an invalid ESM require declaration into a preload identity", async () => {
  const files = fixture();
  const source = file(
    "main.js",
    'const { BrowserWindow } = require("electron"); new BrowserWindow({webPreferences:{preload:"preload.js"}});',
  );
  expect(
    await discoverJavaScriptPreloadPaths(
      { ...files, files: [...files.files.slice(0, 2), source] },
      limits,
      new ArtifactResourceScope(),
    ),
  ).toEqual(new Set());
});
it("does not transfer preload identity across containers", async () => {
  const files = fixture();
  expect(
    await discoverJavaScriptPreloadPaths(
      {
        ...files,
        files: files.files.map((source) =>
          source.path === "preload.js"
            ? { ...source, container_sha256: "c".repeat(64) }
            : source,
        ),
      },
      limits,
      new ArtifactResourceScope(),
    ),
  ).toEqual(new Set());
});
it("skips discovery when package scope cannot change a .js loader", async () => {
  const files = fixture();
  await discoverJavaScriptPreloadPaths(
    {
      ...files,
      files: [
        file("package.json", '{"type":"commonjs"}'),
        ...files.files.slice(1),
      ],
    },
    limits,
    new ArtifactResourceScope(),
  );
  expect(acquire).not.toHaveBeenCalled();
});
it("retains a failed close and the original cancellation until scope cleanup retries", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  const failure = new AnalysisCancelledError("analyze_javascript_application", {
    cause: reason,
  });
  const failingAnalyze = vi.fn(async () =>
    err({ error: failure, javascript: null, module: null, projection: null }),
  );
  close.mockRejectedValueOnce(new Error("close denied"));
  acquire.mockResolvedValue({ analyze: failingAnalyze, close });
  const scope = new ArtifactResourceScope();
  await expect(
    discoverJavaScriptPreloadPaths(fixture(), limits, scope, controller.signal),
  ).rejects.toMatchObject({
    cleanupIncomplete: true,
    cause: expect.objectContaining({
      errors: expect.arrayContaining([failure]),
    }),
  });
  expect(scope.hasPending).toBe(true);
  expect(failingAnalyze.mock.calls).toHaveLength(1);
  await scope.retryCleanup();
  expect(scope.hasPending).toBe(false);
  expect(close).toHaveBeenCalledTimes(2);
});
