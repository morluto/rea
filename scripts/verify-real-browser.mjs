#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer } from "ws";

import { CdpBrowserProvider } from "../dist/browser/CdpBrowserProvider.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../dist/domain/browserObservation.js";

const SECRET_VALUES = [
  "network-secret-value",
  "console-secret-value",
  "storage-secret-value",
  "websocket-secret-value",
];

const executable = await browserExecutable();
const profile = await mkdtemp(join(tmpdir(), "rea-real-browser-"));
const site = await startSite();
let browser;
try {
  browser = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
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
  const port = await devtoolsPort(profile, browser, () => stderr);
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
      include_script_sources: true,
    }),
  );
  if (!withSource.ok) throw withSource.error;
  const source = withSource.value.scripts.items.find(
    (script) =>
      script.source.included &&
      script.source.content.includes("reaSourceMarker"),
  );
  if (source === undefined)
    throw new Error(
      "Real Chrome did not return explicitly approved script source",
    );

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
      verified: true,
    })}\n`,
  );
} finally {
  if (browser !== undefined) await stopProcess(browser);
  await site.close();
  await rm(profile, { recursive: true, force: true });
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

async function devtoolsPort(profile, child, stderr) {
  const activePort = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Chrome exited before CDP startup: ${stderr()}`);
    try {
      const [port] = (await readFile(activePort, "utf8")).trim().split("\n");
      const parsed = Number(port);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // Chrome writes this file only after its CDP listener is ready.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for Chrome CDP startup: ${stderr()}`);
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
  if (result.target.origin !== origin)
    throw new Error("Real Chrome target origin was not preserved exactly");
  if (result.frames.length < 1 || result.dom.nodes.length < 1)
    throw new Error(
      `Real Chrome DOM/frame observation was empty: ${JSON.stringify({ frames: result.frames.length, domTotal: result.dom.total_nodes, domReturned: result.dom.nodes.length, limitations: result.limitations })}`,
    );
  if (result.accessibility.nodes.length < 1)
    throw new Error("Real Chrome accessibility observation was empty");
  if (!result.scripts.items.some((script) => script.url.includes("/app.js")))
    throw new Error("Real Chrome script metadata was missing");
  if (!result.resources.some((resource) => resource.url.includes("/app.js")))
    throw new Error("Real Chrome resource metadata was missing");
  if (!result.network.requests.some((request) => request.url.includes("/api")))
    throw new Error(
      "Real Chrome attach-window network observation was missing",
    );
  if (result.console.events.length < 1)
    throw new Error(
      "Real Chrome attach-window console observation was missing",
    );
  if (result.network.websocket_events.length < 1)
    throw new Error("Real Chrome WebSocket metadata was missing");
  if (!result.storage.local_storage_keys.includes("rea-storage-key"))
    throw new Error("Real Chrome local-storage key inventory was missing");
  if (!result.storage.indexed_db_names.includes("rea-browser-db"))
    throw new Error("Real Chrome IndexedDB name inventory was missing");
  if (!result.storage.cache_names.includes("rea-browser-cache"))
    throw new Error("Real Chrome cache name inventory was missing");
}

async function startSite() {
  let port = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/app.js") === true) {
      response.setHeader("content-type", "text/javascript");
      response.end(script(port));
      return;
    }
    if (request.url?.startsWith("/api") === true) {
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true,"secret":"response-secret-value"}');
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><html><head><title>REA browser verifier</title></head><body><main><h1>Browser evidence</h1><button aria-label="Verify browser">Verify</button></main><script type="module" src="/app.js?token=script-query-secret"></script></body></html>',
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.on("message", () =>
        webSocket.send("websocket-response-secret"),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Local browser verifier did not bind a TCP port");
  port = address.port;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    async close() {
      for (const client of webSockets.clients) client.terminate();
      await new Promise((resolve) => webSockets.close(resolve));
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    },
  };
}

function script(port) {
  return `
  export const reaSourceMarker = "approved-source-marker";
  localStorage.setItem("rea-storage-key", "storage-secret-value");
  indexedDB.open("rea-browser-db", 1);
  caches.open("rea-browser-cache");
  const observe = () => {
    console.log("rea-browser-observation", "console-secret-value");
    fetch("/api?token=network-secret-value", {
      headers: { Authorization: "Bearer request-secret-value" }
    });
    const socket = new WebSocket("ws://127.0.0.1:${String(port)}/live?token=websocket-url-secret");
    socket.addEventListener("open", () => socket.send("websocket-secret-value"));
    socket.addEventListener("message", () => socket.close());
  };
  observe();
  setInterval(observe, 150);
`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
