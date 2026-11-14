import { expect, it } from "vitest";
import { startFakeCdpBrowser } from "../../tests/fixtures/fakeCdpBrowser.js";
import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import { inspectWebPage } from "../application/BrowserObservationService.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";
import { discoverWebMcpToolsInputSchema } from "../domain/webMcpDiscovery.js";
import { discoverWebMcp } from "./CdpWebMcpDiscovery.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
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

it.each(["progress", "enable", "terminal", "complete"] as const)(
  "releases WebMCP subscriptions after %s settlement",
  async (stage) => {
    const listeners = new Set<(event: CdpEvent) => void>();
    const failure = new Error("controlled discovery interruption");
    const unexpectedTerminal = new Error("terminal progress after failure");
    let interrupted = true;
    const progressUpdates: number[] = [];
    const connection = {
      onEvent: (listener: (event: CdpEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: async (method: string) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: "main", url: "https://app.test/" } },
          };
        if (method === "WebMCP.enable" && stage === "enable" && interrupted)
          throw failure;
        return {};
      },
    } as unknown as CdpConnection;
    const context: Parameters<typeof discoverWebMcp>[0] = {
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
      input: discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "selected",
        allowed_origins: ["https://app.test"],
        observation_ms: 0,
      }),
      progress: {
        report: async (update) => {
          progressUpdates.push(update.completed);
          if (
            interrupted &&
            update.completed === 2 &&
            (stage === "progress" || stage === "enable")
          )
            throw unexpectedTerminal;
          if (
            interrupted &&
            ((stage === "progress" && update.completed === 1) ||
              (stage === "terminal" && update.completed === 2))
          )
            throw failure;
        },
      },
    };
    const result = discoverWebMcp(context);
    if (stage === "complete")
      await expect(result).resolves.toMatchObject({ status: "available" });
    else await expect(result).rejects.toBe(failure);
    expect(listeners.size).toBe(0);
    expect(progressUpdates).toEqual(
      stage === "progress" || stage === "enable" ? [1] : [1, 2],
    );
    interrupted = false;
    await expect(discoverWebMcp(context)).resolves.toMatchObject({
      status: "available",
    });
    expect(listeners.size).toBe(0);
  },
);

it.each(
  ["screenshot", "webmcp"].flatMap((operation) =>
    [
      "unchanged",
      "unknown-loader",
      "unknown-initial-loader",
      "missing-final-loader",
      "empty-final-loader",
      "frame",
      "loader",
    ].map((change) => ({
      operation,
      change,
    })),
  ),
)(
  "verifies final $operation document identity from tree snapshots: $change",
  async ({ operation, change }) => {
    let trees = 0;
    const browser = await startFakeCdpBrowser({
      commandResult: (command, origin) => {
        if (command.method !== "Page.getFrameTree") return undefined;
        trees += 1;
        return {
          frameTree: {
            frame: {
              id:
                trees > 1 && change === "frame"
                  ? "replacement-main"
                  : "frame-main",
              loaderId:
                trees > 1 && change === "missing-final-loader"
                  ? undefined
                  : trees > 1 && change === "empty-final-loader"
                    ? ""
                    : change === "unknown-initial-loader" && trees === 1
                      ? undefined
                      : change === "unknown-loader"
                        ? trees > 1
                          ? undefined
                          : ""
                        : trees > 1 && change === "loader"
                          ? "replacement-loader"
                          : "loader-main",
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
      if (
        change === "unchanged" ||
        change === "unknown-loader" ||
        change === "unknown-initial-loader"
      ) {
        if (!result.ok) throw result.error;
        const unknown = change !== "unchanged";
        expect(
          result.value.limitations.some((value) =>
            value.includes("initial document loader identity was unavailable"),
          ),
        ).toBe(unknown);
        expect(result.value.completeness.attach_limited_sections).toEqual(
          unknown
            ? expect.arrayContaining([
                operation === "screenshot" ? "screenshot" : "webmcp_tools",
              ])
            : expect.not.arrayContaining([
                operation === "screenshot" ? "screenshot" : "webmcp_tools",
              ]),
        );
      } else
        expect(result).toMatchObject({
          ok: false,
          error: {
            reason:
              change === "missing-final-loader" ||
              change === "empty-final-loader"
                ? "protocol_error"
                : "target_changed",
          },
        });
    } finally {
      await provider.close?.();
      await browser.close();
    }
  },
);
