import { expect, it } from "vitest";
import { createUnityAddressablesFixture } from "../../domain/unity/unityAddressables.fixture.js";
import type { UnityAddressables } from "../../domain/unity/unityAddressables.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ok } from "../../domain/result.js";
import { UnityAddressablesService } from "./UnityAddressablesService.js";

const identity = {
  id: "fixture-addressables",
  name: "Source-owned Addressables reader seam",
  version: "1",
};
const report = createUnityAddressablesFixture();

const serviceReturning = (
  value: UnityAddressables,
  calls = { count: 0 },
  onInspect = () => {},
) =>
  new UnityAddressablesService({
    identity,
    inspect: () => {
      calls.count += 1;
      onInspect();
      return Promise.resolve(ok(value));
    },
  });

it("rejects relative paths, NUL bytes and extra arguments before reading", async () => {
  const calls = { count: 0 };
  const service = serviceReturning(report, calls);
  for (const input of [
    { path: "aa/catalog.bin", detail: "complete" },
    {
      path: report.artifact.path,
      hash_path: "catalog.hash",
      detail: "complete",
    },
    { path: "/artifacts/\0catalog.bin", detail: "complete" },
    { path: report.artifact.path, detail: "complete", download: true },
  ]) {
    const result = await service.inspect(input);
    expect(result).toMatchObject({
      ok: false,
      error: expect.any(AnalysisInputError),
    });
  }
  expect(calls.count).toBe(0);
});

it("refuses summary delivery without Evidence retention before reading", async () => {
  const calls = { count: 0 };
  const result = await serviceReturning(report, calls).inspect({
    path: report.artifact.path,
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(calls.count).toBe(0);
});

it.each([
  ["binary", "observed"],
  ["json", "derived"],
] as const)(
  "binds complete %s Evidence to the catalog with %s confidence",
  async (format, confidence) => {
    const value: UnityAddressables =
      format === "binary"
        ? report
        : {
            ...report,
            format: "json",
            format_version: null,
            dependency_basis: "key-locations",
            locations: report.locations.map((row) => ({
              ...row,
              offset: null,
              dependencies: [],
            })),
          };
    const result = await serviceReturning(value).inspect({
      path: report.artifact.path,
      detail: "complete",
    });
    if (!result.ok) throw result.error;
    expect(result.value.confidence).toBe(confidence);
    expect(result.value.parameters).toEqual({ path: report.artifact.path });
    expect(result.value.subject).toMatchObject({
      local_path: report.artifact.path,
      digest: { sha256: report.artifact.sha256 },
    });
  },
);

it("rejects a reader that changes the catalog or hash file identity", async () => {
  for (const [value, input] of [
    [
      { ...report, artifact: { ...report.artifact, path: "/other.bin" } },
      { path: report.artifact.path },
    ],
    [report, { path: report.artifact.path, hash_path: "/aa/catalog.hash" }],
  ] as const) {
    const result = await serviceReturning(value).inspect({
      ...input,
      detail: "complete",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
});

it("keeps the decoded Evidence when cancellation arrives during reading", async () => {
  const controller = new AbortController();
  const result = await serviceReturning(report, { count: 0 }, () =>
    controller.abort(new Error("stop")),
  ).inspect(
    { path: report.artifact.path, detail: "complete" },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(controller.signal.reason);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: { locator_id: report.locator_id },
  });
});

it("wraps a non-analysis close failure as provider cleanup", async () => {
  const service = new UnityAddressablesService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
    close: () => Promise.reject(new Error("handle stuck")),
  });
  await expect(service.close()).rejects.toBeInstanceOf(ProviderCleanupError);
});
