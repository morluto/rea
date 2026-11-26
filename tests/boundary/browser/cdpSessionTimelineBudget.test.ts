import { expect, it, onTestFinished, vi } from "vitest";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

// Scale only the existing retained-event allowance to exercise refusal without
// allocating megabytes. The real session owner and producer parser run.
vi.mock("../../../src/domain/webRuntime.js", async (importOriginal) => {
  const domain =
    await importOriginal<typeof import("../../../src/domain/webRuntime.js")>();
  return {
    ...domain,
    WEB_RUNTIME_LIMITS: {
      ...domain.WEB_RUNTIME_LIMITS,
      retainedEventBytes: 512,
    },
  };
});

it("fails an armed timeline that exceeds the retained-event allowance", async () => {
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
        if (event.registered?.method === "Page.lifecycleEvent") received();
      });
    });
  const browser = await startFakeCdpBrowser({ commandEvents: () => [] });
  const provider = new CdpBrowserProvider();
  onTestFinished(async () => {
    delivery.mockRestore();
    await provider.close();
    await browser.close();
  });
  const detail = "a".repeat(100);
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 5,
    }),
    {
      signal: AbortSignal.timeout(2_000),
      progress: {
        report: async (update) => {
          if (update.completed !== 1) return;
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
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "BrowserObservationError",
      reason: "payload_limit",
      detail: expect.stringContaining(
        "Armed timeline rows exceeded the 512-byte retained event allowance.",
      ),
    },
  });
  expect(browser.commands.map(({ method }) => method)).toContain(
    "Target.detachFromTarget",
  );
});
