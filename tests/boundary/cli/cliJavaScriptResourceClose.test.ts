import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  closeCliJavaScriptResources,
  CliJavaScriptAnalysisHost,
  runCliJavaScriptApplicationAnalysis,
} from "../../../src/cli/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const originalClose = ArtifactResourceScope.prototype.close;

afterEach(async () => {
  ArtifactResourceScope.prototype.close = originalClose;
  await closeCliJavaScriptResources();
});

/** Create the process-owned scope without starting a worker. */
const openCliScope = (): Promise<unknown> =>
  runCliJavaScriptApplicationAnalysis({}, {});

it.each([false, true])(
  "retains completed JavaScript Evidence when final cleanup fails (cancelled=%s)",
  async (cancelled) => {
    const root = await createTestTempDirectory("cli-js-cleanup-evidence-");
    await writeFile(join(root, "index.js"), "export const answer = 42;\n");
    const host = new CliJavaScriptAnalysisHost();
    const controller = new AbortController();
    const retry = vi
      .spyOn(host.scope(), "retryCleanup")
      .mockImplementationOnce(async () => {
        if (cancelled) controller.abort("stop after analysis");
        throw new Error("cleanup failed");
      });
    try {
      const result = await runCliJavaScriptApplicationAnalysis(
        { input_path: root },
        {},
        controller.signal,
        undefined,
        host,
      );
      expect(result).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          partial_observation: {
            operation: "analyze_javascript_application",
            normalized_result: { input_path: root },
          },
        },
      });
      if (cancelled)
        expect(result).toMatchObject({
          details: { diagnostics: { primary_error: { code: "cancelled" } } },
        });
    } finally {
      retry.mockRestore();
      await host.close();
    }
  },
);

it("retains completed JavaScript Evidence when cancellation arrives during final cleanup", async () => {
  const root = await createTestTempDirectory("cli-js-cancel-evidence-");
  await writeFile(join(root, "index.js"), "export const answer = 42;\n");
  const host = new CliJavaScriptAnalysisHost();
  const controller = new AbortController();
  const retry = vi
    .spyOn(host.scope(), "retryCleanup")
    .mockImplementationOnce(async () => {
      controller.abort("stop after analysis");
    });
  try {
    const result = await runCliJavaScriptApplicationAnalysis(
      { input_path: root },
      {},
      controller.signal,
      undefined,
      host,
    );
    expect(result).toMatchObject({
      code: "cancelled",
      details: {
        partial_observation: {
          operation: "analyze_javascript_application",
          normalized_result: { input_path: root },
        },
      },
    });
  } finally {
    retry.mockRestore();
    await host.close();
  }
});

it("retries JavaScript worker shutdown when the first close fails", async () => {
  let calls = 0;
  ArtifactResourceScope.prototype.close = function (
    this: ArtifactResourceScope,
  ) {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("worker still owned"));
    return originalClose.call(this);
  };

  await openCliScope();
  await expect(closeCliJavaScriptResources()).rejects.toThrow(
    "worker still owned",
  );
  expect(calls).toBe(1);
  await closeCliJavaScriptResources();
  expect(calls).toBe(2);
  await closeCliJavaScriptResources();
  expect(calls).toBe(2);
});

it("shares one in-flight JavaScript worker shutdown between callers", async () => {
  let calls = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  ArtifactResourceScope.prototype.close = function (
    this: ArtifactResourceScope,
  ) {
    calls += 1;
    return gate.then(() => originalClose.call(this));
  };

  try {
    await openCliScope();
    const first = closeCliJavaScriptResources();
    const second = closeCliJavaScriptResources();
    expect(second).toBe(first);
    expect(calls).toBe(1);
    release();
    await first;
    expect(calls).toBe(1);
  } finally {
    release();
  }
});
