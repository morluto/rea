import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startRuntimeFixtureBrowser } from "./browser-runtime-fixture-lifecycle.mjs";
import { closeVerifierResources } from "./verifier-cleanup.mjs";
import { startWorkerSite } from "../fixtures/browser-worker-site.mjs";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { webPageInspectionSchema } from "../../dist/domain/browserObservationSchemas.js";
import { mcpTextValue } from "./mcp-verifier-results.mjs";

/** Real workers, selected-origin negatives, source digests, cache delivery and owned cleanup through public adapters. */
export async function verifyBrowserWorkers(
  executable,
  entrypoint = fileURLToPath(new URL("../rea.mjs", import.meta.url)),
) {
  const site = await startWorkerSite();
  let fixture, browser, client, transport, primaryError, foreignSite, artifacts;
  try {
    artifacts = await mkdtemp(join(tmpdir(), "rea-worker-evidence-"));
    fixture = await startRuntimeFixtureBrowser(executable, site.origin);
    const endpoint = `http://127.0.0.1:${fixture.port}`;
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    await page.waitForURL(site.origin + "/", {
      waitUntil: "load",
      timeout: 20000,
    });
    await page.evaluate(() => window.ready);
    const other = await context.newPage();
    await other.goto(site.origin + "/other");
    await other.evaluate(() => window.ready);
    foreignSite = await startWorkerSite();
    const foreign = await context.newPage();
    await foreign.goto(foreignSite.origin);
    await foreign.evaluate(() => window.ready);
    const cdp = await context.newCDPSession(page);
    const target = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    const shared = targets.find(
      (t) => t.type === "shared_worker" && t.url.startsWith(site.origin + "/"),
    );
    const foreignWorker = targets.find(
      (t) => t.type === "worker" && t.url.startsWith(foreignSite.origin + "/"),
    );
    assert.ok(shared);
    assert.ok(foreignWorker);
    const input = {
      cdp_endpoint: endpoint,
      target_id: target,
      observation_ms: 2000,
      include_script_sources: true,
    };
    const cli = await promisify(execFile)(
      process.execPath,
      [
        entrypoint,
        "inspect-web-page",
        endpoint,
        target,
        "--include-script-sources",
        "--observation-ms",
        "100",
        "--json",
      ],
      { timeout: 40000, maxBuffer: 32 * 1024 * 1024 },
    );
    const cliResult = webPageInspectionSchema.parse(
      parseEvidence(JSON.parse(cli.stdout)).normalized_result,
    );
    const summarize = (result) =>
      result.workers
        .map((w) => ({
          type: w.type,
          ownership: w.observation.ownership,
          sources: w.observation.scripts.map((s) =>
            s.source.included ? s.source.artifact.sha256 : null,
          ),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    check(cliResult, site, target, false);
    const explicitCli = await promisify(execFile)(
      process.execPath,
      [
        entrypoint,
        "inspect-web-page",
        endpoint,
        target,
        "--include-script-sources",
        "--worker-target-ids",
        shared.targetId,
        "--observation-ms",
        "0",
        "--json",
      ],
      { timeout: 40000, maxBuffer: 32 * 1024 * 1024 },
    );
    check(
      webPageInspectionSchema.parse(
        parseEvidence(JSON.parse(explicitCli.stdout)).normalized_result,
      ),
      site,
      target,
      true,
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      stderr: "pipe",
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    client = new Client({ name: "worker-verifier", version: "1" });
    await client.connect(transport);
    const catalog = await client.listTools();
    const bundleTool = catalog.tools.find(
      (tool) => tool.name === "analyze_web_bundle",
    );
    assert.ok(bundleTool);
    assert.equal(
      Object.hasOwn(bundleTool.inputSchema.properties, "worker_target_ids"),
      false,
    );
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          entrypoint,
          "analyze-web-bundle",
          endpoint,
          target,
          "--worker-target-ids",
          shared.targetId,
          "--json",
        ],
        { timeout: 10000 },
      ),
      /worker-target-ids/,
    );
    const rejected = await client.callTool({
      name: "inspect_web_page",
      arguments: { ...input, worker_target_ids: [foreignWorker.targetId] },
    });
    assert.equal(rejected.isError, true);
    assert.match(mcpTextValue(rejected), /target_not_allowed/);
    const capture = async (arguments_, act) => {
      let action;
      const response = await client.callTool(
        { name: "inspect_web_page", arguments: arguments_ },
        {
          timeout: 40000,
          onprogress: (n) => {
            if (
              action === undefined &&
              n.message?.includes("Observing page events")
            ) {
              action = act?.() ?? Promise.resolve();
              void action.catch(() => undefined);
            }
          },
        },
      );
      assert.ok(action, "missing observation progress");
      await action;
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.deepEqual(
        JSON.parse(mcpTextValue(response)),
        response.structuredContent,
      );
      return webPageInspectionSchema.parse(
        parseEvidence(response.structuredContent).normalized_result,
      );
    };
    const defaultResult = await capture(input);
    check(defaultResult, site, target, false);
    assert.deepEqual(summarize(defaultResult), summarize(cliResult));
    const explicit = await capture(
      {
        ...input,
        worker_target_ids: [shared.targetId],
        include_console_text: true,
      },
      () => page.evaluate(() => window.act()),
    );
    check(explicit, site, target, true);
    const workerMetadata = explicit.workers.flatMap(
      (worker) => worker.observation.metadata?.responses ?? [],
    );
    for (const path of [
      "/worker-request",
      "/module-request",
      "/shared-request",
    ]) {
      const response = workerMetadata.find(
        (item) => item.url === site.origin + path,
      );
      assert.ok(response, `Missing retained worker response metadata: ${path}`);
      assert.equal(response.csp.nonce_count, 1);
      assert.equal(response.policies.corp, "same-origin");
      assert.ok(response.links.some((link) => link.rel.includes("mcp")));
    }
    assert.ok(
      explicit.workers.some((worker) =>
        worker.observation.metadata?.agent_hints.some(
          (hint) =>
            hint.declaration === "mcp" &&
            hint.trust === "page-declared-untrusted",
        ),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(workerMetadata),
      /worker-fixture-secret|worker-fixture-credential/,
    );
    const workerConsole = (result) =>
      result.workers.flatMap(
        (worker) => worker.observation.console_events ?? [],
      );
    assert.ok(
      workerConsole(explicit).some((event) =>
        event.text_capture.values.some(
          (value) => value.text === "worker fixture message",
        ),
      ),
    );
    const consoleRedacted = await capture(input, () =>
      page.evaluate(() => window.act()),
    );
    assert.ok(workerConsole(consoleRedacted).length > 0);
    assert.ok(
      workerConsole(consoleRedacted).every(
        (event) =>
          event.text_capture.status === "not_approved" &&
          event.text_capture.values.length === 0,
      ),
    );
    const savedCapture = join(artifacts, "worker-capture.json");
    await writeFile(savedCapture, JSON.stringify(explicit));
    const exported = await promisify(execFile)(
      process.execPath,
      [
        entrypoint,
        "export-web-scripts",
        savedCapture,
        join(artifacts, "exported"),
        "--json",
      ],
      { timeout: 40000, maxBuffer: 32 * 1024 * 1024 },
    );
    const exportedResult = parseEvidence(
      JSON.parse(exported.stdout),
    ).normalized_result;
    const manifest = JSON.parse(
      await readFile(join(artifacts, "exported", "manifest.json"), "utf8"),
    );
    const exportedWorkers = manifest.scripts.filter(
      (s) => s.source.kind === "worker-script",
    );
    for (const worker of explicit.workers)
      assert.ok(
        worker.observation.completeness.excluded.some(
          ({ section, reason }) =>
            section === "json_body_shapes" && reason === "not_approved",
        ),
      );
    assert.deepEqual(
      manifest.worker_coverage,
      explicit.workers.map((worker) => ({
        target_id: worker.target_id,
        completeness: worker.observation.completeness,
        limitations: worker.observation.limitations,
      })),
    );
    assert.equal(exportedWorkers.length, 4);
    for (const script of exportedWorkers) {
      const bytes = await readFile(
        join(
          exportedResult.analysis_input.input_path,
          script.content.relative_path,
        ),
      );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        script.content.sha256,
      );
    }
    assert.ok(
      explicit.workers
        .find((w) => w.type === "shared_worker")
        .observation.network_requests.some((r) =>
          r.url.endsWith("/shared-request"),
        ),
    );
    assert.ok(
      explicit.workers.some((w) =>
        w.observation.network_requests.some((r) =>
          r.url.endsWith("/worker-request"),
        ),
      ),
    );
    assert.ok(
      explicit.network.requests.some(
        (r) =>
          r.url.endsWith("/cached") &&
          r.response_source?.service_worker === true &&
          r.response_source?.service_worker_response_source === "cache-storage",
      ),
    );
    const terminated = await capture(input, () =>
      page.evaluate(() => window.worker.terminate()),
    );
    assert.ok(
      terminated.workers.some((w) =>
        w.observation.lifecycle.some((e) => e.event === "detached"),
      ),
    );
    const restarted = await capture(input, () =>
      page.evaluate(async () => {
        window.worker = new Worker("/worker.js");
        await new Promise((r) => (window.worker.onmessage = r));
      }),
    );
    assert.ok(
      restarted.workers.some(
        (w) =>
          w.observation.ownership === "page_related" &&
          w.observation.lifecycle.some((e) => e.event === "attached") &&
          w.observation.scripts.some(
            (s) => s.url.endsWith("/worker.js") && s.source.included,
          ),
      ),
    );
    const abort = new AbortController();
    let cancelled = false;
    try {
      await client.callTool(
        {
          name: "inspect_web_page",
          arguments: { ...input, observation_ms: 30000 },
        },
        {
          timeout: 40000,
          signal: abort.signal,
          onprogress: (n) => {
            if (n.message?.includes("Observing page events")) abort.abort();
          },
        },
      );
    } catch {
      cancelled = abort.signal.aborted;
    }
    assert.equal(cancelled, true);
    await client.ping();
    await capture({ ...input, observation_ms: 0 });
    assert.equal(page.isClosed(), false);
    assert.equal(other.isClosed(), false);
    const iframeOrigin = site.origin.replace("127.0.0.1", "localhost");
    await page.evaluate(async (origin) => {
      const frame = document.createElement("iframe");
      frame.src = origin + "/frame";
      const loaded = new Promise((resolve) => (frame.onload = resolve));
      document.body.append(frame);
      await loaded;
    }, iframeOrigin);
    const iframe = page
      .frames()
      .find((frame) => frame.url() === iframeOrigin + "/frame");
    assert.ok(iframe);
    await iframe.evaluate(() => window.ready);
    const iframeTargets = (await cdp.send("Target.getTargets")).targetInfos;
    assert.ok(
      iframeTargets.some(
        (t) => t.type === "iframe" && t.url === iframeOrigin + "/frame",
      ),
      "expected an out-of-process iframe target",
    );
    const iframeResult = await capture({
      ...input,
      allowed_origins: [site.origin, iframeOrigin],
      observation_ms: 100,
    });
    const iframeWorker = iframeResult.workers.find(
      (w) => w.url === iframeOrigin + "/worker.js",
    );
    assert.equal(iframeWorker?.observation.ownership, "page_related");
    assert.equal(iframeWorker.observation.page_target_id, target);
    assert.ok(
      iframeWorker.observation.scripts.some(
        (s) =>
          s.source.included &&
          s.source.artifact.text === site.sources["/worker.js"],
      ),
    );
    const iframeService = iframeResult.workers.find(
      (w) => w.url === iframeOrigin + "/service.js",
    );
    assert.equal(iframeService?.observation.ownership, "service_worker_client");
    assert.equal(iframeService.observation.selected_explicitly, false);
    assert.equal(iframeService.observation.page_target_id, target);
    assert.ok(
      iframeService.observation.scripts.some(
        (s) =>
          s.source.included &&
          s.source.artifact.text === site.sources["/service.js"],
      ),
    );
    const excludedFrame = await capture({ ...input, observation_ms: 0 });
    assert.ok(excludedFrame.workers.every((w) => w.origin !== iframeOrigin));
    await client.ping();
    await cdp.detach();
    return {
      cases: 14,
      workerConsoleSelected: true,
      workerResponseMetadata: true,
      workerConsoleRedacted: true,
      outOfProcessIframeWorker: true,
      outOfProcessIframeServiceWorker: true,
      originBoundary: true,
      exportedWorkerSources: exportedWorkers.length,
      browser: browser.version(),
      workerTypes: ["worker", "shared_worker", "service_worker"],
      sourceDigests: true,
      cliMcpParity: true,
      networkAndServiceWorkerResponse: true,
      cancellationRecovery: true,
    };
  } catch (cause) {
    primaryError = cause;
    throw cause;
  } finally {
    await closeVerifierResources(
      [
        () => client?.close(),
        () => transport?.close(),
        () => browser?.close(),
        () => fixture?.close(),
        () => site.close(),
        () => foreignSite?.close(),
        () =>
          artifacts === undefined
            ? undefined
            : rm(artifacts, { recursive: true, force: true }),
      ],
      primaryError,
    );
  }
}
function check(result, site, target, explicit) {
  const workers = result.workers;
  const related = workers.filter(
    (w) => w.observation.ownership === "page_related",
  );
  assert.equal(related.length, 2);
  assert.ok(
    workers.some(
      (w) =>
        w.type === "worker" &&
        w.observation.ownership === "unknown" &&
        w.observation.scripts.length === 0,
    ),
  );
  assert.ok(
    workers.some(
      (w) =>
        w.type === "service_worker" &&
        w.observation.ownership === "service_worker_client",
    ),
  );
  const shared = workers.find((w) => w.type === "shared_worker");
  assert.equal(shared.observation.ownership, "unknown");
  assert.equal(shared.observation.selected_explicitly, explicit);
  for (const worker of workers) {
    assert.equal(worker.origin, site.origin);
    if (worker.observation.ownership !== "unknown")
      assert.equal(worker.observation.page_target_id, target);
    for (const script of worker.observation.scripts) {
      assert.equal(script.source.included, true);
      const expected = site.sources[new URL(script.url).pathname];
      assert.equal(script.source.artifact.text, expected);
      assert.equal(
        script.source.artifact.sha256,
        createHash("sha256").update(expected).digest("hex"),
      );
    }
  }
  assert.equal(shared.observation.scripts.length, explicit ? 1 : 0);
  assert.ok(
    related.every(
      (w) =>
        w.observation.execution_contexts.length > 0 &&
        w.observation.scripts.length > 0,
    ),
  );
}
