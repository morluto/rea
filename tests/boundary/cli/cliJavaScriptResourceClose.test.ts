import { afterEach, expect, it } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  closeCliJavaScriptResources,
  CliJavaScriptAnalysisHost,
  runCliJavaScriptApplicationAnalysis,
} from "../../../src/cli/javascriptApplicationAnalysis.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";

const originalClose = ArtifactResourceScope.prototype.close;

afterEach(async () => {
  ArtifactResourceScope.prototype.close = originalClose;
  await closeCliJavaScriptResources();
});

/** Create the process-owned scope without starting a worker. */
const openCliScope = (): Promise<unknown> =>
  runCliJavaScriptApplicationAnalysis({}, {});

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
  host.scope().addCloseHook(async () => {
    attempts += 1;
    if (denied) throw failure;
    failure.resolveCleanup();
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
