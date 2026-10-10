import { expect, it } from "vitest";

import { FlutterBuildAnalysisService } from "./FlutterBuildAnalysisService.js";
import type { FlutterBuildAnalysisPort } from "./FlutterBuildAnalysisPort.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";

const identity = {
  id: "flutter",
  name: "Flutter build identification",
  version: null,
};

const execution = createAnalysisExecution(
  {
    target: { path: "/targets/app.apk", bytes: 10, sha256: "a".repeat(64) },
    flutter_detected: true,
    abis: [],
    coverage: "complete",
  },
  identity,
);

const refusedPort: FlutterBuildAnalysisPort = {
  async inspectAvailability() {
    throw new Error("must not probe");
  },
  async close() {},
  async execute() {
    throw new Error("must not execute");
  },
};

it.each([[{ path: "/targets/app.apk", extra: true }], [{ path: 7 }], [{}]])(
  "rejects invalid identification input before any effect: %j",
  async (input) => {
    const service = new FlutterBuildAnalysisService(refusedPort);
    expect(
      await service.execute("identify_flutter_build", input),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  },
);

it("composes observed Evidence with the caller parameters inline", async () => {
  const port: FlutterBuildAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      expect(request).toEqual({
        operation: "identify_flutter_build",
        input: { path: "/targets/app.apk" },
      });
      return ok(execution);
    },
  };
  const result = await new FlutterBuildAnalysisService(port).execute(
    "identify_flutter_build",
    { path: "/targets/app.apk" },
  );
  if (!result.ok) throw new Error(result.error.message);
  const evidence = parseEvidence(result.value);
  expect(evidence.provider).toEqual(identity);
  expect(evidence.operation).toBe("identify_flutter_build");
  expect(evidence.confidence).toBe("observed");
});

it("preserves cancellation before execution", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await new FlutterBuildAnalysisService(refusedPort).execute(
    "identify_flutter_build",
    { path: "/targets/app.apk" },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});
