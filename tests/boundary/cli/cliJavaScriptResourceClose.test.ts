import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { closeCliResources } from "../../../src/cli/cliResources.js";
import {
  CliJavaScriptAnalysisHost,
  runCliJavaScriptApplicationAnalysis,
} from "../../../src/cli/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";

const originalClose = ArtifactResourceScope.prototype.close;

afterEach(async () => {
  ArtifactResourceScope.prototype.close = originalClose;
  await closeCliResources();
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

it("keeps the primary analysis error when one-shot finalization fails and retains its owner for retry", async () => {
  const host = new CliJavaScriptAnalysisHost("invocation");
  let denied = true;
  let attempts = 0;
  const failure = new ProviderCleanupError(
    "javascript-static-analysis",
    ["fixture-worker"],
    { reason: "controlled inspection denial" },
    { operation: "analyze_javascript_application" },
  );
  let released = false;
  failure.bindCleanupReleaseClaim({
    get cleanupReleased() {
      return released;
    },
  });
  host.scope().addCloseHook(async () => {
    attempts += 1;
    if (denied) throw failure;
    released = true;
  });
  try {
    const result = await runCliJavaScriptApplicationAnalysis(
      {},
      {},
      undefined,
      undefined,
      host,
    );
    expect(attempts).toBe(1);
    expect(result).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        execution_failure: "invalid_request",
        resources: ["fixture-worker"],
        diagnostics: { primary_error: { code: "invalid_request" } },
      },
    });
    expect(failure.cleanupIncomplete).toBe(true);
    denied = false;
    await host.close();
    expect(attempts).toBe(2);
    expect(failure.cleanupIncomplete).toBe(false);
  } finally {
    denied = false;
    await host.close();
  }
});

it("retries JavaScript worker shutdown when the first close fails", async () => {
  await closeCliResources();
  let calls = 0;
  ArtifactResourceScope.prototype.close = function (
    this: ArtifactResourceScope,
  ) {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("worker still owned"));
    return originalClose.call(this);
  };

  await openCliScope();
  await expect(closeCliResources()).rejects.toThrow("worker still owned");
  expect(calls).toBe(1);
  await closeCliResources();
  expect(calls).toBe(2);
  await closeCliResources();
  expect(calls).toBe(2);
});

it("preserves the pre-delivery retry and final close retry before projecting the primary", async () => {
  const host = new CliJavaScriptAnalysisHost("invocation");
  let attempts = 0;
  host.scope().retain({
    kind: "lease",
    resource: "fixture-retained-resource",
    lease: {
      release: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("controlled first retry failure");
      },
    },
  });
  try {
    const result = await runCliJavaScriptApplicationAnalysis(
      {},
      {},
      undefined,
      undefined,
      host,
    );
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ code: "invalid_request" });
  } finally {
    await host.close();
  }
});

it("shares one in-flight JavaScript worker shutdown between callers", async () => {
  await closeCliResources();
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
    const first = closeCliResources();
    const second = closeCliResources();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  } finally {
    release();
  }
});
