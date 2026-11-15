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

/** Answer frame-tree read N with `documents[N - 1]`, repeating the last one. */
const frameTreeSequence =
  (documents: readonly Document[]): NonNullable<FakeOptions["commandResult"]> =>
  ({ method }, origin, frameReads) =>
    method === "Page.getFrameTree"
      ? frameTree(
          origin,
          documents[Math.min(frameReads, documents.length) - 1] ?? {},
        )
      : undefined;

const start = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  return browser;
};

const known: Document = { loaderId: "loader-main" };

/**
 * A refusal reason, or a completed result whose document was proven
 * (`verified`) or left unproven with limited coverage (`limited`).
 */
type Outcome = "verified" | "limited" | string;

const expectOutcome = (
  result:
    | Awaited<ReturnType<CdpBrowserProvider["inspectPage"]>>
    | Awaited<ReturnType<CdpBrowserProvider["discoverWebMcpTools"]>>
    | Awaited<ReturnType<CdpBrowserProvider["captureScreenshot"]>>,
  outcome: Outcome,
  section: string,
) => {
  if (outcome !== "verified" && outcome !== "limited") {
    expect(result).toMatchObject({ ok: false, error: { reason: outcome } });
    return;
  }
  if (!result.ok) throw result.error;
  const limited = result.value.completeness.attach_limited_sections.includes(
    section as never,
  );
  expect(limited).toBe(outcome === "limited");
  expect(
    result.value.limitations.some((text) =>
      text.includes("loader identity was unavailable"),
    ),
  ).toBe(outcome === "limited");
};

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
      outcome: "verified",
    },
    {
      name: "a final URL change without loader identities",
      before: {},
      after: { path: "/next" },
      outcome: "limited",
    },
    {
      name: "a final reply that omits a known loader",
      after: {},
      outcome: "limited",
    },
    {
      name: "a final loader change at the same URL",
      after: { loaderId: "loader-next" },
      outcome: "target_changed",
    },
    {
      name: "a final document change to another origin",
      after: { loaderId: "loader-next", url: "https://outside.example/" },
      outcome: "target_changed",
    },
    {
      name: "a final same-document move to another origin",
      after: { ...known, url: "https://outside.example/" },
      outcome: "target_not_allowed",
    },
  ])("reports $name as $outcome", async ({ before, after, outcome }) => {
    const result = await inspect({
      commandResult: frameTrees(2, before ?? known, after),
    });
    expectOutcome(result, outcome, "frames");
  });

  // Reads: 1 selects the document, 2 opens final capture, 3+ complete it.
  it.each([
    {
      name: "a pre-capture loader change to another origin",
      documents: [
        known,
        { loaderId: "loader-next", url: "https://outside.example/" },
      ],
      outcome: "target_changed",
    },
    {
      name: "a final retry that reaches another loader",
      documents: [
        known,
        known,
        { ...known, url: "" },
        { loaderId: "loader-next" },
      ],
      outcome: "target_changed",
    },
    {
      name: "a final retry that settles on the selected loader",
      documents: [known, known, { ...known, url: "" }, known],
      outcome: "verified",
    },
  ] as readonly {
    name: string;
    documents: readonly Document[];
    outcome: Outcome;
  }[])(
    "reports $name across authorization retries as $outcome",
    async ({ documents, outcome }) => {
      const result = await inspect({
        commandResult: frameTreeSequence(documents),
      });
      expectOutcome(result, outcome, "frames");
    },
  );

  it.each([
    {
      name: "a committed navigation to another origin",
      frame: { loaderId: "loader-next", url: "https://outside.example/" },
      outcome: "target_changed",
    },
    {
      name: "a duplicate event for the selected document",
      frame: known,
      outcome: "verified",
    },
    {
      name: "a committed navigation without loader identity",
      frame: { path: "/next" },
      before: {},
      outcome: "limited",
    },
    {
      name: "an unproven navigation to another origin",
      frame: { url: "https://outside.example/" },
      before: {},
      outcome: "target_not_allowed",
    },
    {
      name: "a root navigation without a frame ID",
      frame: { id: "", path: "/next" },
      outcome: "protocol_error",
    },
  ] as readonly {
    name: string;
    frame: Document;
    before?: Document;
    outcome: Outcome;
  }[])("reports $name as $outcome", async ({ frame, before, outcome }) => {
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
    expectOutcome(result, outcome, "frames");
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
      outcome: "verified",
    },
    {
      name: "a final URL change without loader identities",
      before: {},
      after: { path: "/next" },
      outcome: "limited",
    },
    {
      name: "a final reply that omits a known loader",
      after: {},
      outcome: "limited",
    },
    {
      name: "a final loader change",
      after: { loaderId: "loader-next" },
      outcome: "target_changed",
    },
    {
      name: "a final document change to another origin",
      after: { loaderId: "loader-next", url: "https://outside.example/" },
      outcome: "target_changed",
    },
  ])("reports $name as $outcome", async ({ before, after, outcome }) => {
    const result = await discover({
      commandResult: frameTrees(1, before ?? known, after),
    });
    expectOutcome(result, outcome, "webmcp_tools");
    if (result.ok) expect(result.value.target.url).toMatch(/\/app$/u);
  });
});

describe("screenshot capture", () => {
  it.each([
    {
      name: "a final reply that omits a known loader",
      after: {},
      outcome: "limited",
    },
    {
      name: "a final loader change",
      after: { loaderId: "loader-next" },
      outcome: "target_changed",
    },
    {
      name: "a final same-document URL change",
      after: { ...known, path: "/next" },
      outcome: "target_changed",
    },
  ])("reports $name as $outcome", async ({ after, outcome }) => {
    const browser = await start({
      commandResult: frameTrees(1, known, after),
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expectOutcome(result, outcome, "screenshot");
  });

  it("reports a navigation that fails the screenshot command as target_changed", async () => {
    const browser = await start({
      commandEvents: (command, origin) =>
        command.method === "Page.getLayoutMetrics"
          ? [
              frameNavigated(command, {
                id: "frame-main",
                loaderId: "loader-next",
                url: `${origin}/next`,
              }),
            ]
          : undefined,
      commandError: ({ method }) =>
        method === "Page.captureScreenshot"
          ? { code: -32_000, message: "Target navigated" }
          : undefined,
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    if (result.ok) throw new Error("Expected target_changed");
    expect(result.error).toMatchObject({ reason: "target_changed" });
    expect(result.error.cause).toBeDefined();
  });
});
