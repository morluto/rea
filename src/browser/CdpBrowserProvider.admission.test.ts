import { expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";

import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { WebBundleAnalysisAdmission } from "./IsolatedWebBundleAnalyzer.js";
import { CdpBrowserProvider } from "./CdpBrowserProvider.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../domain/browserObservation.js";
import { observeWebSessionInputSchema } from "../domain/browserSession.js";
import { discoverWebMcpToolsInputSchema } from "../domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../domain/webScreenshot.js";

const input = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9",
  target_id: "page-1",
  include_script_sources: true,
});

const assertSettled = (outcomes: PromiseSettledResult<unknown>[]) => {
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, "Browser admission cleanup failed");
};

it("shares a capture limit when browser providers use one admission", async () => {
  const admission = new WebBundleAnalysisAdmission();
  const first = createBrowserObservationProvider(admission);
  const second = createBrowserObservationProvider(admission);
  const pending = first.analyzeBundle(input);
  const blocked = await second.analyzeBundle(input);
  try {
    if (blocked.ok) throw new Error("expected the shared admission to refuse");
    expect(projectAnalysisError(blocked.error)).toMatchObject({
      code: "resource_constraint",
      details: {
        resource: "capacity",
        reported_limits: { concurrent_web_bundle_analyses: 1 },
      },
    });
  } finally {
    const settled = await Promise.allSettled([pending]);
    const closed = await Promise.allSettled([
      first.close?.(),
      second.close?.(),
    ]);
    assertSettled([...settled, ...closed]);
  }
});

it("does not share a capture limit across browser providers", async () => {
  const first = createBrowserObservationProvider();
  const second = createBrowserObservationProvider();
  const pending = first.analyzeBundle(input);
  const other = second.analyzeBundle(input);
  try {
    const blocked = await other;
    if (blocked.ok) throw new Error("expected capture to fail closed");
    expect(projectAnalysisError(blocked.error).code).not.toBe(
      "resource_constraint",
    );
  } finally {
    const settled = await Promise.allSettled([
      pending,
      other,
      first.close?.(),
      second.close?.(),
    ]);
    assertSettled(settled);
  }
});

it.each(["complete", "cancelled"] as const)(
  "drains admitted HTTP discovery (%s) and refuses new work once provider shutdown starts",
  async (outcome) => {
    let requests = 0;
    let held: ServerResponse | undefined;
    let observed!: () => void;
    const seen = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const server = createServer((request, response) => {
      requests += 1;
      if (request.url === "/json/list" && held === undefined) {
        held = response;
        observed();
      } else if (request.url === "/json/list") response.end("[]");
      else
        response.end(
          JSON.stringify({
            Browser: "fixture",
            "Protocol-Version": "1.3",
            "User-Agent": "fixture",
            "V8-Version": "fixture",
            "WebKit-Version": "fixture",
            webSocketDebuggerUrl:
              endpoint.replace("http:", "ws:") + "/devtools/browser/fixture",
          }),
        );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing fixture endpoint");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const provider = new CdpBrowserProvider();
    const selected = listBrowserTargetsInputSchema.parse({
      cdp_endpoint: endpoint,
    });
    const target = { cdp_endpoint: endpoint, target_id: "page-1" };
    const lateRequests = [
      () => provider.listTargets(selected),
      () => provider.inspectPage(inspectWebPageInputSchema.parse(target)),
      () => provider.analyzeBundle(analyzeWebBundleInputSchema.parse(target)),
      () => provider.observeSession(observeWebSessionInputSchema.parse(target)),
      () =>
        provider.discoverWebMcpTools(
          discoverWebMcpToolsInputSchema.parse(target),
        ),
      () =>
        provider.captureScreenshot(
          captureWebScreenshotInputSchema.parse(target),
        ),
    ];
    const controller = new AbortController();
    const reason = { caller: "cancel discovery during provider shutdown" };
    const pending = provider.listTargets(selected, {
      signal: controller.signal,
    });
    let closing: Promise<void> | undefined;
    try {
      await seen;
      let closed = false;
      closing = provider.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      for (const request of lateRequests)
        expect((await request()).ok).toBe(false);
      expect(requests).toBe(2);
      if (outcome === "cancelled") controller.abort(reason);
      else held?.end("[]");
      const result = await pending;
      if (outcome === "complete")
        expect(result).toMatchObject({ ok: true, value: { targets: [] } });
      else {
        if (result.ok) throw new Error("Expected caller cancellation");
        expect(result.error).toMatchObject({ _tag: "AnalysisCancelledError" });
        expect(result.error.cause).toBe(reason);
      }
      await closing;
      for (const request of lateRequests)
        expect((await request()).ok).toBe(false);
      expect(requests).toBe(2);
    } finally {
      held?.end("[]");
      await pending;
      await closing;
      await provider.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  },
);
