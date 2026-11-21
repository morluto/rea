import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  NativeModuleResolver,
  type ModuleResolverLauncher,
} from "./NativeModuleResolver.js";
import { webModuleResolutionObservationSchema } from "../../domain/webModuleTrace.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";

import { completedModuleResolverLauncher } from "../../../tests/fixtures/webModuleTrace.js";
import {
  controlledCleanup,
  phaseGate,
} from "../../../tests/support/lifecycleHarness.js";

const input = {
  importerUrl: "https://app.test/main.js",
  importMap: null,
  specifiers: ["./dep.js"],
};
describe("native module resolver cleanup ownership", () => {
  it("awaits and closes the late browser connection after cancellation", async () => {
    for (const cleanupFails of [false, true]) {
      const controller = new AbortController();
      const reason = { request: "cancelled during browser handshake" };
      const cleanup = controlledCleanup({ refused: cleanupFails });
      const browser = {
        version: () => "fixture",
        newContext: () => {
          throw new Error("Unexpected context acquisition after cancellation");
        },
        close: () => cleanup.close(),
      };
      const handshake = phaseGate<void, typeof browser>();
      const provider = new NativeModuleResolver(
        { REA_BROWSER_EXECUTABLE: "/browser" },
        () => handshake.hold(),
      );
      const pending = provider.resolve(input, { signal: controller.signal });
      onTestFinished(async () => {
        handshake.release(browser);
        cleanup.allow();
        await pending.catch(() => undefined);
        await provider.close();
      });
      await handshake.reached(pending, "browser handshake");
      controller.abort(reason);
      await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.race([pending, null])).toBeNull();
      handshake.release(browser);

      const result = await pending;
      if (result.ok) throw new Error("Expected cancelled result");
      expect(cleanup.attempts).toBe(1);
      expect((result.error.cleanupPrimary ?? result.error).cause).toBe(reason);
      expect(projectAnalysisError(result.error).code).toBe(
        cleanupFails ? "cleanup_incomplete" : "cancelled",
      );
      expect(result.error.cleanupResources).toEqual(
        cleanupFails ? ["chromium-browser"] : [],
      );
      cleanup.allow();
      await provider.close();
      expect(cleanup.attempts).toBe(cleanupFails ? 2 : 1);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
    }
  });
});

describe("native module resolver cleanup retry", () => {
  it("retries retained browser cleanup before launching the next resolution", async () => {
    let launches = 0;
    const engineFailure = new Error("fixture context failure");
    const closeFailure = new Error("fixture owned cleanup refusal");
    const cleanup = controlledCleanup({ refused: true, failure: closeFailure });
    const retriedClose = phaseGate<number>();
    const completed = completedModuleResolverLauncher(input, async () => {});
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      async (...args) => {
        launches += 1;
        if (launches > 1) return completed(...args);
        return {
          version: () => "fixture",
          newContext: () => Promise.reject(engineFailure),
          close: () => cleanup.close(() => retriedClose.hold(launches)),
        };
      },
      "linux",
    );
    let retrying: ReturnType<NativeModuleResolver["resolve"]> | undefined;
    // Release the held close and join the gated request even when an
    // assertion fails while it is held.
    onTestFinished(async () => {
      cleanup.allow();
      retriedClose.release();
      await retrying?.catch(() => undefined);
      await provider.close();
    });
    const first = await provider.resolve(input);
    if (first.ok) throw new Error("expected retained browser cleanup");
    expect(first.error.cleanupResources).toEqual(["chromium-browser"]);
    expect(first.error.cleanupPrimary).toMatchObject({
      cause: engineFailure,
      remediationAction: undefined,
    });
    expect(projectAnalysisError(first.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          primary_error: {
            details: { diagnostics: { error_message: engineFailure.message } },
          },
          cleanup_error: {
            details: { diagnostics: { reason: closeFailure.message } },
          },
        },
      },
    });
    const blocked = await provider.resolve(input);
    if (blocked.ok) throw new Error("expected another retained close refusal");
    expect(blocked.error.cleanupResources).toEqual(["chromium-browser"]);
    expect(projectAnalysisError(blocked.error).code).toBe("cleanup_incomplete");
    expect(launches).toBe(1);
    cleanup.allow();
    retrying = provider.resolve(input);
    // The retained close is still running: no replacement browser yet.
    expect(
      await retriedClose.reached(retrying, "retained browser close retry"),
    ).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toBe(1);
    retriedClose.release();
    const retried = await retrying;
    if (!retried.ok) throw retried.error;
    expect(launches).toBe(2);
    for (const { error } of [first, blocked]) {
      expect(error.cleanupIncomplete).toBe(false);
      expect(error.cleanupResources).toEqual([]);
    }
    await provider.close();
    await provider.close();
    expect(cleanup.attempts).toBe(3);
  });
});

describe("native module resolver shutdown admission", () => {
  it("awaits acquisition and cleanup while refusing queued work during shutdown", async () => {
    const acquisition = phaseGate();
    const cleanup = phaseGate();
    let launches = 0;
    const completed = completedModuleResolverLauncher(input, () =>
      cleanup.hold(),
    );
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      async (options) => {
        launches += 1;
        await acquisition.hold();
        return completed(options);
      },
    );
    const first = provider.resolve(input);
    onTestFinished(async () => {
      acquisition.release();
      cleanup.release();
      await first;
      await provider.close();
    });
    await acquisition.reached(first, "browser launch in progress");
    const queued = provider.resolve(input);
    const closing = provider.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    acquisition.release();
    await cleanup.reached(first, "physical browser close in progress");
    expect(closed).toBe(false);
    cleanup.release();
    expect(await first).toMatchObject({ ok: true });
    await closing;
    expect(closed).toBe(true);
    for (const blocked of [await queued, await provider.resolve(input)]) {
      if (blocked.ok) throw new Error("expected shutdown admission refusal");
      expect(blocked.error.cleanupIncomplete).toBe(false);
      expect(blocked.error.cleanupResources).toEqual([]);
      expect(projectAnalysisError(blocked.error).code).toBe(
        "capability_unavailable",
      );
    }
    expect(launches).toBe(1);
  });
});

describe("optional native resolution acquisition", () => {
  it("distinguishes missing browser configuration from unusable selected paths", async () => {
    for (const executable of [undefined, "relative/chromium", ""]) {
      const provider = new NativeModuleResolver(
        { REA_BROWSER_EXECUTABLE: executable },
        () => {
          throw new Error("Unexpected browser launch");
        },
      );
      const result = await provider.resolve(input);
      if (result.ok) throw new Error("Expected configuration refusal");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "capability_unavailable",
        message: expect.stringContaining("REA_BROWSER_EXECUTABLE"),
        details:
          executable === undefined
            ? { reason: "missing_browser_executable" }
            : {
                reason: "invalid_browser_executable",
                diagnostics: { executable },
              },
      });
    }
  });
  it("does not acquire a browser after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = { request: "opaque admission cancellation" };
    controller.abort(reason);
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      () => {
        throw new Error("must not launch");
      },
    );
    const result = await provider.resolve(input, { signal: controller.signal });
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
  });
  it("retains the selected executable and actual startup diagnostic", async () => {
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/missing/browser" },
      () => Promise.reject(new Error("spawn EACCES fixture")),
    );
    const result = await provider.resolve(input);
    if (result.ok) throw new Error("expected startup failure");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: {
        executable: "/missing/browser",
        error_message: "spawn EACCES fixture",
      },
    });
  });
});

describe("native resolution Chromium sandbox", () => {
  it.each([
    { environment: {}, sandbox: true },
    { environment: { REA_BROWSER_NO_SANDBOX: "false" }, sandbox: true },
    { environment: { REA_BROWSER_NO_SANDBOX: "true" }, sandbox: false },
  ])(
    "launches Chromium with sandbox $sandbox for $environment",
    async ({ environment, sandbox }) => {
      let launchOptions: Parameters<ModuleResolverLauncher>[0] | undefined;
      const provider = new NativeModuleResolver(
        { REA_BROWSER_EXECUTABLE: "/browser", ...environment },
        (options) => {
          launchOptions = options;
          return Promise.reject(new Error("launch boundary reached"));
        },
        "linux",
      );
      const result = await provider.resolve(input);
      if (result.ok) throw new Error("expected startup failure");
      expect(launchOptions?.chromiumSandbox).toBe(sandbox);
      expect(launchOptions?.args).not.toContain("--no-sandbox");
      expect(result.error).toMatchObject({
        remediationAction: sandbox
          ? expect.stringContaining("REA_BROWSER_NO_SANDBOX=true")
          : undefined,
      });
    },
  );
});

describe("completed native resolution finalization", () => {
  it.each([false, true])(
    "retains the completed batch when final close is cancelled (close fails: %s)",
    async (cleanupFails) => {
      const controller = new AbortController();
      const reason = { request: "cancelled during final browser close" };
      let allowClose = !cleanupFails;
      let closes = 0;
      const report = {
        importer_url: input.importerUrl,
        entries: [
          {
            specifier: "./dep.js",
            resolution: { state: "resolved", url: "https://app.test/dep.js" },
          },
        ],
      };
      const launcher = completedModuleResolverLauncher(input, async () => {
        closes += 1;
        controller.abort(reason);
        if (!allowClose) throw new Error("controlled close refusal");
      });
      const provider = new NativeModuleResolver(
        { REA_BROWSER_EXECUTABLE: "/browser" },
        launcher,
      );
      const result = await provider.resolve(input, {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("expected cancelled finalization");
      expect(projectAnalysisError(result.error).code).toBe(
        cleanupFails ? "cleanup_incomplete" : "cancelled",
      );
      expect((result.error.cleanupPrimary ?? result.error).cause).toBe(reason);
      expect(
        webModuleResolutionObservationSchema.parse(
          result.error.partialObservation,
        ),
      ).toMatchObject({
        kind: "web-module-resolution",
        request: input,
        batch: {
          engine: { version: "controlled-browser" },
          resolutions: report.entries.map((entry) => entry.resolution),
          rawResult: { native_report: report, executable_path: "/browser" },
        },
      });
      if (cleanupFails) {
        await expect(provider.close()).rejects.toMatchObject({
          cleanupIncomplete: true,
        });
        expect(result.error.cleanupIncomplete).toBe(true);
        allowClose = true;
      }
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.cleanupResources).toEqual([]);
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
      expect(closes).toBe(cleanupFails ? 3 : 1);
    },
  );
});

it.each([
  { stage: "launch", reason: null },
  { stage: "launch", reason: new Error("opaque cancellation reason") },
  { stage: "context", reason: null },
  { stage: "context", reason: new Error("opaque cancellation reason") },
])(
  "preserves an independent $stage rejection when cancellation arrives before catch: $reason",
  async ({ stage, reason }) => {
    const controller = new AbortController();
    const physicalFailure = new Error("controlled SDK EIO");
    let closes = 0;
    const reject = () => {
      const rejected = Promise.reject(physicalFailure);
      queueMicrotask(() => controller.abort(reason));
      return rejected;
    };
    const provider = new NativeModuleResolver(
      { REA_BROWSER_EXECUTABLE: "/browser" },
      () =>
        stage === "launch"
          ? reject()
          : Promise.resolve({
              version: () => "controlled-browser",
              newContext: reject,
              close: async () => {
                closes += 1;
              },
            }),
    );
    const result = await provider.resolve(input, { signal: controller.signal });
    if (result.ok) throw new Error("expected independent rejection");
    expect(result.error).toMatchObject({
      _tag: "ProviderAdapterError",
      cause: physicalFailure,
    });
    expect(projectAnalysisError(result.error).code).not.toBe("cancelled");
    expect(result.error.secondaryFailures).toContainEqual(
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    );
    await provider.close();
    expect(closes).toBe(stage === "launch" ? 0 : 1);
  },
);

it.each(["caller", "deadline"] as const)(
  "attributes an in-flight SDK rejection to the owned %s stop",
  async (control) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const controller = new AbortController();
      const reason = { request: "cancel active browser operation" };
      const active = phaseGate<undefined, never>();
      let closes = 0;
      const provider = new NativeModuleResolver(
        { REA_BROWSER_EXECUTABLE: "/browser" },
        async () => ({
          version: () => "controlled-browser",
          newContext: () => active.hold(undefined),
          close: async () => {
            closes += 1;
            active.reject(new Error("controlled SDK target closed"));
          },
        }),
      );
      const pending = provider.resolve(input, { signal: controller.signal });
      onTestFinished(async () => {
        active.reject(new Error("test finished"));
        await pending;
        await provider.close();
      });
      await active.reached(pending, "active SDK call");
      if (control === "caller") controller.abort(reason);
      else await vi.advanceTimersByTimeAsync(20001);
      const result = await pending;
      if (result.ok) throw new Error("expected interrupted active call");
      expect(projectAnalysisError(result.error).code).toBe(
        control === "caller" ? "cancelled" : "provider_timeout",
      );
      if (control === "caller") expect(result.error.cause).toBe(reason);
      expect(result.error.partialObservation).toBeUndefined();
      await provider.close();
      expect(closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  },
);
