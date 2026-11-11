import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { passiveNetworkCapture } from "../../tests/fixtures/passiveNetworkCapture.js";
import { browserCaptureComparisonInputSchema } from "../domain/browserCaptureComparison.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../domain/browserObservation.js";
import { observeWebSessionInputSchema } from "../domain/browserSession.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { discoverWebMcpToolsInputSchema } from "../domain/webMcpDiscovery.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
} from "../domain/webScreenshot.js";
import { ok } from "../domain/result.js";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import * as service from "./BrowserObservationService.js";

const selected = { cdp_endpoint: "http://127.0.0.1:9222", target_id: "page" };
const inspection = passiveNetworkCapture();
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDYQAAAAASUVORK5CYII=",
  "base64",
);
const artifact = {
  bytes: png.length,
  sha256: createHash("sha256").update(png).digest("hex"),
  media_type: "image/png",
  data_base64: png.toString("base64"),
};

const operations = [
  {
    operation: "list_browser_targets",
    run: (browser: BrowserObservationPort) =>
      service.listBrowserTargets(
        browser,
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: selected.cdp_endpoint,
        }),
      ),
  },
  {
    operation: "inspect_web_page",
    run: (browser: BrowserObservationPort) =>
      service.inspectWebPage(
        browser,
        inspectWebPageInputSchema.parse(selected),
      ),
  },
  {
    operation: "analyze_web_bundle",
    run: (browser: BrowserObservationPort) =>
      service.analyzeWebBundle(
        browser,
        analyzeWebBundleInputSchema.parse(selected),
      ),
  },
  {
    operation: "observe_web_session",
    run: (browser: BrowserObservationPort) =>
      service.observeWebSession(
        browser,
        observeWebSessionInputSchema.parse(selected),
      ),
  },
  {
    operation: "discover_webmcp_tools",
    run: (browser: BrowserObservationPort) =>
      service.discoverWebMcpTools(
        browser,
        discoverWebMcpToolsInputSchema.parse(selected),
      ),
  },
  {
    operation: "capture_web_screenshot",
    run: (browser: BrowserObservationPort) =>
      service.captureWebScreenshot(
        browser,
        captureWebScreenshotInputSchema.parse(selected),
      ),
  },
  {
    operation: "compare_web_captures",
    run: (browser: BrowserObservationPort) =>
      service.compareWebCaptureEvidence(
        browser,
        browserCaptureComparisonInputSchema.parse({
          before: { inspection },
          after: { inspection },
        }),
      ),
  },
  {
    operation: "compare_web_screenshots",
    run: (browser: BrowserObservationPort) =>
      service.compareWebScreenshotEvidence(
        browser,
        compareWebScreenshotsInputSchema.parse({
          before: artifact,
          after: artifact,
        }),
      ),
  },
];

it.each(operations)(
  "refuses malformed JSON-safe $operation output at its named contract",
  async ({ operation, run }) => {
    let accessorReads = 0;
    const hidden = Object.defineProperty({ limitations: [] }, "browser", {
      get: () => {
        accessorReads++;
        throw new Error("A hidden provider property is not a JSON observation");
      },
    });
    for (const value of [null, { limitations: [] }, hidden]) {
      const observed = async () => ok(value as never);
      const browser: BrowserObservationPort = {
        identity: () => ({
          id: "controlled",
          name: "Controlled",
          version: "1",
        }),
        listTargets: observed,
        inspectPage: observed,
        analyzeBundle: observed,
        observeSession: observed,
        discoverWebMcpTools: observed,
        captureScreenshot: observed,
        compareCaptures: observed,
        compareScreenshots: observed,
      };
      const result = await run(browser);
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisOutputError", operation },
      });
    }
    expect(accessorReads).toBe(0);
  },
);
