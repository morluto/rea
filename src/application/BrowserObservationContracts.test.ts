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
import { ok, err } from "../domain/result.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { parseEvidence } from "../domain/evidence.js";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import * as service from "./BrowserObservationService.js";

const pageProvider = (
  inspectPage: BrowserObservationPort["inspectPage"],
): BrowserObservationPort => {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected browser operation");
  };
  return {
    identity: () => ({ id: "controlled", name: "Controlled", version: "1" }),
    inspectPage,
    listTargets: unused,
    analyzeBundle: unused,
    observeSession: unused,
    discoverWebMcpTools: unused,
    captureScreenshot: unused,
    compareCaptures: unused,
    compareScreenshots: unused,
  };
};

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

it("retains own provider metadata separately from admitted browser facts", async () => {
  let reads = 0;
  const source = Object.defineProperty(
    {
      ...inspection,
      provider_metadata: {
        capture_path: "/caller/selected/capture",
        marker: "own",
      },
      browser: { ...inspection.browser, provider_revision: "source-revision" },
    },
    "kind",
    {
      get: () => {
        reads++;
        throw new Error("hidden getter");
      },
    },
  );
  const result = await service.inspectWebPage(
    pageProvider(async () => ok(source)),
    inspectWebPageInputSchema.parse(selected),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).not.toHaveProperty(
    "provider_metadata",
  );
  expect(result.value.raw_result).toEqual(source);
  expect(result.value.raw_result).not.toHaveProperty("kind");
  expect(reads).toBe(0);
});

it("retains source omission when the browser contract supplies defaults", async () => {
  const { fingerprint_algorithm: _algorithm, ...storage } = inspection.storage;
  const source = { ...inspection, storage };
  const result = await service.inspectWebPage(
    pageProvider(async () => ok(source as typeof inspection)),
    inspectWebPageInputSchema.parse(selected),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toHaveProperty(
    "storage.fingerprint_algorithm",
    "sha256",
  );
  expect(result.value.raw_result).toEqual(source);
  expect(result.value.raw_result).not.toHaveProperty(
    "storage.fingerprint_algorithm",
  );
});

it("avoids a redundant raw browser report when parsed facts retain all own JSON", async () => {
  const { browser, ...rest } = inspection;
  const result = await service.inspectWebPage(
    pageProvider(async () => ok({ ...rest, browser })),
    inspectWebPageInputSchema.parse(selected),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.raw_result).toBeNull();
});

it("retains own metadata when promoting completed facts from a provider failure", async () => {
  const source = {
    ...inspection,
    provider_metadata: { capture_id: "partial-source" },
  };
  const failure = new BrowserObservationError(
    "inspect_web_page",
    "endpoint_unreachable",
    { partialObservation: source },
  );
  const result = await service.inspectWebPage(
    pageProvider(async () => err(failure)),
    inspectWebPageInputSchema.parse(selected),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  const evidence = parseEvidence(result.error.partialObservation);
  expect(evidence.raw_result).toEqual(source);
  expect(evidence.normalized_result).not.toHaveProperty("provider_metadata");
});
