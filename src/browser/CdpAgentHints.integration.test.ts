import { expect, it } from "vitest";
import { startFakeCdpBrowser } from "../../tests/fixtures/fakeCdpBrowser.js";
import { resultFor } from "../../tests/fixtures/fakeCdpBrowserResults.js";
import { fakeCdpEvents } from "../../tests/fixtures/fakeCdpEvents.js";
import { fakeCdpSend } from "../../tests/fixtures/fakeCdpSend.js";
import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import { inspectWebPage } from "../application/BrowserObservationService.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";
import { discoverWebMcpToolsInputSchema } from "../domain/webMcpDiscovery.js";
import { discoverWebMcp } from "./CdpWebMcpDiscovery.js";
import { captureCdpScreenshot } from "./CdpScreenshot.js";
import type { CdpConnection } from "./CdpConnection.js";
import { captureWebScreenshotInputSchema } from "../domain/webScreenshot.js";

it.each(["", "h:"])(
  "retains agent hints from XHTML links with prefix %j",
  async (prefix) => {
    const declarations = ["mcp", "model-context", "ai-plugin", "service-desc"];
    const browser = await startFakeCdpBrowser({
      commandResult: (command, origin) =>
        command.method === "DOMSnapshot.captureSnapshot"
          ? {
              strings: [
                "#document",
                `${prefix}html`,
                `${prefix}head`,
                `${prefix}link`,
                "",
                prefix ? "xmlns:h" : "xmlns",
                "http://www.w3.org/1999/xhtml",
                "rel",
                declarations.join(" "),
                "href",
                "/agent",
                `${origin}/root/page.xhtml`,
              ],
              documents: [
                {
                  documentURL: 11,
                  nodes: {
                    nodeType: [9, 1, 1, 1],
                    nodeName: [0, 1, 2, 3],
                    nodeValue: [4, 4, 4, 4],
                    parentIndex: [-1, 0, 1, 2],
                    attributes: [[], [5, 6], [], [7, 8, 9, 10]],
                  },
                },
              ],
            }
          : undefined,
    });
    const provider = createBrowserObservationProvider();
    try {
      const result = await inspectWebPage(
        provider,
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 1,
        }),
      );
      if (!result.ok) throw result.error;
      const value = webPageInspectionSchema.parse(
        result.value.normalized_result,
      );
      expect(value.metadata.dom_urls).toEqual([
        {
          node_index: 3,
          attribute: "href",
          url: `${browser.allowedOrigin}/agent`,
          destination_scope: "approved",
        },
      ]);
      expect(
        value.metadata.agent_hints.filter(
          (hint) => hint.mechanism === "dom_link_rel",
        ),
      ).toEqual(
        declarations.map((declaration) => ({
          mechanism: "dom_link_rel",
          declaration,
          url: `${browser.allowedOrigin}/agent`,
          trust: "page-declared-untrusted",
        })),
      );
      expect(
        browser.commands.some(
          (command) => command.method === "DOMSnapshot.captureSnapshot",
        ),
      ).toBe(true);
    } finally {
      await provider.close?.();
      await browser.close();
    }
  },
);

it.each([
  "progress",
  "enable",
  "webmcp-document",
  "screenshot-document",
  "terminal",
  "complete",
] as const)(
  "releases passive browser subscriptions after %s settlement",
  async (stage) => {
    const events = fakeCdpEvents();
    const failure = new Error("controlled discovery interruption");
    let interrupted = true;
    let treeReads = 0;
    const documentChanged = stage.endsWith("-document");
    const progressUpdates: number[] = [];
    const connection = {
      onEvent: events.onEvent,
      send: fakeCdpSend((method, params) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: {
                id:
                  interrupted && documentChanged && ++treeReads === 2
                    ? "replacement"
                    : "main",
                url: "https://app.test/",
              },
            },
          };
        if (method === "WebMCP.enable" && stage === "enable" && interrupted)
          throw failure;
        return resultFor({ id: 0, method, params }, 9222, {}, 0) ?? {};
      }),
    } as unknown as CdpConnection;
    const selection = {
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "selected",
      allowed_origins: ["https://app.test"],
    };
    const context: Omit<Parameters<typeof discoverWebMcp>[0], "input"> = {
      connection,
      sessionId: undefined,
      discovery: {
        version: {
          product: "fixture",
          protocol_version: "1",
          revision: "",
          user_agent: "fixture",
          js_version: "",
        },
        targets: [],
        webSocket: { scope: "browser", url: "ws://127.0.0.1:9222" },
      },
      target: {
        id: "selected",
        type: "page",
        title: "fixture",
        url: "https://app.test/",
        attached: false,
      },
      progress: {
        report: async (update) => {
          progressUpdates.push(update.completed);
          if (
            interrupted &&
            ((stage === "progress" && update.completed === 1) ||
              (stage === "terminal" && update.completed === 2))
          )
            throw failure;
        },
      },
    };
    const screenshot = stage === "screenshot-document";
    const run = () =>
      screenshot
        ? captureCdpScreenshot({
            ...context,
            input: captureWebScreenshotInputSchema.parse(selection),
          })
        : discoverWebMcp({
            ...context,
            input: discoverWebMcpToolsInputSchema.parse({
              ...selection,
              observation_ms: 0,
            }),
          });
    const result = run();
    if (stage === "complete")
      await expect(result).resolves.toMatchObject({ status: "available" });
    else if (documentChanged)
      await expect(result).rejects.toMatchObject({
        _tag: "BrowserObservationError",
        operation: screenshot
          ? "capture_web_screenshot"
          : "discover_webmcp_tools",
        reason: "target_changed",
      });
    else await expect(result).rejects.toBe(failure);
    expect(events.listenerCount()).toBe(0);
    expect(progressUpdates).toEqual(
      stage === "complete" || stage === "terminal" ? [1, 2] : [1],
    );
    if (stage !== "complete") {
      interrupted = false;
      await expect(run()).resolves.toMatchObject(
        screenshot
          ? { target: { target_id: "selected" } }
          : { status: "available" },
      );
      expect(events.listenerCount()).toBe(0);
    }
  },
);

const loader = "loader-main";
const documentCases = [
  ["unchanged", loader, loader, "complete"],
  ["unknown initial loader", "", loader, "initial"],
  ["unknown final loader", loader, undefined, "final"],
  ["replacement loader", loader, "replacement-loader", "changed"],
] as const;

it.each(
  ["screenshot", "webmcp"].flatMap((operation) =>
    documentCases.map(([change, initialLoader, finalLoader, coverage]) => ({
      operation,
      change,
      initialLoader,
      finalLoader,
      coverage,
    })),
  ),
)(
  "verifies final $operation document identity from tree snapshots: $change",
  async ({ operation, change, initialLoader, finalLoader, coverage }) => {
    let trees = 0;
    const browser = await startFakeCdpBrowser({
      commandResult: (command, origin) => {
        if (command.method !== "Page.getFrameTree") return undefined;
        const initial = trees++ === 0;
        return {
          frameTree: {
            frame: {
              id: "frame-main",
              loaderId: initial ? initialLoader : finalLoader,
              url: `${origin}/app`,
            },
          },
        };
      },
    });
    const provider = createBrowserObservationProvider();
    try {
      const selection = {
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        allowed_origins: [browser.allowedOrigin],
      };
      const result =
        operation === "screenshot"
          ? await provider.captureScreenshot(
              captureWebScreenshotInputSchema.parse(selection),
            )
          : await provider.discoverWebMcpTools(
              discoverWebMcpToolsInputSchema.parse({
                ...selection,
                observation_ms: 0,
              }),
            );
      if (coverage === "changed") {
        expect(result).toMatchObject({
          ok: false,
          error: { reason: "target_changed" },
        });
        return;
      }
      if (!result.ok) throw result.error;
      const limited = coverage !== "complete";
      const section =
        operation === "screenshot" ? "screenshot" : "webmcp_tools";
      expect(
        result.value.completeness.attach_limited_sections.includes(section),
      ).toBe(limited);
      if (limited)
        expect(result.value.limitations).toContainEqual(
          expect.stringContaining(
            `${coverage} document loader identity was unavailable`,
          ),
        );
    } finally {
      await provider.close?.();
      await browser.close();
    }
  },
);
