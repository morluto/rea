import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createBrowserScenarioProvider } from "../../dist/composition/browserScenario.js";
import { PlaywrightScenarioEvents } from "../../dist/browser/PlaywrightScenarioEvents.js";
import { BrowserScenarioSecrets } from "../../dist/browser/BrowserScenarioSecrets.js";
import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";
import { compareBrowserScenarios } from "../../dist/domain/browserScenarioDiff.js";
import { browserScenarioCaptureSchema } from "../../dist/domain/browserScenarioCapture.js";
import { parseEvidence } from "../../dist/domain/evidence.js";

const document = (path) => {
  if (path.startsWith("/nested"))
    return `<script>throw new Error("nested popup failure")</script>
      <script>opener.postMessage("nested-ready", "*")</script>`;
  if (path.startsWith("/popup"))
    return `<script>throw new Error("popup failure")</script>
      <script>onmessage = e => {
        if (e.data === "nested-ready") opener.postMessage("popup-ready", "*");
      }; window.open("/nested");</script><iframe src="/child"></iframe>`;
  if (path.startsWith("/child")) return "child frame";
  return `<script>onmessage = e => {
    if (e.data === "popup-ready") document.body.dataset.ready = "true";
  }</script><button onclick="window.open('/redirect')">Open popup</button>`;
};

const scenarioFor = (executable, origin, events) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: executable },
    start_url: { url: origin },
    actions: [
      {
        step_id: "open",
        action: "click",
        locator: { kind: "role", role: "button", name: "Open popup" },
      },
      {
        step_id: "ready",
        action: "wait_for",
        locator: { kind: "css", selector: "body[data-ready=true]" },
        state: "attached",
        timeout_ms: 10_000,
      },
    ],
    capture: { events, after_each_step: [], at_end: [] },
  });

const capture = async (scenario) => {
  const result = await createBrowserScenarioProvider(
    process.env,
  ).captureScenario(scenario);
  if (!result.ok) throw result.error;
  assert.ok(
    result.value.steps.every((step) => step.status === "completed"),
    JSON.stringify(result.value.steps),
  );
  return result.value;
};

const assertNetwork = (result, origin) => {
  for (const path of ["/redirect", "/popup", "/nested"])
    for (const kind of ["request", "response"])
      assert.equal(
        result.events.items.filter(
          (event) => event.kind === kind && event.url?.url === origin + path,
        ).length,
        1,
        `${kind} ${path} must be captured exactly once`,
      );
  assert.equal(result.completeness.equality_eligible, true);
  assert.equal(compareWithSelf(result).overall_status, "unchanged");
};

const compareWithSelf = (capture) =>
  compareBrowserScenarios({
    before_scenario: capture,
    after_scenario: capture,
    normalization: { rules: [] },
  });

const verifySharedContext = async (executable, origin) => {
  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const foreign = await context.newPage();
    const secrets = BrowserScenarioSecrets.resolve(
      scenarioFor(executable, origin, ["network"]),
      {},
    );
    assert.ok(secrets);
    const events = new PlaywrightScenarioEvents({
      page,
      context,
      ownsContext: false,
      enabled: new Set(["network"]),
      secrets,
    });
    await Promise.all([
      page.goto(origin),
      foreign.goto(origin + "/popup?unrelated-tab"),
    ]);
    await page.getByRole("button", { name: "Open popup", exact: true }).click();
    await page.locator("body[data-ready=true]").waitFor({ timeout: 10_000 });
    const retained = events.result().items;
    assert.ok(
      events
        .limitations()
        .some((value) => value.includes("Shared-context network")),
    );
    assert.ok(retained.some((event) => event.url?.url === origin + "/"));
    assert.ok(!JSON.stringify(retained).includes("unrelated-tab"));
  } finally {
    await browser.close();
  }
};

const verifyTransports = async (executable, origin) => {
  const scenario = scenarioFor(executable, origin, ["network"]);
  const entrypoint = fileURLToPath(new URL("../rea.mjs", import.meta.url));
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    REA_LOG_LEVEL: "silent",
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entrypoint,
      "capture-browser-scenario",
      JSON.stringify(scenario),
      "--json",
    ],
    { env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  assertNetwork(
    browserScenarioCaptureSchema.parse(
      parseEvidence(JSON.parse(stdout)).normalized_result,
    ),
    origin,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "popup-real-e2e", version: "1" });
  try {
    await client.connect(transport);
    const captured = await client.callTool(
      { name: "capture_browser_scenario", arguments: scenario },
      { timeout: 60_000 },
    );
    assert.notEqual(captured.isError, true, JSON.stringify(captured));
    const evidence = parseEvidence(captured.structuredContent);
    assertNetwork(
      browserScenarioCaptureSchema.parse(evidence.normalized_result),
      origin,
    );
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
};

/** Verify popup timing, selection, coverage, and shared-context isolation on Chromium. */
export async function verifyPopupEventCoverage(executable) {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/popup" });
      response.end();
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(document(request.url ?? "/"));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    assertNetwork(
      await capture(scenarioFor(executable, origin, ["network"])),
      origin,
    );
    const errors = await capture(
      scenarioFor(executable, origin, ["page-errors"]),
    );
    assert.deepEqual(
      errors.events.items.map((event) => event.kind),
      ["page-error", "page-error"],
    );
    assert.ok(
      errors.events.items.some((event) => event.message === "popup failure"),
    );
    assert.ok(
      errors.events.items.some(
        (event) => event.message === "nested popup failure",
      ),
    );
    for (const family of ["frames", "workers", "websockets", "downloads"]) {
      const result = await capture(scenarioFor(executable, origin, [family]));
      assert.equal(result.completeness.equality_eligible, false);
      assert.ok(result.completeness.missing_sections.includes("events"));
      assert.equal(compareWithSelf(result).overall_status, "unknown");
      assert.ok(
        result.limitations.some((limitation) =>
          limitation.includes(`Popup ${family}`),
        ),
      );
    }
    await verifySharedContext(executable, origin);
    await verifyTransports(executable, origin);
    return {
      mocked: false,
      initial_network: true,
      redirects: true,
      nested_popups: true,
      unselected_lifecycle_absent: true,
      popup_event_gaps_explicit: true,
      incomplete_comparison_unknown: true,
      shared_context_isolation: true,
      cli: true,
      stdio_mcp: true,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
}
