import {
  phaseArrival,
  phaseGate,
} from "../../tests/support/lifecycleHarness.js";
import { expect, it } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";

import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import type {
  AnalyzeWebBundleInput,
  WebBundleAnalysis,
} from "../domain/webBundleAnalysis.js";
import {
  analyzeWebBundleInputSchema,
  webBundleScriptTimeoutRecovery,
} from "../domain/webBundleAnalysis.js";
import { analyzeCapturedWebScript } from "../domain/webBundleAnalyzer.js";
import { unavailableWebScriptRecovery } from "../domain/webBundleScriptAnalysis.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { OwnedWorkerRuntime } from "../process/OwnedWorkerRuntime.js";
import { err, ok } from "../domain/result.js";
import {
  IsolatedWebBundleAnalyzer,
  WebBundleAnalysisAdmission,
  type WebBundleAnalysisWorkerPort,
} from "./IsolatedWebBundleAnalyzer.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";
import { javaScriptMemberMutationRefusal } from "../domain/javascript/javascriptSemanticWorkAllowance.js";

const origin = "https://app.example.test";
const noSourceMaps: WebBundleAnalysis["observations"]["source_maps"] = {
  status: "not_requested",
  requested: 0,
  processed: 0,
  items: [],
};
const input: AnalyzeWebBundleInput = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  target_id: "page-1",
  include_script_sources: true,
});

it("preserves completed prefix and suffix facts when one script times out", async () => {
  const captured = inspection([
    "import './prefix.js'; fetch('/prefix');",
    "function stalled() {}",
    "import './suffix.js'; fetch('/suffix');",
  ]);
  const calls: string[] = [];
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script) => {
      calls.push(script.script_key);
      if (calls.length === 2)
        return err({
          // The worker's per-script deadline, inside a total that has time left.
          error: new AnalysisTimeoutError(
            "analyze_web_bundle",
            5,
            webBundleScriptTimeoutRecovery(5),
          ),
          completed: null,
        });
      return ok(analyzeCapturedWebScript(script));
    },
    close: async () => {},
  }));
  expect((await analyzer.reserve()).ok).toBe(true);

  const result = await analyzer.analyze(captured, noSourceMaps, input);
  analyzer.releaseReservation();

  expect(calls).toEqual(
    captured.scripts.items.map(({ script_key }) => script_key),
  );
  if (!result.ok) throw result.error;
  expect(
    result.value.observations.chunks.edges.map(({ specifier }) => specifier),
  ).toEqual(["./prefix.js", "./suffix.js"]);
  expect(result.value.observations.endpoints.map(({ value }) => value)).toEqual(
    ["/prefix", "/suffix"],
  );
  expect(result.value.completeness).toMatchObject({
    status: "partial",
    parsed_scripts: 2,
    parse_failures: 0,
  });
  // The partial result records the per-call control by contract field; it
  // names no adapter spelling.
  const timedOut = result.value.unknowns.find(
    ({ dimension }) => dimension === "javascript_analysis",
  );
  expect(timedOut).toEqual({
    dimension: "javascript_analysis",
    reason: expect.stringContaining("deadline"),
    affected_script_keys: [captured.scripts.items[1]?.script_key],
    limit: {
      control_kind: "parameter",
      parameter: "analysis_timeout_ms",
      effective_value: 5,
      unit: "ms",
      minimum: expect.any(Number),
      maximum: expect.any(Number),
      default_value: expect.any(Number),
      applies_at: "next_call",
    },
    remediation: expect.stringContaining("analysis_timeout_ms"),
  });
  expect(JSON.stringify(timedOut)).not.toContain("--");
});

it("keeps per-script refusal coverage and any completed facts under the selected allowance", async () => {
  const refused = [
    "/* __webpack_require__ */ function probe(input, env) { var m; if (env.first) m = env.first.info;",
    ...Array.from(
      { length: 4 },
      (_, index) =>
        `if (/case${String(index)}/.test(input)) m = m[${String(index % 2)}];`,
    ),
    "m[1] = input.length; var c = new Map(); c.get('k'); fetch('/hidden'); return m; }",
  ].join(" ");
  const captured = inspection([
    "fetch('/kept');",
    refused,
    "fetch('/unavailable');",
  ]);
  const keys = captured.scripts.items.map(({ script_key }) => script_key);
  const allowance = { aliasStates: 8, source: "runtime" } as const;
  const refusal = javaScriptMemberMutationRefusal(
    "analyze_web_bundle",
    allowance,
  );
  const received: unknown[] = [];
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script, _timeout, _signal, precision, selected) => {
      received.push(selected);
      if (script.script_key === keys[2])
        return err({ error: refusal, completed: null });
      const facts = analyzeCapturedWebScript(script, precision, selected);
      // The worker parent states the refusal from the allowance it sent.
      return ok(
        facts.status === "unavailable"
          ? { ...facts, ...unavailableWebScriptRecovery(refusal) }
          : facts,
      );
    },
    close: async () => {},
  }));
  expect((await analyzer.reserve()).ok).toBe(true);
  const result = await analyzer.analyze(
    captured,
    noSourceMaps,
    input,
    undefined,
    allowance,
  );
  analyzer.releaseReservation();
  if (!result.ok) throw result.error;
  expect(received).toEqual([allowance, allowance, allowance]);
  const refusedKey = keys[1];
  expect(result.value.completeness).toMatchObject({
    status: "partial",
    parsed_scripts: 2,
    parse_failures: 0,
  });
  expect(result.value.inferences).toContainEqual(
    expect.objectContaining({
      kind: "bundle_runtime",
      value: "webpack",
      basis: [expect.objectContaining({ script_key: refusedKey })],
    }),
  );
  expect(result.value.observations.endpoints.map(({ value }) => value)).toEqual(
    ["/kept"],
  );
  const limit = expect.objectContaining({
    setting: "javascript.member_mutation_alias_states",
    effective_value: 8,
    source: "runtime",
  });
  const unknowns = result.value.unknowns.filter(
    ({ dimension }) => dimension === "javascript_analysis",
  );
  expect(unknowns).toEqual([
    {
      dimension: "javascript_analysis",
      reason: expect.stringContaining("resource_constraint"),
      affected_script_keys: [refusedKey],
      limit,
      remediation: refusal.remediationAction,
      refused_phase: "member-mutations",
    },
    {
      dimension: "javascript_analysis",
      reason: expect.stringContaining("resource_constraint"),
      affected_script_keys: [keys[2]],
      limit,
      remediation: refusal.remediationAction,
    },
  ]);
});

it("marks the unstarted suffix when the aggregate deadline expires", async () => {
  const captured = inspection([
    "fetch('/prefix');",
    "fetch('/stalled');",
    "fetch('/not-started');",
  ]);
  const calls: string[] = [];
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script, _timeout, signal) => {
      calls.push(script.script_key);
      if (calls.length === 1) return ok(analyzeCapturedWebScript(script));
      await waitForAbort(signal);
      return err({
        error: new AnalysisTimeoutError("analyze_web_bundle", 50),
        completed: null,
      });
    },
    close: async () => {},
  }));
  expect((await analyzer.reserve()).ok).toBe(true);

  const result = await analyzer.analyze(captured, noSourceMaps, {
    ...input,
    total_analysis_timeout_ms: 50,
  });

  analyzer.releaseReservation();

  expect(calls).toEqual(
    captured.scripts.items.slice(0, 2).map(({ script_key }) => script_key),
  );
  if (result.ok) throw new Error("Expected total deadline failure");
  expect(result.error._tag).toBe("AnalysisTimeoutError");
  expect(result.error.partialObservation).toMatchObject({
    completeness: { status: "partial", parsed_scripts: 1 },
    observations: { endpoints: [{ value: "/prefix" }] },
  });
  expect(result.error.partialObservation).toMatchObject({
    unknowns: expect.arrayContaining([
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [captured.scripts.items[1]?.script_key],
      }),
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [captured.scripts.items[2]?.script_key],
      }),
    ]),
  });
});

it("stops after a middle-script result-capacity failure and retains prefix facts", async () => {
  const captured = inspection([
    "import './prefix.js'; fetch('/prefix');",
    "fetch('/capacity-blocked');",
    "fetch('/must-not-start');",
  ]);
  const calls: string[] = [];
  const caller = new AbortController();
  const cancellation = new Error("later cancellation during final close");
  const primary = new AnalysisResourceConstraintError(
    "analyze_web_bundle",
    "memory",
    "No result capacity remains",
    { result_bytes: 0 },
  );
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script) => {
      calls.push(script.script_key);
      if (calls.length === 1) return ok(analyzeCapturedWebScript(script));
      return err({
        error: primary,
        completed: null,
        continuation: "result_capacity_exhausted",
      });
    },
    close: async () => {
      caller.abort(cancellation);
    },
  }));
  expect((await analyzer.reserve()).ok).toBe(true);

  const result = await analyzer.analyze(
    captured,
    noSourceMaps,
    input,
    caller.signal,
  );
  analyzer.releaseReservation();

  expect(calls).toEqual(
    captured.scripts.items.slice(0, 2).map(({ script_key }) => script_key),
  );
  if (result.ok) throw new Error("Expected result-capacity failure");
  expect(result.error).toBe(primary);
  expect(result.error.secondaryFailures).toContainEqual(
    expect.objectContaining({
      _tag: "AnalysisCancelledError",
      cause: cancellation,
    }),
  );
  expect(result.error.partialObservation).toMatchObject({
    completeness: { status: "partial", parsed_scripts: 1 },
    observations: {
      chunks: { edges: [{ specifier: "./prefix.js" }] },
      endpoints: [{ value: "/prefix" }],
    },
    unknowns: expect.arrayContaining([
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [captured.scripts.items[1]?.script_key],
      }),
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [captured.scripts.items[2]?.script_key],
      }),
    ]),
  });
});

it("carries the exact caller cancellation reason and completed prefix facts", async () => {
  const captured = inspection([
    "fetch('/prefix');",
    "fetch('/cancelled');",
    "fetch('/cancelled-suffix');",
  ]);
  const started = phaseArrival();
  const controller = new AbortController();
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script, _timeout, signal) => {
      if (script.script_key === captured.scripts.items[0]?.script_key)
        return ok(analyzeCapturedWebScript(script));
      started.arrive();
      await waitForAbort(signal);
      return err({
        error: new AnalysisCancelledError("analyze_web_bundle", {
          cause: signal?.reason,
        }),
        completed: null,
      });
    },
    close: async () => {},
  }));
  expect((await analyzer.reserve()).ok).toBe(true);
  const exactReason = new Error("caller stopped analysis");
  const pending = analyzer.analyze(
    captured,
    noSourceMaps,
    input,
    controller.signal,
  );
  let result: Awaited<typeof pending>;
  try {
    await started.reached(pending, "script analysis");
    controller.abort(exactReason);
    result = await pending;
  } finally {
    controller.abort(exactReason);
    try {
      await pending;
    } finally {
      analyzer.releaseReservation();
    }
  }

  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(exactReason);
  expect(result.error.partialObservation).toMatchObject({
    completeness: { status: "partial", parsed_scripts: 1 },
    observations: { endpoints: [{ value: "/prefix" }] },
    unknowns: expect.arrayContaining([
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [captured.scripts.items[1]?.script_key],
      }),
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [captured.scripts.items[2]?.script_key],
      }),
    ]),
  });
});

it("refuses work after close with REA's own cancellation reason, not an absent one", async () => {
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script) => ok(analyzeCapturedWebScript(script)),
    close: async () => {},
  }));
  await analyzer.close();
  const captured = inspection(["fetch('/one');"]);

  const reserved = await analyzer.reserve();
  const analyzed = await analyzer.analyze(captured, noSourceMaps, input);

  for (const result of [reserved, analyzed]) {
    if (result.ok) throw new Error("Closed analyzer accepted work");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(OwnerCancellation.ownerClosed);
  }
  if (analyzed.ok) throw new Error("Closed analyzer accepted work");
  expect(analyzed.error.partialObservation).toBe(captured);
});

it("retains all completed facts when cancellation arrives during worker close", async () => {
  const captured = inspection(["fetch('/one');", "fetch('/two');"]);
  const workerClose = phaseGate();
  const analyzer = new IsolatedWebBundleAnalyzer(() => ({
    analyze: async (script) => ok(analyzeCapturedWebScript(script)),
    close: async () => {
      await workerClose.hold();
    },
  }));
  expect((await analyzer.reserve()).ok).toBe(true);
  const pending = analyzer.analyze(captured, noSourceMaps, input);
  try {
    await workerClose.reached(pending, "worker close");
    const closing = analyzer.close();
    workerClose.release();
    await closing;
    const result = await pending;
    if (result.ok) throw new Error("Expected cancellation during finalization");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      completeness: { status: "complete", parsed_scripts: 2 },
      observations: { endpoints: [{ value: "/one" }, { value: "/two" }] },
    });
  } finally {
    workerClose.release();
    await pending.finally(() => analyzer.close());
    analyzer.releaseReservation();
  }
});

it("retains cleanup ownership after mixed worker/close failure and resolves it on retry", async () => {
  const captured = inspection(["fetch('/partial');"]);
  const primary = new ProviderCleanupError(
    "web-bundle-static-analysis",
    ["worker-job"],
    { reason: "analysis cleanup pending" },
    { operation: "analyze_web_bundle" },
  );
  const closeFailure = new ProviderCleanupError(
    "web-bundle-static-analysis",
    ["worker-root"],
    { reason: "worker close pending" },
    { operation: "analyze_web_bundle" },
  );
  let closeAttempts = 0;
  const admission = new WebBundleAnalysisAdmission();
  const analyzer = new IsolatedWebBundleAnalyzer(
    () => ({
      analyze: async () => err({ error: primary, completed: null }),
      close: async () => {
        closeAttempts += 1;
        if (closeAttempts <= 2) throw closeFailure;
        releaseOwnedCleanup(closeFailure);
        releaseOwnedCleanup(primary);
      },
    }),
    admission,
  );
  expect((await analyzer.reserve()).ok).toBe(true);

  const result = await analyzer.analyze(captured, noSourceMaps, input);
  if (result.ok) throw new Error("Expected mixed failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupPrimary).toBe(primary);
  expect(result.error.cleanupResources).toEqual(["worker-job", "worker-root"]);
  expect(result.error.partialObservation).toMatchObject({
    completeness: { status: "partial", parsed_scripts: 0 },
  });

  const replacement = new IsolatedWebBundleAnalyzer(
    () => inertWorker(),
    admission,
  );
  analyzer.releaseReservation();
  const blocked = await replacement.reserve();
  expect(blocked.ok).toBe(false);

  await analyzer.close();
  expect(closeAttempts).toBe(3);
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
  expect((await replacement.reserve()).ok).toBe(true);
  replacement.releaseReservation();
});

it("shares a capture reservation within one admission and isolates independent owners", async () => {
  const admission = new WebBundleAnalysisAdmission();
  const first = new IsolatedWebBundleAnalyzer(() => inertWorker(), admission);
  const second = new IsolatedWebBundleAnalyzer(() => inertWorker(), admission);
  const independent = new IsolatedWebBundleAnalyzer(() => inertWorker());
  expect((await first.reserve()).ok).toBe(true);
  expect((await independent.reserve()).ok).toBe(true);
  const blocked = await second.reserve();
  if (blocked.ok) throw new Error("Expected shared admission refusal");
  expect(projectAnalysisError(blocked.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "capacity",
      reported_limits: { concurrent_web_bundle_analyses: 1 },
    },
  });
  first.releaseReservation();
  expect((await second.reserve()).ok).toBe(true);
  second.releaseReservation();
  independent.releaseReservation();
});

it("does not fail one admission's analysis when another host's worker runtime is retained", async () => {
  let fail = true;
  const stuck = new OwnedWorkerRuntime({
    rootPrefix: "rea-web-host-isolation-",
    retryCleanup: async () => {
      if (fail) throw new Error("other host still owns its worker");
    },
  });
  stuck.retainForCleanup();
  try {
    const analyzed: string[] = [];
    const analyzer = new IsolatedWebBundleAnalyzer(() => ({
      analyze: async (script) => {
        analyzed.push(script.script_key);
        return ok(analyzeCapturedWebScript(script));
      },
      close: async () => {},
    }));
    expect((await analyzer.reserve()).ok).toBe(true);
    const captured = inspection(["fetch('/independent');"]);
    const result = await analyzer.analyze(captured, noSourceMaps, input);
    expect(result.ok).toBe(true);
    expect(analyzed).toEqual(
      captured.scripts.items.map(({ script_key }) => script_key),
    );
    if (result.ok)
      expect(result.value.observations.endpoints).toMatchObject([
        { value: "/independent" },
      ]);
    analyzer.releaseReservation();
    await expect(OwnedWorkerRuntime.retryPending()).rejects.toThrow(
      "other host still owns its worker",
    );
  } finally {
    fail = false;
    await stuck.close();
  }
});

const inertWorker = (): WebBundleAnalysisWorkerPort => ({
  analyze: async () =>
    err({
      error: new AnalysisOutputError("analyze_web_bundle", "unused"),
      completed: null,
    }),
  close: async () => {},
});

const waitForAbort = (signal: AbortSignal | undefined): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
};

const inspection = (sources: readonly string[]) =>
  createWebPageInspection(
    sources.map((source, index) => ({
      source,
      scriptKey: `scr_${String(index + 1).repeat(64)}`,
      url: `${origin}/assets/${String(index)}.js`,
      origin,
      cdpHash: `hash-${String(index)}`,
    })),
  );
