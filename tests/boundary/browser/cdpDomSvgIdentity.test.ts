import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const startBrowser = async (options: FakeOptions = {}) => {
  const browser = await startFakeCdpBrowser({
    ...options,
    commandResult(command, origin, frameReads) {
      const override = options.commandResult?.(command, origin, frameReads);
      if (override !== undefined) return override;
      if (command.method === "DOMSnapshot.captureSnapshot") {
        const nodes = {
          nodeType: [9, 1, 1, 1, 1, 1, 1],
          nodeName: [1, 2, 3, 3, 3, 3, 3],
          nodeValue: [4, 4, 4, 4, 4, 4, 4],
          parentIndex: [-1, 0, 1, 1, 1, 1, 1],
          backendNodeId: [1, 2, 3, 4, 5, 6, 7],
          attributes: [[], [], [5, 6], [5, 7], [5, 11], [5, 12], [5, 6, 8, 9]],
        };
        return {
          strings: [
            `${origin}/app`,
            "#document",
            "HTML",
            "a",
            "",
            "xlink:href",
            "/removed",
            "/mismatched",
            "href",
            "/ordinary",
            "https://excluded.example/page",
            "/malformed",
            "/confirmed",
          ],
          documents: [
            { documentURL: 0, nodes },
            {
              documentURL: 10,
              nodes: { ...nodes, backendNodeId: [11, 12, 13, 14, 15, 16, 17] },
            },
          ],
        };
      }
      if (command.method === "DOM.describeNode")
        return {
          node: {
            backendNodeId: command.params.backendNodeId,
            nodeType: 1,
            nodeName: "a",
            isSVG: true,
          },
        };
      return undefined;
    },
  });
  trackBrowser(browser);
  return browser;
};

const inspect = (browser: FakeCdpBrowser, signal?: AbortSignal) =>
  new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 0,
    }),
    signal === undefined ? undefined : { signal },
  );

describe("CDP SVG identity at the snapshot boundary", () => {
  it("resolves only in-scope XLink candidates and retains readable sibling URLs", async () => {
    const browser = await startBrowser({
      commandError: (command) =>
        command.method === "DOM.describeNode" &&
        command.params.backendNodeId === 3
          ? { code: -32_000, message: "No node found for given backend id" }
          : undefined,
      commandResult: (command) => {
        if (command.method !== "DOM.describeNode") return undefined;
        const id = command.params.backendNodeId;
        if (id === 4)
          return {
            node: {
              backendNodeId: 99,
              nodeType: 1,
              nodeName: "a",
              isSVG: true,
            },
          };
        if (id === 5)
          return {
            node: {
              backendNodeId: 5,
              nodeType: 1,
              nodeName: "a",
              isSVG: "true",
            },
          };
        return undefined;
      },
    });
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    expect(descriptions(browser).map(({ params }) => params)).toEqual([
      { backendNodeId: 3, depth: 0 },
      { backendNodeId: 4, depth: 0 },
      { backendNodeId: 5, depth: 0 },
      { backendNodeId: 6, depth: 0 },
    ]);
    expect(result.value.metadata.dom_urls.map(({ url }) => url)).toEqual([
      `${browser.allowedOrigin}/confirmed`,
      `${browser.allowedOrigin}/ordinary`,
    ]);
    expect(result.value.completeness.excluded).toContainEqual({
      section: "metadata",
      reason: "provider_unavailable",
      count: 3,
    });
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("SVG identity"),
    );
  });

  it("stops querying after the first batch reports an unsupported method", async () => {
    const browser = await startBrowser({
      commandResult: manyCandidates,
      unsupportedMethods: ["DOM.describeNode"],
    });
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    expect(result.value.metadata.dom_urls).toEqual([]);
    expect(result.value.completeness.excluded).toContainEqual({
      section: "metadata",
      reason: "provider_unavailable",
      count: 25,
    });
    expect(descriptions(browser).length).toBeGreaterThan(0);
    expect(descriptions(browser).length).toBeLessThanOrEqual(8);
  });

  it("propagates a disconnect during node description", async () => {
    const browser = await startBrowser({ closeOnMethod: "DOM.describeNode" });
    expect(await inspect(browser)).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "disconnected" },
    });
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  });

  it("cancels a pending description and detaches without closing the target", async () => {
    const browser = await startBrowser({ hangOnMethod: "DOM.describeNode" });
    const controller = new AbortController();
    const pending = inspect(browser, controller.signal);
    await expect.poll(() => descriptions(browser).length).toBeGreaterThan(1);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "inspect_web_page" },
    });
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Browser.close");
  });
});

const manyCandidates: NonNullable<FakeOptions["commandResult"]> = (
  command,
  origin,
) => {
  if (command.method !== "DOMSnapshot.captureSnapshot") return undefined;
  const count = 25;
  return {
    strings: [
      origin,
      "#document",
      "HTML",
      "a",
      "",
      "xlink:href",
      ...Array.from({ length: count }, (_, index) => `/link-${String(index)}`),
    ],
    documents: [
      {
        documentURL: 0,
        nodes: {
          nodeType: [9, 1, ...Array<number>(count).fill(1)],
          nodeName: [1, 2, ...Array<number>(count).fill(3)],
          nodeValue: Array<number>(count + 2).fill(4),
          parentIndex: [-1, 0, ...Array<number>(count).fill(1)],
          backendNodeId: Array.from(
            { length: count + 2 },
            (_, index) => index + 1,
          ),
          attributes: [
            [],
            [],
            ...Array.from({ length: count }, (_, index) => [5, index + 6]),
          ],
        },
      },
    ],
  };
};

const descriptions = (browser: FakeCdpBrowser) =>
  browser.commands.filter(({ method }) => method === "DOM.describeNode");

describe("CDP SVG query concurrency", () => {
  it("bounds in-flight reads and preserves metadata order across reversed replies", async () => {
    const browser = await startBrowser({
      commandResult: manyCandidates,
      hangOnMethod: "DOM.describeNode",
    });
    const controller = new AbortController();
    const pending = inspect(browser, controller.signal);
    try {
      await expect.poll(() => descriptions(browser).length).toBeGreaterThan(1);
      let replied = 0;
      while (replied < 25) {
        await expect
          .poll(() => descriptions(browser).length)
          .toBeGreaterThan(replied);
        const batch = descriptions(browser).slice(replied);
        expect(batch.length).toBeLessThanOrEqual(8);
        for (const command of [...batch].reverse()) {
          const id = Number(command.params.backendNodeId);
          browser.emitRawMessage(
            JSON.stringify({
              id: command.id,
              sessionId: command.sessionId,
              result: {
                node: {
                  backendNodeId: id,
                  nodeType: 1,
                  nodeName: "a",
                  isSVG: id % 2 === 1,
                },
              },
            }),
          );
        }
        replied += batch.length;
      }
      const result = await pending;
      if (!result.ok) throw result.error;
      expect(result.value.metadata.dom_urls.map(({ url }) => url)).toEqual(
        Array.from(
          { length: 13 },
          (_, index) => `${browser.allowedOrigin}/link-${String(index * 2)}`,
        ),
      );
      expect(descriptions(browser)).toHaveLength(25);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("cancels sibling reads on a fatal reply without waiting for hung nodes", async () => {
    const browser = await startBrowser({
      commandResult: manyCandidates,
      hangOnMethod: "DOM.describeNode",
    });
    const controller = new AbortController();
    const pending = inspect(browser, controller.signal);
    try {
      await expect.poll(() => descriptions(browser).length).toBeGreaterThan(1);
      const batch = descriptions(browser);
      browser.emitRawMessage(
        JSON.stringify({
          id: batch.at(-1)?.id,
          sessionId: batch.at(-1)?.sessionId,
          error: { code: -32_602, message: "Invalid parameters" },
        }),
      );
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { _tag: "BrowserObservationError", reason: "protocol_error" },
      });
      expect(descriptions(browser)).toHaveLength(batch.length);
      const methods = browser.commands.map(({ method }) => method);
      expect(methods).toContain("Target.detachFromTarget");
      expect(methods).not.toContain("Target.closeTarget");
      expect(methods).not.toContain("Browser.close");
    } finally {
      controller.abort();
      await pending;
    }
  });
});
