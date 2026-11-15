import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated, trackBrowser } from "./cdpBrowserProvider.support.js";

/**
 * One table per consumer of the selected document's identity. Each row names
 * the identity transition and the result the consumer reports for it.
 */
interface Document {
  readonly id?: string;
  readonly loaderId?: string;
  readonly path?: string;
  readonly url?: string;
}

const frameTree = (origin: string, document: Document) => ({
  frameTree: {
    frame: {
      id: document.id ?? "frame-main",
      ...(document.loaderId === undefined
        ? {}
        : { loaderId: document.loaderId }),
      url: document.url ?? `${origin}${document.path ?? "/app"}`,
    },
  },
});

/** Answer the first `reads` frame-tree reads with `before`, later ones with `after`. */
const frameTrees =
  (
    reads: number,
    before: Document,
    after: Document,
  ): NonNullable<FakeOptions["commandResult"]> =>
  ({ method }, origin, frameReads) =>
    method === "Page.getFrameTree"
      ? frameTree(origin, frameReads > reads ? after : before)
      : undefined;

const start = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  return browser;
};

const known = { loaderId: "loader-main" } as const;

describe("page capture", () => {
  const inspect = async (options: FakeOptions) => {
    const browser = await start(options);
    return await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
  };

  it.each([
    {
      name: "a final URL change with an unchanged loader",
      after: { ...known, path: "/next" },
      reason: "target_changed",
    },
    {
      name: "a final URL change without loader identities",
      before: {},
      after: { path: "/next" },
      reason: "target_changed",
    },
    {
      name: "a final loader change at the same URL",
      after: { loaderId: "loader-next" },
      reason: null,
    },
  ])("reports $name as $reason", async ({ before, after, reason }) => {
    const result = await inspect({
      commandResult: frameTrees(2, before ?? known, after),
    });
    if (reason === null) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, error: { reason } });
  });

  it.each([
    {
      name: "a committed navigation to another origin",
      frame: { loaderId: "loader-next", url: "https://outside.example/" },
      reason: "target_not_allowed",
    },
    {
      name: "a committed navigation without loader identity",
      frame: { path: "/next" },
      before: {},
      reason: "target_changed",
    },
    {
      name: "a root navigation without a frame ID",
      frame: { id: "", path: "/next" },
      reason: "protocol_error",
    },
  ])("reports $name as $reason", async ({ frame, before, reason }) => {
    const result = await inspect({
      eventsBeforeReply: ["Network.enable"],
      commandResult: frameTrees(99, before ?? known, before ?? known),
      commandEvents: (command, origin) =>
        command.method === "Network.enable"
          ? [
              frameNavigated(command, {
                id: frame.id ?? "frame-main",
                ...(frame.loaderId === undefined
                  ? {}
                  : { loaderId: frame.loaderId }),
                url: frame.url ?? `${origin}${frame.path ?? "/app"}`,
              }),
            ]
          : undefined,
    });
    expect(result).toMatchObject({ ok: false, error: { reason } });
  });
});

describe("WebMCP discovery", () => {
  const discover = async (options: FakeOptions) => {
    const browser = await start({ webMcpTools: true, ...options });
    return await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
  };

  it.each([
    {
      name: "a final URL change with an unchanged loader",
      after: { ...known, path: "/next" },
      reason: "target_changed",
    },
    {
      name: "a final URL change without loader identities",
      before: {},
      after: { path: "/next" },
      reason: "target_changed",
    },
    {
      name: "a final reply that omits a known loader",
      after: {},
      reason: "protocol_error",
    },
    {
      name: "a final loader change",
      after: { loaderId: "loader-next" },
      reason: "target_changed",
    },
    {
      name: "a final document change to another origin",
      after: { loaderId: "loader-next", url: "https://outside.example/" },
      reason: "target_not_allowed",
    },
  ])("reports $name as $reason", async ({ before, after, reason }) => {
    const result = await discover({
      commandResult: frameTrees(1, before ?? known, after),
    });
    expect(result).toMatchObject({ ok: false, error: { reason } });
  });
});

describe("screenshot capture", () => {
  it("reports a final reply that omits a known loader as protocol_error", async () => {
    const browser = await start({
      commandResult: frameTrees(1, known, {}),
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });
});
