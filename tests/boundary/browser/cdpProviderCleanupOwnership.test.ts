import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket } from "ws";
import { expect, it, onTestFinished, vi } from "vitest";

import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { inspectElectronPageInputSchema } from "../../../src/domain/javascript/electronObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { waitFor } from "../../support/testWait.js";

it.each([
  ["keeps a completed inspection", false],
  ["keeps the primary capture failure", true],
] as const)(
  "retains ownership after socket close fails and %s",
  async (_label, failCapture) => {
    const root = await createTestTempDirectory("rea-electron-close-owner-");
    const page = join(root, "index.html");
    await writeFile(page, "<main>completed fixture</main>");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(page).href,
      ...(failCapture
        ? {
            commandError(command: { method: string }) {
              return command.method === "Page.getFrameTree"
                ? {
                    code: -32_000,
                    message: "controlled primary capture failure",
                  }
                : undefined;
            },
          }
        : {}),
    });
    const provider = new CdpElectronProvider();
    onTestFinished(async () => {
      try {
        await provider.close();
      } finally {
        await browser.close();
      }
    });

    const close = vi
      .spyOn(WebSocket.prototype, "close")
      .mockImplementationOnce(() => {
        throw new Error("controlled synchronous socket close failure");
      });
    const terminate = vi
      .spyOn(WebSocket.prototype, "terminate")
      .mockImplementation(() => undefined);
    const result = await provider
      .inspectPage(
        inspectElectronPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "electron-page",
          observation_ms: 0,
        }),
      )
      .finally(() => {
        close.mockRestore();
        terminate.mockRestore();
      });

    if (result.ok) throw new Error("Expected cleanup failure");
    if (failCapture) {
      expect(result.error).toMatchObject({
        _tag: "ProviderAdapterError",
        cleanupIncomplete: true,
        diagnostics: {
          primary_error: { code: "unreadable_output" },
          cleanup_error: expect.any(Object),
        },
      });
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Page.getFrameTree",
      );
    } else {
      expect(result.error).toBeInstanceOf(ProviderCleanupError);
      expect(result.error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: expect.arrayContaining(["electron-page"]),
        partialObservation: {
          kind: "electron-page-observation",
          cleanup: "incomplete",
          inspection: {
            target: { target_id: "electron-page", file_path: page },
            dom: { total_nodes: expect.any(Number) },
          },
        },
      });
    }

    expect(browser.activeConnectionCount()).toBe(1);
    await provider.close();
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Browser.close");
    expect((await fetch(`${browser.endpoint}/json/version`)).ok).toBe(true);
  },
);
