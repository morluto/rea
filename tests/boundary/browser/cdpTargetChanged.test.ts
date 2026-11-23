import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import type { BrowserObservationFailureReason } from "../../../src/domain/browserObservationErrors.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { inspectWebEventListenersInputSchema } from "../../../src/domain/webEventListeners.js";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";
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
  readonly loaderId?: string | undefined;
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
type Outcome = "verified" | "limited" | BrowserObservationFailureReason;

const expectOutcome = (
  result:
    | Awaited<ReturnType<CdpBrowserProvider["inspectPage"]>>
    | Awaited<ReturnType<CdpBrowserProvider["discoverWebMcpTools"]>>
    | Awaited<ReturnType<CdpBrowserProvider["captureScreenshot"]>>,
  outcome: Outcome,
  section: "frames" | "webmcp_tools" | "screenshot",
) => {
  if (outcome !== "verified" && outcome !== "limited") {
    expect(result).toMatchObject({ ok: false, error: { reason: outcome } });
    return;
  }
  if (!result.ok) throw result.error;
  const limited = result.value.completeness.attach_limited_sections.some(
    (value) => value === section,
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
  ] as const)(
    "reports $name as $outcome",
    async ({ before, after, outcome }) => {
      const result = await inspect({
        commandResult: frameTrees(2, before ?? known, after),
      });
      expectOutcome(result, outcome, "frames");
    },
  );

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
  ] as const)(
    "reports $name as $outcome",
    async ({ before, after, outcome }) => {
      const result = await discover({
        commandResult: frameTrees(1, before ?? known, after),
      });
      expectOutcome(result, outcome, "webmcp_tools");
      if (result.ok) expect(result.value.target.url).toMatch(/\/app$/u);
    },
  );
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
  ] as const)("reports $name as $outcome", async ({ after, outcome }) => {
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
      eventsBeforeReply: ["Page.captureScreenshot"],
      commandEvents: (command, origin) =>
        command.method === "Page.captureScreenshot"
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
    expect(result.error).toMatchObject({
      reason: "target_changed",
      cause: {
        reason: "protocol_error",
        command: "Page.captureScreenshot",
        code: -32_000,
        reportedMessage: "Target navigated",
      },
    });
  });
});

/**
 * Root navigation events reach every consumer through the target session's
 * document owner, so the same event means the same thing to each of them.
 * The `emits` command carries the event while the operation is running.
 */
type RootEvent = (
  command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
  origin: string,
) => NonNullable<ReturnType<NonNullable<FakeOptions["commandEvents"]>>>[number];
const rootEvents = {
  "a malformed loader on the selected frame": (command, origin) =>
    frameNavigated(command, {
      id: "frame-main",
      loaderId: 7,
      url: `${origin}/app`,
    }),
  "a malformed loader on a replacement root frame": (command, origin) =>
    frameNavigated(command, {
      id: "frame-next",
      loaderId: 7,
      url: `${origin}/app`,
    }),
  "a same-document move to another origin": (command) => ({
    method: "Page.navigatedWithinDocument",
    ...(command.sessionId === undefined
      ? {}
      : { sessionId: command.sessionId }),
    params: { frameId: "frame-main", url: "https://outside.example/" },
  }),
} satisfies Record<string, RootEvent>;
const runWithRootEvent = async (
  consumer: "page capture" | "screenshot",
  event: RootEvent,
) => {
  const emits =
    consumer === "page capture" ? "Network.enable" : "Page.getLayoutMetrics";
  const browser = await start({
    eventsBeforeReply: [emits],
    commandResult: frameTrees(99, known, known),
    commandEvents: (command, origin) =>
      command.method === emits ? [event(command, origin)] : undefined,
  });
  const input = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
  };
  return consumer === "page capture"
    ? await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({ ...input, observation_ms: 0 }),
      )
    : await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse(input),
      );
};

describe("root navigation events through the target session's document owner", () => {
  // Before the owner, page capture ignored same-document events and reported
  // a replacement root with a malformed loader as protocol_error; screenshot
  // reported a malformed loader on its own frame as target_changed.
  const transitions = [
    ["a malformed loader on the selected frame", "protocol_error"],
    ["a malformed loader on a replacement root frame", "target_changed"],
    ["a same-document move to another origin", "target_not_allowed"],
  ] as const;
  it.each(
    (["page capture", "screenshot"] as const).flatMap((consumer) =>
      transitions.map(([name, reason]) => ({ consumer, name, reason })),
    ),
  )(
    "$consumer reports $name as $reason",
    async ({ consumer, name, reason }) => {
      const result = await runWithRootEvent(consumer, rootEvents[name]);
      expect(result).toMatchObject({ ok: false, error: { reason } });
    },
  );

  it.each([
    {
      name: "a replacement reported only by the event",
      initial: "document-1",
      commit: "document-next",
      changed: true,
    },
    {
      name: "a duplicate commit",
      initial: "document-1",
      commit: "document-1",
      changed: false,
    },
    {
      name: "a first loader after a loaderless selection",
      initial: undefined,
      commit: "document-next",
      changed: true,
    },
  ] as const)(
    "runtime listener inspection handles $name",
    async ({ initial, commit, changed }) => {
      let committed = false;
      const browser = await startRuntimeBrowser({
        eventsBeforeReply: ["DOM.getDocument"],
        commandResult: ({ method }, origin) =>
          method === "Page.getFrameTree"
            ? frameTree(origin, {
                id: "runtime-main",
                loaderId: initial ?? (committed ? commit : undefined),
              })
            : undefined,
        commandEvents: (command, origin) => {
          if (command.method !== "DOM.getDocument") return undefined;
          committed = true;
          return [
            frameNavigated(command, {
              id: "runtime-main",
              loaderId: commit,
              url: `${origin}/app`,
            }),
          ];
        },
      });
      trackBrowser(browser);
      const provider = new CdpWebRuntimeProvider();
      try {
        const result = await provider.inspectEventListeners(
          inspectWebEventListenersInputSchema.parse({
            cdp_endpoint: browser.endpoint,
            allowed_origins: [browser.allowedOrigin],
            target_id: "allowed-page",
            selector: "#selected",
          }),
        );
        expect(committed).toBe(true);
        if (changed) {
          expect(result).toMatchObject({
            ok: false,
            error: { reason: "target_changed" },
          });
        } else {
          if (!result.ok) throw result.error;
          expect(result.value).toMatchObject({
            selected_node: { selector: "#selected", match: "found" },
            listeners: [{ type: "click", execution: "unknown" }],
            cleanup: "confirmed",
          });
        }
      } finally {
        await provider.close();
      }
    },
  );
});

describe("observation window replay", () => {
  // The observation window replays events buffered before its clock sample;
  // each is scoped by the root frame it arrived under, not by a root
  // replacement received after it.
  it("observation scopes buffered rows by the root frame each arrived under", async () => {
    const withinDocument = (
      command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
      frameId: string,
      url: string,
    ) => ({
      method: "Page.navigatedWithinDocument",
      ...(command.sessionId === undefined
        ? {}
        : { sessionId: command.sessionId }),
      params: { frameId, url, navigationType: "historyApi" },
    });
    const browser = await start({
      eventsBeforeReply: ["Performance.getMetrics"],
      commandResult: (command) => {
        if (command.method === "Performance.enable") return {};
        if (command.method === "Performance.getMetrics")
          return { metrics: [{ name: "Timestamp", value: 20 }] };
        return undefined;
      },
      commandEvents: (command, origin) =>
        command.method === "Performance.getMetrics"
          ? [
              withinDocument(command, "frame-main", `${origin}/app#before`),
              frameNavigated(command, {
                id: "frame-next",
                loaderId: "loader-next",
                url: `${origin}/next`,
              }),
              withinDocument(command, "frame-main", `${origin}/app#stale`),
              withinDocument(command, "frame-next", `${origin}/next#after`),
            ]
          : undefined,
    });
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.timeline
        .filter((row) => row.type === "same_document_navigation")
        .map((row) => [row.frame_id, row.url]),
    ).toEqual([
      ["frame-main", `${browser.allowedOrigin}/app#before`],
      ["frame-next", `${browser.allowedOrigin}/next#after`],
    ]);
  });
});
