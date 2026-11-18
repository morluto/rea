import { expect, it } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated, trackBrowser } from "./cdpBrowserProvider.support.js";

it("distinguishes document invalidation, origin refusal, and an independent script-read failure", async () => {
  const outside = "https://outside.example/page";
  const foreign = [
    { loaderId: "outside-document", reason: "target_changed" },
    { reason: "target_not_allowed" },
  ] as const;
  const scenarios = [
    ...["Network.enable", "DOMSnapshot.captureSnapshot"].flatMap((command) =>
      foreign.map(({ reason, ...identity }) => ({
        navigation: { command, url: outside, identity },
        sourceFails: false,
        reason,
      })),
    ),
    {
      navigation: {
        command: "DOMSnapshot.captureSnapshot",
        identity: { loaderId: "reloaded-document" },
      },
      sourceFails: true,
      reason: "target_changed",
    },
    {
      navigation: {
        command: "DOMSnapshot.captureSnapshot",
        url: outside,
        identity: {},
      },
      sourceFails: true,
      reason: "target_not_allowed",
    },
    { sourceFails: true, reason: "protocol_error" },
  ] as const;

  let scenario: (typeof scenarios)[number] = scenarios[0]!;
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable", "DOMSnapshot.captureSnapshot"],
    commandEvents: (command, origin) => {
      const navigation =
        "navigation" in scenario ? scenario.navigation : undefined;
      if (navigation?.command !== command.method) return undefined;
      return [
        frameNavigated(command, {
          id: "frame-main",
          ...navigation.identity,
          url: "url" in navigation ? navigation.url : origin + "/reloaded",
        }),
      ];
    },
    commandError: ({ method }) =>
      scenario.sourceFails && method === "Debugger.getScriptSource"
        ? { code: -32_000, message: "No script for id" }
        : undefined,
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    target_id: "allowed-page",
    observation_ms: 0,
    include_script_sources: true,
  });
  const sourceRejection = {
    reason: "protocol_error",
    command: "Debugger.getScriptSource",
    code: -32_000,
    reportedMessage: "No script for id",
  };
  try {
    for (const expected of scenarios) {
      scenario = expected;
      const label = JSON.stringify(expected);
      const before = browser.commands.length;
      const result = await provider.inspectPage(input);
      if (result.ok) throw new Error(`Expected refusal: ${label}`);
      const diagnostic = projectAnalysisError(result.error);
      expect(diagnostic.details, label).toMatchObject({
        operation: "inspect_web_page",
        reason: expected.reason,
      });
      if (expected.reason === "target_changed") {
        expect(diagnostic, label).toMatchObject({
          code: "target_unavailable",
          message: expect.stringContaining("target changed"),
          remediation: {
            action: expect.stringContaining("Retry after navigation settles"),
          },
        });
      } else if (expected.reason === "target_not_allowed") {
        expect(diagnostic, label).toMatchObject({
          code: "target_unavailable",
          message: expect.stringContaining("permitted HTTP(S) origin scope"),
          remediation: { action: expect.stringContaining("allowed_origins") },
        });
      }
      if (expected.sourceFails) {
        const rejection =
          expected.reason === "protocol_error"
            ? result.error
            : result.error.cause;
        expect(rejection, label).toMatchObject(sourceRejection);
      }

      const methods = browser.commands
        .slice(before)
        .map(({ method }) => method);
      if (
        "navigation" in expected &&
        expected.navigation.command === "Network.enable"
      )
        expect(methods, label).not.toContain("DOMSnapshot.captureSnapshot");
      expect(methods, label).toContain("Target.detachFromTarget");
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    }
  } finally {
    await provider.close();
  }
});
