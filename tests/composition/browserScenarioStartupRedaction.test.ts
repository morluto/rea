import { BrowserObservationError } from "../../src/domain/browserObservationError.js";
import { PlaywrightScenarioSession } from "../../src/browser/PlaywrightScenarioSession.js";
import { chromium, type BrowserContext } from "playwright-core";
import { expect, it, vi } from "vitest";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
import { controlledCleanup, phaseGate } from "../support/lifecycleHarness.js";
import { captureBrowserScenario } from "../../src/application/BrowserScenarioCaptureService.js";
import { createBrowserScenarioProvider } from "../../src/composition/browserScenario.js";
import { browserScenarioSchema } from "../../src/domain/browserScenario.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../../src/domain/analysisErrorBase.js";

const startupScenario = (
  secrets: readonly { secret_id: string; environment_variable: string }[],
) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://app.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    secrets,
  });

it.each([
  { late: false, secret: "browser_profile" },
  { late: false, secret: "startup private/value" },
  { late: true, secret: "browser_profile" },
])(
  "excludes declared startup secrets across opening cleanup and retries: %j",
  async ({ late, secret }) => {
    const scenario = startupScenario([
      { secret_id: "credential", environment_variable: "REA_STARTUP_SECRET" },
    ]);
    const diagnosticSecret = encodeURIComponent(secret).replace(
      /%[0-9A-F]{2}/gu,
      (escape) => escape.toLowerCase(),
    );
    const cleanup = controlledCleanup({
      refused: true,
      failure: new Error(`startup cleanup failed ${diagnosticSecret}`),
    });
    // An unusable launch reply fails before a PlaywrightScenarioSession exists.
    const context = {
      browser: () => null,
      close: cleanup.close,
    } as unknown as BrowserContext;
    const opening = phaseGate<void, BrowserContext>();
    if (!late) opening.release(context);
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockImplementation(() => opening.hold());
    const provider = createBrowserScenarioProvider({
      REA_STARTUP_SECRET: secret,
    });
    if (provider.close === undefined)
      throw new Error("Production scenario provider must expose cleanup");
    const closeProvider = provider.close.bind(provider);
    const cancellation = new AbortController();
    const reason = { caller: "cancelled opening" };
    let capturing: ReturnType<typeof captureBrowserScenario> | undefined;
    await withVerifierCleanup(async () => {
      capturing = captureBrowserScenario(provider, scenario, {
        signal: cancellation.signal,
      });
      await opening.reached(capturing, "browser launch");
      if (late) cancellation.abort(reason);
      const result = await capturing;
      if (result.ok) throw new Error("Expected startup failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      const initialProjection = JSON.stringify(
        projectAnalysisError(result.error),
      );
      expect(initialProjection).not.toContain(secret);
      expect(initialProjection).not.toContain(diagnosticSecret);
      if (!late && secret === "browser_profile")
        expect(result.error.cleanupResources).toContain(
          "[REDACTED:credential]",
        );
      if (late) {
        expect(primaryAnalysisError(result.error).cause).toBe(reason);
        expect(projectAnalysisError(result.error).code).toBe(
          "cleanup_incomplete",
        );
        opening.release(context);
      }
      let retry: unknown;
      try {
        await closeProvider();
      } catch (error) {
        retry = error;
      }
      if (!(retry instanceof AnalysisError))
        throw new Error("Expected retained startup cleanup failure");
      expect(retry.cleanupIncomplete).toBe(true);
      const projected = projectAnalysisError(retry);
      expect(projected).toMatchObject({
        code: "cleanup_incomplete",
        details: { resources: expect.arrayContaining(["browser_transport"]) },
      });
      const retryProjection = JSON.stringify(projected);
      expect(retryProjection).not.toContain(secret);
      expect(retryProjection).not.toContain(diagnosticSecret);
      if (secret === "browser_profile")
        expect(retry.cleanupResources).toContain("[REDACTED:credential]");
      expect(cleanup.attempts).toBeGreaterThan(0);
      cleanup.allow();
      await closeProvider();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(retry.cleanupIncomplete).toBe(false);
      expect(result.error.cleanupResources).toEqual([]);
    }, [
      () => {
        cleanup.allow();
        opening.release(context);
      },
      async () => {
        await capturing;
      },
      closeProvider,
      () => launch.mockRestore(),
    ]);
  },
);

it.each([false, true])(
  "preserves the original startup failure when no effective secret is declared: %s",
  async (emptyDeclaration) => {
    const scenario = startupScenario(
      emptyDeclaration
        ? [{ secret_id: "empty", environment_variable: "REA_EMPTY_SECRET" }]
        : [],
    );
    const original = new BrowserObservationError(
      "capture_browser_scenario",
      "protocol_error",
      { detail: "ordinary observed startup failure" },
    );
    const close = vi.fn(async () => undefined);
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        browser: () => {
          throw original;
        },
        close,
      } as unknown as BrowserContext);
    try {
      await expect(
        PlaywrightScenarioSession.open(scenario, { REA_EMPTY_SECRET: "" }, {}),
      ).rejects.toBe(original);
      expect(close).toHaveBeenCalledOnce();
      expect(original.cleanupIncomplete).toBe(false);
    } finally {
      launch.mockRestore();
    }
  },
);
