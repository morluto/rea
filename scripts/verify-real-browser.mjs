#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpBrowserProvider } from "../dist/browser/CdpBrowserProvider.js";
import { waitForBrowserDevtoolsPort } from "../dist/browser/BrowserProcessStartup.js";
import { PlaywrightBrowserScenarioProvider } from "../dist/browser/PlaywrightBrowserScenarioProvider.js";
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
import {
  assertBundleAnalysis,
  assertObservation,
  assertSensitiveShapes,
} from "./lib/browser-verifier-assertions.mjs";
import {
  assertScenarioCapture,
  browserScenario,
  runScenarioCli,
  scenarioProfiles,
} from "./lib/browser-scenario-verifier.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const SECRET_VALUES = [
  "network-secret-value",
  "console-secret-value",
  "storage-secret-value",
  "websocket-secret-value",
  "ax-private-label-value",
];
const REAL_BROWSER_STARTUP_TIMEOUT_MS = 30_000;
const verifierRun = createVerifierRun();

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
    timeoutMs: REAL_BROWSER_STARTUP_TIMEOUT_MS,
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
      include_storage_fingerprints: true,
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
      observation_ms: 1_000,
      include_accessibility_text: true,
      include_script_sources: true,
      source_capture_approved: true,
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
  const attachedScenario = await runScenarioCli(
    browserScenario(
      {
        mode: "connect",
        cdp_endpoint: endpoint,
        target_id: target,
        ownership: "external",
        cleanup: "disconnect-only",
      },
      site.origin,
    ),
    {
      REA_BROWSER_SCENARIO_CDP_ENDPOINTS_JSON: JSON.stringify([endpoint]),
      REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON: JSON.stringify([site.origin]),
    },
  );
  if (
    attachedScenario.normalized_result?.browser?.cleanup !==
      "disconnected-external" ||
    attachedScenario.normalized_result?.browser?.process_ownership !==
      "external"
  )
    throw new Error(
      "Scenario CLI did not report external disconnect ownership",
    );
  const versionResponse = await fetch(`${endpoint}/json/version`);
  if (!versionResponse.ok || browser.exitCode !== null)
    throw new Error("Scenario attachment terminated its external browser");

  const profilesBefore = await scenarioProfiles();
  const launchedScenario =
    await new PlaywrightBrowserScenarioProvider().captureScenario(
      browserScenario(
        {
          mode: "launch",
          executable_path: executable,
          headless: true,
          user_data: "temporary-owned",
          cleanup: "close-and-delete-profile",
        },
        site.origin,
      ),
    );
  if (!launchedScenario.ok) throw launchedScenario.error;
  if (
    launchedScenario.value.browser.cleanup !== "terminated-owned-process" ||
    launchedScenario.value.browser.process_ownership !== "provider-owned"
  )
    throw new Error("Scenario launch did not report owned-process cleanup");
  const profilesAfter = await scenarioProfiles();
  if ([...profilesAfter].some((entry) => !profilesBefore.has(entry)))
    throw new Error("Scenario launch retained a temporary browser profile");
  assertScenarioCapture(launchedScenario.value);
  for (const secret of ["network-secret-value", "websocket-url-secret"])
    if (
      JSON.stringify([attachedScenario, launchedScenario.value]).includes(
        secret,
      )
    )
      throw new Error(`Browser scenario retained sensitive value: ${secret}`);

  process.stdout.write(
    `${JSON.stringify({
      verifier_run: await completeVerifierRun(verifierRun),
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
      browserScenarioCli: true,
      browserScenarioAttachCleanup: "disconnected-external",
      browserScenarioLaunchCleanup: "terminated-owned-process",
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
