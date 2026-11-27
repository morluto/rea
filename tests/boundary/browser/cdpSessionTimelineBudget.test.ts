import { expect, it, onTestFinished, vi } from "vitest";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { runWithAnalysisOperationSnapshot } from "../../../src/domain/analysisOperationSnapshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import type { ProgressUpdate } from "../../../src/ports/ProgressReporter.js";

const detail = "a".repeat(100);

const observeOverBudget = async (
  stage: 1 | 2,
  input: { readonly timeline_retained_bytes?: number },
) => {
  let seenLifecycleEvents = 0;
  let received: () => void = () => {};
  const delivered = new Promise<void>((resolve) => {
    received = resolve;
  });
  const onEvent = CdpConnection.prototype.onEvent;
  const delivery = vi
    .spyOn(CdpConnection.prototype, "onEvent")
    .mockImplementation(function (this: CdpConnection, listener) {
      return onEvent.call(this, (event) => {
        listener(event);
        if (event.registered?.method !== "Page.lifecycleEvent") return;
        seenLifecycleEvents += 1;
        if (seenLifecycleEvents === 4) received();
      });
    });
  const browser = await startFakeCdpBrowser({ commandEvents: () => [] });
  const provider = new CdpBrowserProvider();
  onTestFinished(async () => {
    delivery.mockRestore();
    await provider.close();
    await browser.close();
  });
  let terminalProgress = false;
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 5,
      ...input,
    }),
    {
      signal: AbortSignal.timeout(2_000),
      progress: {
        report: async (update: ProgressUpdate) => {
          if (update.completed === 2) terminalProgress = true;
          if (update.completed !== stage) return;
          for (const timestamp of [100, 101, 102, 103]) {
            browser.emitEvent({
              method: "Page.lifecycleEvent",
              sessionId: "session-1",
              params: {
                frameId: "frame-main",
                name: detail,
                timestamp,
              },
            });
          }
          await delivered;
        },
      },
    },
  );
  return { result, browser, terminalProgress };
};

const timelineLimit = {
  setting: "browser.timeline_retained_bytes",
  effective_value: 512,
  unit: "bytes",
  parameter: "timeline_retained_bytes",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};

it("fails an armed timeline that exceeds the per-call allowance", async () => {
  const { result, browser } = await observeOverBudget(1, {
    timeline_retained_bytes: 512,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "BrowserObservationError",
      reason: "payload_limit",
      detail: expect.stringContaining(
        "Armed timeline rows exceeded the 512-byte timeline allowance. Request identities keep a separate counter.",
      ),
      limit: { ...timelineLimit, source: "request", update_mode: "parameter" },
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const projected = projectAnalysisError(result.error);
  expect(projected.details?.limit).toMatchObject({
    ...timelineLimit,
    source: "request",
    update_mode: "parameter",
  });
  expect(projected.details?.limit).not.toHaveProperty("required_value");
  const measured = (
    projected.details?.reported_limits as
      | { measured_timeline_bytes?: number }
      | undefined
  )?.measured_timeline_bytes;
  expect(measured).toBeGreaterThan(512);
  expect(projected.remediation?.action).toContain("timeline_retained_bytes");
  expect(projected.remediation?.action).toContain("update_analysis_settings");
  expect(browser.commands.map(({ method }) => method)).toContain(
    "Target.detachFromTarget",
  );
});

it("fails when terminal progress admits a row past the timeline allowance", async () => {
  const { result, terminalProgress } = await observeOverBudget(2, {
    timeline_retained_bytes: 512,
  });
  expect(terminalProgress).toBe(true);
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "BrowserObservationError",
      reason: "payload_limit",
      limit: {
        setting: "browser.timeline_retained_bytes",
        effective_value: 512,
        source: "request",
      },
    },
  });
});

it("uses the runtime timeline allowance when the call omits it", async () => {
  const { result } = await runWithAnalysisOperationSnapshot(
    {
      revision: 1,
      overrides: { "browser.timeline_retained_bytes": 512 },
    },
    () => observeOverBudget(1, {}),
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      reason: "payload_limit",
      limit: {
        ...timelineLimit,
        source: "runtime",
        update_mode: "runtime",
      },
    },
  });
});
