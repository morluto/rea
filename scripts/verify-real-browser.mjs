#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpBrowserProvider } from "../dist/browser/CdpBrowserProvider.js";
import { waitForBrowserDevtoolsPort } from "../dist/browser/BrowserProcessStartup.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../dist/domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../dist/domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "../dist/domain/browserSession.js";
import { compareWebCapturesInputSchema } from "../dist/domain/webCaptureDiff.js";
import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
} from "../dist/domain/webScreenshot.js";
import { startBrowserVerifierSite } from "./fixtures/browser-verifier-site.mjs";
import { startPageCdpProxy } from "./fixtures/page-cdp-proxy.mjs";
import { sourceMapSummary } from "./lib/browser-verifier-assertions.mjs";

const SECRET_VALUES = [
  "network-secret-value",
  "console-secret-value",
  "storage-secret-value",
  "websocket-secret-value",
  "ax-private-label-value",
];

const executable = await browserExecutable();
const profile = await mkdtemp(join(tmpdir(), "rea-real-browser-"));
const site = await startBrowserVerifierSite();
let browser;
let pageProxy;
try {
  browser = spawn(
    executable,
    [
      "--headless=new",
      ...(process.env.REA_BROWSER_NO_SANDBOX === "true"
        ? ["--no-sandbox"]
        : []),
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-sync",
      "--metrics-recording-only",
      `${site.origin}/app?startup=browser-secret-value`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  browser.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1_024) stderr += chunk.toString("utf8");
  });
  const port = await waitForBrowserDevtoolsPort({
    child: browser,
    executable,
    activePortPath: join(profile, "DevToolsActivePort"),
    stderr: () => stderr,
  });
  const endpoint = `http://127.0.0.1:${String(port)}`;
  const provider = new CdpBrowserProvider();
  const target = await pageTarget(provider, endpoint, site.origin);
  const observed = await provider.inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: endpoint,
      allowed_origins: [site.origin],
      approved: true,
      target_id: target,
      observation_ms: 1_000,
      include_storage_keys: true,
    }),
  );
  if (!observed.ok) throw observed.error;
  assertObservation(observed.value, site.origin);
  const serialized = JSON.stringify(observed.value);
  for (const secret of [...SECRET_VALUES, "browser-secret-value"])
    if (serialized.includes(secret))
      throw new Error(
        `Passive browser result retained redacted value: ${secret}`,
      );

  const withSource = await provider.inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: endpoint,
      allowed_origins: [site.origin],
      approved: true,
      target_id: target,
      observation_ms: 200,
      include_accessibility_text: true,
      include_script_sources: true,
      include_console_text: true,
      console_text_approved: true,
      include_json_body_shapes: true,
      json_body_schema_approved: true,
      include_websocket_shapes: true,
      websocket_shape_approved: true,
    }),
  );
  if (!withSource.ok) throw withSource.error;
  const source = withSource.value.scripts.items.find(
    (script) =>
      script.source.included &&
      script.source.artifact.text.includes("reaSourceMarker"),
  );
  if (source === undefined)
    throw new Error(
      "Real Chrome did not return explicitly approved script source",
    );
  if (
    !withSource.value.accessibility.nodes.some((node) =>
      node.name?.includes("ax-private-label-value"),
    )
  )
    throw new Error(
      "Real Chrome did not return independently approved accessibility text",
    );
  assertSensitiveShapes(withSource.value);

  const bundle = await provider.analyzeBundle(
    analyzeWebBundleInputSchema.parse({
      cdp_endpoint: endpoint,
      allowed_origins: [site.origin],
      approved: true,
      target_id: target,
      observation_ms: 200,
      source_capture_approved: true,
      fetch_source_maps: true,
      source_map_fetch_approved: true,
    }),
  );
  if (!bundle.ok) throw bundle.error;
  assertBundleAnalysis(bundle.value);

  const captureDiff = await provider.compareCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: observed.value },
      after: { inspection: withSource.value },
    }),
  );
  if (!captureDiff.ok) throw captureDiff.error;
  if (
    captureDiff.value.dimensions.dom_structure.status !== "unchanged" ||
    captureDiff.value.dimensions.scripts.status !== "unchanged"
  )
    throw new Error("Real Chrome stable capture identities did not reconcile");

  const screenshot = await provider.captureScreenshot(
    captureWebScreenshotInputSchema.parse({
      cdp_endpoint: endpoint,
      allowed_origins: [site.origin],
      approved: true,
      screenshot_approved: true,
      target_id: target,
    }),
  );
  if (!screenshot.ok) throw screenshot.error;
  if (
    screenshot.value.viewport.width < 1 ||
    screenshot.value.viewport.height < 1 ||
    screenshot.value.artifact.bytes < 1
  )
    throw new Error("Real Chrome screenshot artifact was empty");
  const screenshotDiff = await provider.compareScreenshots(
    compareWebScreenshotsInputSchema.parse({
      before: screenshot.value.artifact,
      after: screenshot.value.artifact,
    }),
  );
  if (!screenshotDiff.ok) throw screenshotDiff.error;
  if (
    screenshotDiff.value.status !== "identical" ||
    screenshotDiff.value.changed_pixels !== 0
  )
    throw new Error("Real Chrome PNG artifact did not compare identically");

  const sessionPromise = provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: endpoint,
      allowed_origins: [site.origin],
      approved: true,
      target_id: target,
      observation_ms: 1_500,
    }),
  );
  await delay(250);
  site.triggerSessionNavigation();
  const session = await sessionPromise;
  if (!session.ok) throw session.error;
  if (
    !session.value.timeline.some(
      ({ type }) => type === "same_document_navigation",
    ) ||
    !session.value.target.final_url?.includes("/app/session-1")
  )
    throw new Error("Real Chrome same-origin SPA timeline was missing");

  pageProxy = await startPageCdpProxy(endpoint);
  await verifyPageScopedTransport(provider, pageProxy, site.origin);

  process.stdout.write(
    `${JSON.stringify({
      browser: observed.value.browser.product,
      endpoint,
      target,
      domNodes: observed.value.dom.nodes.length,
      accessibilityNodes: observed.value.accessibility.nodes.length,
      scripts: observed.value.scripts.items.length,
      networkRequests: observed.value.network.requests.length,
      consoleEvents: observed.value.console.events.length,
      websocketEvents: observed.value.network.websocket_events.length,
      bundleScripts: bundle.value.capture.scripts_analyzed,
      sourceMaps: bundle.value.observations.source_maps.processed,
      sessionEvents: session.value.timeline.length,
      pageScopedTransport: true,
      screenshotBytes: screenshot.value.artifact.bytes,
      verified: true,
    })}\n`,
  );
} finally {
  if (pageProxy !== undefined) await pageProxy.close();
  if (browser !== undefined) await stopProcess(browser);
  await site.close();
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function verifyPageScopedTransport(provider, proxy, origin) {
  const target = await pageTarget(provider, proxy.endpoint, origin);
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: proxy.endpoint,
    allowed_origins: [origin],
    approved: true,
    target_id: target,
    observation_ms: 100,
  });
  const observed = await provider.inspectPage(input);
  if (!observed.ok) throw observed.error;
  if (observed.value.dom.nodes.length < 1)
    throw new Error("Page-scoped CDP transport returned no DOM nodes");

  const controller = new AbortController();
  const cancelledPromise = provider.inspectPage(
    { ...input, observation_ms: 5_000 },
    { signal: controller.signal },
  );
  await delay(100);
  controller.abort();
  const cancelled = await cancelledPromise;
  if (
    cancelled.ok ||
    cancelled.error._tag !== "AnalysisCancelledError" ||
    cancelled.error.operation !== "inspect_web_page"
  )
    throw new Error(
      "Page-scoped CDP cancellation lost its operation semantics",
    );

  const disconnectedPromise = provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: proxy.endpoint,
      allowed_origins: [origin],
      approved: true,
      target_id: target,
      observation_ms: 5_000,
    }),
  );
  await delay(100);
  proxy.disconnectClients();
  const disconnected = await disconnectedPromise;
  if (
    !disconnected.ok ||
    disconnected.value.window.end_reason !== "target_terminated" ||
    !disconnected.value.timeline.some(
      ({ type }) => type === "target_terminated",
    )
  )
    throw new Error(
      "Page-scoped CDP disconnect was not reported as target_terminated",
    );
}

async function browserExecutable() {
  const candidates = [
    process.env.REA_BROWSER_EXECUTABLE,
    process.argv[2],
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through explicit and platform-default candidates.
    }
  }
  throw new Error(
    "No Chrome-family executable found; set REA_BROWSER_EXECUTABLE to run real-browser verification",
  );
}

async function pageTarget(provider, endpoint, origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: endpoint,
        allowed_origins: [origin],
        approved: true,
      }),
    );
    if (listed.ok && listed.value.targets.items[0] !== undefined)
      return listed.value.targets.items[0].target_id;
    await delay(25);
  }
  throw new Error("Real Chrome did not expose the local test page target");
}

function assertObservation(result, origin) {
  assertObservationInventory(result, origin);
  assertObservationEvents(result);
  assertObservationPrivacy(result);
  assertObservationMetadata(result);
}

function assertObservationInventory(result, origin) {
  if (result.target.origin !== origin)
    throw new Error("Real Chrome target origin was not preserved exactly");
  if (result.frames.length < 1 || result.dom.nodes.length < 1)
    throw new Error(
      `Real Chrome DOM/frame observation was empty: ${JSON.stringify({ frames: result.frames.length, domTotal: result.dom.total_nodes, domReturned: result.dom.nodes.length, limitations: result.limitations })}`,
    );
  if (result.accessibility.nodes.length < 1)
    throw new Error("Real Chrome accessibility observation was empty");
  if (
    result.accessibility.text_capture.status !== "not_approved" ||
    result.accessibility.nodes.some(
      (node) => node.name !== null || node.description !== null,
    )
  )
    throw new Error("Accessibility text was retained without approval");
  if (!result.scripts.items.some((script) => script.url.includes("/app.js")))
    throw new Error("Real Chrome script metadata was missing");
  if (!result.resources.some((resource) => resource.url.includes("/app.js")))
    throw new Error("Real Chrome resource metadata was missing");
}

function assertObservationEvents(result) {
  if (!result.network.requests.some((request) => request.url.includes("/api")))
    throw new Error(
      "Real Chrome attach-window network observation was missing",
    );
  const initiatedRequest = result.network.requests.find((request) =>
    request.url.includes("/api"),
  );
  if (
    !initiatedRequest?.initiator.url?.includes("/app.js") ||
    initiatedRequest.initiator.line === null ||
    initiatedRequest.initiator.column === null
  )
    throw new Error("Real Chrome script initiator stack was not normalized");
  if (result.console.events.length < 1)
    throw new Error(
      "Real Chrome attach-window console observation was missing",
    );
  if (result.network.websocket_events.length < 1)
    throw new Error("Real Chrome WebSocket metadata was missing");
}

function assertObservationPrivacy(result) {
  if (
    result.console.events.some(
      (event) => event.text_capture.status !== "not_approved",
    ) ||
    result.network.requests.some(
      (request) => request.body_shapes.status !== "not_approved",
    ) ||
    result.network.websocket_events.some(
      (event) => event.payload_shape !== null,
    )
  )
    throw new Error(
      "Sensitive text or payload shapes were retained without approval",
    );
}

function assertObservationMetadata(result) {
  if (!result.storage.local_storage_keys.includes("rea-storage-key"))
    throw new Error("Real Chrome local-storage key inventory was missing");
  if (!result.storage.indexed_db_names.includes("rea-browser-db"))
    throw new Error("Real Chrome IndexedDB name inventory was missing");
  if (!result.storage.cache_names.includes("rea-browser-cache"))
    throw new Error("Real Chrome cache name inventory was missing");
  if (
    !result.metadata.responses.some(({ csp }) =>
      csp.directives.some(({ name }) => name === "default-src"),
    ) ||
    !result.metadata.agent_hints.some(
      ({ declaration }) => declaration === "service-desc",
    )
  )
    throw new Error("Real Chrome safe response metadata was missing");
}

function assertBundleAnalysis(result) {
  if (
    result.capture.scripts_analyzed < 1 ||
    !result.observations.routes.some(({ value }) =>
      value.includes("/verified-route"),
    ) ||
    !result.observations.endpoints.some(({ value }) => value.includes("/api"))
  )
    throw new Error("Real Chrome static bundle findings were missing");
  if (
    result.observations.source_maps.status !== "included" ||
    !result.observations.source_maps.items.some(
      ({ status, original_sources, original_module_edges, mappings }) =>
        status === "included" &&
        original_sources.some(({ source }) =>
          source.includes("/src/main.ts"),
        ) &&
        original_module_edges.some(
          ({ specifier }) => specifier === "./dependency.ts",
        ) &&
        mappings.length > 0,
    )
  )
    throw new Error(
      `Real Chrome approved source-map reconstruction was missing: ${JSON.stringify(sourceMapSummary(result.observations.source_maps))}`,
    );
}

function assertSensitiveShapes(result) {
  const request = result.network.requests.find((item) =>
    item.url.includes("/api"),
  );
  const requestPaths = request?.body_shapes.request?.properties.map(
    ({ path }) => path,
  );
  const responsePaths = request?.body_shapes.response?.properties.map(
    ({ path }) => path,
  );
  if (!requestPaths?.includes("/token") || !responsePaths?.includes("/secret"))
    throw new Error("Real Chrome JSON request/response shapes were missing");
  const consoleText = result.console.events.flatMap(
    (event) => event.text_capture.values,
  );
  if (
    !consoleText.some(({ text }) => text.includes("[REDACTED]")) ||
    consoleText.some(({ text }) => text.includes("console-secret-value"))
  )
    throw new Error(
      "Real Chrome approved console text was not safely redacted",
    );
  if (
    !result.network.websocket_events.some(
      (event) =>
        event.payload_shape?.format === "json" &&
        event.payload_shape.json_shape?.properties.some(
          ({ path }) => path === "/token",
        ),
    )
  )
    throw new Error("Real Chrome WebSocket JSON shape was missing");
  const serialized = JSON.stringify({
    console: result.console,
    network: result.network,
  });
  for (const secret of [
    "request-body-secret-value",
    "response-secret-value",
    "websocket-secret-value",
    "console-secret-value",
  ])
    if (serialized.includes(secret))
      throw new Error(`Approved shape capture retained raw value: ${secret}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForExit(child);
  child.kill("SIGTERM");
  const exited = await Promise.race([
    gracefulExit.then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (!exited) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const forcedExit = waitForExit(child);
    child.kill("SIGKILL");
    await forcedExit;
  }
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}
