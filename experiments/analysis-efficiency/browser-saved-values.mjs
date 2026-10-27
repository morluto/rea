/** Compare complete real PocketBase create/update/read tasks through public MCP. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { createVerifierCommands } from "../../scripts/lib/verify-commands.mjs";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    mode: { type: "string" },
    output: { type: "string" },
    origin: { type: "string" },
    credentials: { type: "string" },
    browser: { type: "string" },
    "source-only": { type: "boolean", default: false },
  },
});
assert.ok(
  values.repository &&
    values.output &&
    values.origin &&
    values.credentials &&
    values.browser,
);
assert.ok(["before", "after"].includes(values.mode));
const repo = resolve(values.repository),
  output = resolve(values.output),
  origin = new URL(values.origin).origin;
assert.equal(
  new URL(origin).hostname,
  "127.0.0.1",
  "Use an owned loopback fixture",
);
await mkdir(output, { mode: 0o700 });
const credentials = JSON.parse(await readFile(values.credentials, "utf8"));
const require = createRequire(join(repo, "package.json"));
const { chromium } = require("playwright-core");
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
const commands = await createVerifierCommands();
const profile = await mkdtemp(join(tmpdir(), "rea-saved-values-"));
const env = {
  PATH: process.env.PATH,
  NODE_OPTIONS: "--max-old-space-size=3072",
  UV_THREADPOOL_SIZE: "2",
  REA_LOG_LEVEL: "silent",
  REA_MCP_TOOL_FAMILIES: "browser,application,session",
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_TEST_EMAIL: credentials.email,
  REA_TEST_PASSWORD: credentials.password,
  REA_TEST_WHOLE_JSON: JSON.stringify({ token: "private-token-729d" }),
};
const calls = [];
const runs = [];
let catalog;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "scripts/rea.mjs"), "mcp"],
  cwd: repo,
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const client = new Client({ name: "rea-saved-values-real-app", version: "1" });
commands.adopt(client, "saved-values MCP client");
const tokenHeader = (saved) => ({
  name: "Authorization",
  value: saved
    ? { source: "saved", name: "token" }
    : { source: "local_storage", key: "rea_auth", json_pointer: "/token" },
});
const decodeBodies = (value) => {
  const bodies = [];
  const visit = (x) => {
    if (x && typeof x === "object") {
      if (x.encoding === "base64" && typeof x.content === "string") {
        try {
          bodies.push(
            JSON.parse(Buffer.from(x.content, "base64").toString("utf8")),
          );
        } catch {}
      }
      for (const v of Object.values(x)) visit(v);
    }
  };
  visit(value);
  return bodies;
};
async function invoke(name, args) {
  const defs = catalog.tools.filter((t) => t.name === name);
  assert.equal(defs.length, 1);
  const start = performance.now();
  const result = await client.callTool(
    { name, arguments: args },
    { toolDefinition: defs[0], timeout: 90000 },
  );
  calls.push({
    name,
    arguments: args,
    result,
    elapsed_ms: performance.now() - start,
  });
  assert.notEqual(
    result.isError,
    true,
    `${name} failed; retain the local receipt`,
  );
  return result.structuredContent;
}
const loginActions = (saved) => [
  {
    step_id: "email",
    action: "fill",
    locator: { kind: "css", selector: "#email" },
    value: { source: "secret", secret_id: "email" },
  },
  {
    step_id: "password",
    action: "fill",
    locator: { kind: "css", selector: "#password" },
    value: { source: "secret", secret_id: "password" },
  },
  {
    step_id: "login",
    action: "click",
    locator: { kind: "css", selector: "#login" },
    ...(saved
      ? {
          save_response: {
            method: "POST",
            path: "/api/collections/_superusers/auth-with-password",
            save: [{ name: "token", json_pointer: "/token", secret: true }],
          },
        }
      : {}),
    timeout_ms: 10000,
  },
  {
    step_id: "ready",
    action: "wait_for",
    locator: { kind: "css", selector: '#result[data-ready="yes"]' },
    state: "visible",
    timeout_ms: 10000,
  },
];
const edits = (id, saved) => [
  {
    step_id: "update",
    action: "request",
    method: "PATCH",
    path: `/api/collections/rea_items/records/${id}`,
    headers: [tokenHeader(saved)],
    json: { title: `record-${id}`, quantity: saved ? "{saved:quantity}" : 11 },
    expected_status: [200],
  },
  {
    step_id: "read",
    action: "request",
    method: "GET",
    path: `/api/collections/rea_items/records/${id}?at=${id}`,
    headers: [tokenHeader(saved)],
    expected_status: [200],
  },
  {
    step_id: "open",
    action: "goto",
    destination: { url: `${origin}/api/collections/rea_items/records/${id}` },
    wait_until: "load",
  },
];
const captureOptions = {
  after_each_step: ["url"],
  at_end: ["url", "accessibility"],
  events: ["network"],
  network: { request_body: true, response_body: true, header_values: true },
};
try {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: resolve(values.browser),
    headless: true,
    args: ["--remote-debugging-port=0", "--no-sandbox"],
  });
  commands.adopt(context, "owned saved-values Chromium context");
  const page = context.pages()[0];
  await page.goto(origin, { waitUntil: "networkidle" });
  const port = (
    await readFile(join(profile, "DevToolsActivePort"), "utf8")
  ).split("\n")[0];
  const endpoint = `http://127.0.0.1:${port}`;
  const targets = await (await fetch(endpoint + "/json/list")).json();
  const target = targets.find(
    (t) => t.type === "page" && t.url === origin + "/",
  );
  assert.ok(target);
  const browser = {
    mode: "connect",
    cdp_endpoint: endpoint,
    target_id: target.id,
  };
  const declared = [
    { secret_id: "email", environment_variable: "REA_TEST_EMAIL" },
    { secret_id: "password", environment_variable: "REA_TEST_PASSWORD" },
  ];
  const scenario = (actions, secrets = declared) => ({
    browser,
    start_url: { url: origin + "/" },
    secrets,
    actions,
    capture: captureOptions,
    detail: "summary",
  });
  await client.connect(transport);
  catalog = await client.listTools();
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  for (const temperature of values["source-only"] ? [] : ["cold", "warm"]) {
    const saved = values.mode === "after";
    const start = performance.now(),
      firstCall = calls.length;
    const create = {
      step_id: "create",
      action: "request",
      method: "POST",
      path: "/api/collections/rea_items/records",
      headers: [tokenHeader(saved)],
      json: { title: `created-${temperature}`, quantity: 11 },
      expected_status: [200, 201],
      ...(saved
        ? {
            save: [
              { name: "record_id", json_pointer: "/id" },
              { name: "quantity", json_pointer: "/quantity" },
            ],
          }
        : {}),
    };
    const firstActions = [...loginActions(saved), create];
    if (saved) firstActions.push(...edits("{saved:record_id}", true));
    const first = await invoke(
      "capture_browser_scenario",
      scenario(firstActions),
    );
    const firstSummary = first.normalized_result;
    assert.ok(
      firstSummary.summary.steps.every((step) => step.status === "completed"),
      "Initial capture must complete",
    );
    let final = first;
    let id;
    let legacyPreReadObserved;
    if (!saved) {
      const selected = await invoke("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: firstSummary.parent_evidence_id,
        },
        view: {
          kind: "browser-scenario",
          collection: "events",
          step_indices: [firstActions.length],
          event_kinds: ["network-content"],
          limit: 16,
        },
      });
      assert.equal(selected.normalized_result.coverage.exhausted, true);
      const records = decodeBodies(selected.normalized_result).filter(
        (b) => b?.collectionName === "rea_items" && typeof b.id === "string",
      );
      assert.equal(records.length, 1);
      id = records[0].id;
      final = await invoke(
        "capture_browser_scenario",
        scenario(edits(id, false), []),
      );
    }
    assert.ok(
      final.normalized_result.summary.steps.every(
        (step) => step.status === "completed",
      ),
      "Completed task must not hide failed actions",
    );
    const completedMs = performance.now() - start,
      taskCalls = calls.length - firstCall;
    const path = join(output, `${temperature}-evidence.json`);
    await invoke("export_evidence_bundle", { path });
    const bundle = JSON.parse(await readFile(path, "utf8"));
    const parent = bundle.records.find(
      (r) => r.evidence_id === final.normalized_result.parent_evidence_id,
    );
    assert.ok(parent);
    if (!saved) {
      const legacy = bundle.records.find(
        (record) => record.evidence_id === firstSummary.parent_evidence_id,
      );
      assert.ok(legacy);
      const login = decodeBodies(legacy.normalized_result).filter(
        (body) => typeof body?.token === "string",
      );
      assert.equal(login.length, 1);
      const preReadLogin = decodeBodies({
        events: legacy.normalized_result.events.items.filter(
          (event) => event.step_index < firstActions.length,
        ),
      }).filter((body) => typeof body?.token === "string");
      legacyPreReadObserved = preReadLogin.length === 1;
      if (legacyPreReadObserved) {
        assert.ok(
          !preReadLogin[0].token.startsWith("[REDACTED:"),
          "An observed pre-read login response must preserve its unmarked token",
        );
        const later = legacy.normalized_result.events.items.filter(
          (event) => event.step_index >= firstActions.length,
        );
        assert.ok(
          !JSON.stringify({
            events: later,
            bodies: decodeBodies({ events: later }),
          }).includes(preReadLogin[0].token),
          "Post-read facts must use the current page-value policy",
        );
      }
    }
    const recordBodies = decodeBodies(parent.normalized_result).filter(
      (b) => b?.collectionName === "rea_items" && typeof b.id === "string",
    );
    assert.ok(recordBodies.length >= 2);
    if (saved) id = recordBodies[0].id;
    assert.ok(recordBodies.every((b) => b.id === id));
    assert.ok(
      recordBodies.some((b) => b.title === `record-${id}` && b.quantity === 11),
    );
    const read = await fetch(
      `${origin}/api/collections/rea_items/records/${id}`,
    );
    assert.equal(read.status, 200);
    const actual = await read.json();
    assert.equal(actual.title, `record-${id}`);
    assert.equal(actual.quantity, 11);
    const requestBodies = decodeBodies(parent.normalized_result).filter(
      (b) => b?.title === `record-${id}` && !Object.hasOwn(b, "collectionName"),
    );
    assert.ok(requestBodies.length > 0);
    assert.ok(requestBodies.every((b) => typeof b.quantity === "number"));
    if (saved) {
      const loginBodies = decodeBodies(parent.normalized_result).filter(
        (b) => typeof b?.token === "string",
      );
      assert.equal(loginBodies.length, 1);
      assert.ok(loginBodies[0].token.startsWith("[REDACTED:"));
    }
    runs.push({
      temperature,
      legacy_pre_read_observed: legacyPreReadObserved,
      elapsed_ms: completedMs,
      task_calls: taskCalls,
      evidence_id: parent.evidence_id,
      record_id: id,
      quantity_type: typeof actual.quantity,
    });
  }
  if (values["source-only"]) {
    assert.equal(values.mode, "after");
    const sourceScenario = scenario(
      [
        {
          step_id: "source",
          action: "request",
          method: "GET",
          path: "/escaped-values.json?credential=source-token",
          save: [
            { name: "token", json_pointer: "/token", secret: true },
            { name: "code", json_pointer: "/code", secret: true },
          ],
        },
        {
          step_id: "later",
          action: "request",
          method: "GET",
          path: "/escaped-values.json",
        },
      ],
      [],
    );
    const captured = await invoke("capture_browser_scenario", sourceScenario);
    assert.ok(
      captured.normalized_result.summary.steps.every(
        (step) => step.status === "completed",
      ),
    );
    const path = join(output, "source-evidence.json");
    await invoke("export_evidence_bundle", { path });
    const bundle = JSON.parse(await readFile(path, "utf8"));
    const parent = bundle.records.find(
      (record) =>
        record.evidence_id === captured.normalized_result.parent_evidence_id,
    );
    assert.ok(parent);
    const sourceRequests = parent.normalized_result.events.items.filter(
      (event) =>
        event.kind === "request" &&
        event.step_index === 1 &&
        event.url.url.includes("/escaped-values.json"),
    );
    assert.equal(sourceRequests.length, 1);
    const transaction = sourceRequests[0].transaction_id;
    const sourceEvents = parent.normalized_result.events.items.filter(
      (event) => event.transaction_id === transaction,
    );
    assert.ok(sourceEvents.some((event) => event.kind === "response"));
    assert.ok(
      !JSON.stringify(sourceEvents).includes("source-token"),
      "Source transaction metadata must not retain the value learned from its response",
    );
    const bodies = decodeBodies(parent.normalized_result).filter(
      (body) =>
        Object.hasOwn(body ?? {}, "token") && Object.hasOwn(body, "code"),
    );
    assert.equal(
      bodies.length,
      2,
      "Both actual source and later response must be observed",
    );
    for (const body of bodies) {
      assert.equal(body.token, "[REDACTED:page:source.token]");
      assert.equal(body.code, "[REDACTED:page:source.code]");
    }
    const expected = Buffer.from(
      '{"token":"[REDACTED:page:source.token]","code":"[REDACTED:page:source.code]","unknown":1e-400}',
    ).toString("base64");
    assert.equal(
      JSON.stringify(parent.normalized_result).split(JSON.stringify(expected))
        .length - 1,
      2,
      "Both source bodies must preserve the unmarked numeric spelling exactly",
    );
    const metadata = await invoke("capture_browser_scenario", {
      ...sourceScenario,
      capture: {
        ...sourceScenario.capture,
        network: {
          request_body: false,
          response_body: false,
          header_values: false,
        },
      },
    });
    assert.ok(
      metadata.normalized_result.summary.steps.every(
        (step) => step.status === "completed",
      ),
    );
    const metadataPath = join(output, "metadata-evidence.json");
    await invoke("export_evidence_bundle", { path: metadataPath });
    const metadataBundle = JSON.parse(await readFile(metadataPath, "utf8"));
    const metadataParent = metadataBundle.records.find(
      (record) =>
        record.evidence_id === metadata.normalized_result.parent_evidence_id,
    );
    assert.ok(metadataParent);
    const metadataRequest = metadataParent.normalized_result.events.items.find(
      (event) =>
        event.kind === "request" &&
        event.step_index === 1 &&
        event.url.url.includes("/escaped-values.json"),
    );
    assert.ok(metadataRequest);
    assert.equal(metadataRequest.url.origin, origin);
    assert.ok(metadataRequest.url.url.includes("/escaped-values.json"));
    assert.ok(!metadataRequest.url.url.includes("source-token"));
    assert.ok(
      !metadataParent.normalized_result.events.items.some(
        (event) => event.kind === "network-content",
      ),
    );
    const countUrl = `${origin}/api/collections/rea_items/records?perPage=1`;
    const beforeCount = (await (await fetch(countUrl)).json()).totalItems;
    assert.ok(Number.isSafeInteger(beforeCount));
    const whole = await invoke("capture_browser_scenario", {
      ...sourceScenario,
      start_url: { url: origin + "/whole-json.html" },
      secrets: [
        {
          secret_id: "whole_json",
          environment_variable: "REA_TEST_WHOLE_JSON",
        },
      ],
      storage: {
        local_storage: [
          {
            origin,
            entries: [
              {
                name: "whole_json",
                value: { source: "secret", secret_id: "whole_json" },
              },
            ],
          },
        ],
      },
      actions: [
        {
          step_id: "settled",
          action: "wait_for",
          locator: { kind: "css", selector: '#result[data-ready="yes"]' },
          state: "visible",
          timeout_ms: 10000,
        },
      ],
    });
    assert.ok(
      whole.normalized_result.summary.steps.every(
        (step) => step.status === "completed",
      ),
    );
    const wholePath = join(output, "whole-json-evidence.json");
    await invoke("export_evidence_bundle", { path: wholePath });
    const wholeBundle = JSON.parse(await readFile(wholePath, "utf8"));
    const wholeParent = wholeBundle.records.find(
      (record) =>
        record.evidence_id === whole.normalized_result.parent_evidence_id,
    );
    assert.ok(wholeParent);
    const post = wholeParent.normalized_result.events.items.find(
      (event) => event.kind === "request" && event.method === "POST",
    );
    assert.ok(post);
    const postEvents = wholeParent.normalized_result.events.items.filter(
      (event) => event.transaction_id === post.transaction_id,
    );
    assert.ok(
      postEvents.some(
        (event) =>
          event.kind === "network-content" &&
          event.phase === "request" &&
          event.body.state === "unavailable",
      ),
    );
    const postResponse = postEvents.find((event) => event.kind === "response");
    assert.ok(postResponse && [400, 401, 403].includes(postResponse.status));
    assert.ok(!JSON.stringify(wholeParent).includes("private-token-729d"));
    assert.equal(
      (await (await fetch(countUrl)).json()).totalItems,
      beforeCount,
    );
    const followup = await invoke("capture_browser_scenario", {
      ...sourceScenario,
      start_url: { url: origin + "/immediate-followup.html" },
      capture: {
        ...sourceScenario.capture,
        events: [...sourceScenario.capture.events, "console"],
        after_each_step: [
          ...sourceScenario.capture.after_each_step,
          "screenshot",
        ],
        at_end: [...sourceScenario.capture.at_end, "screenshot"],
      },
      actions: [
        {
          step_id: "exchange",
          action: "click",
          locator: { kind: "css", selector: "#run" },
          save_response: {
            method: "GET",
            path: "/escaped-values.json",
            save: [{ name: "token", json_pointer: "/token", secret: true }],
          },
          timeout_ms: 10000,
        },
        {
          step_id: "settled",
          action: "wait_for",
          locator: { kind: "css", selector: '#result[data-ready="yes"]' },
          state: "visible",
          timeout_ms: 10000,
        },
      ],
    });
    const followupPath = join(output, "followup-evidence.json");
    await invoke("export_evidence_bundle", { path: followupPath });
    const followupBundle = JSON.parse(await readFile(followupPath, "utf8"));
    const followupParent = followupBundle.records.find(
      (record) =>
        record.evidence_id === followup.normalized_result.parent_evidence_id,
    );
    assert.ok(followupParent);
    assert.equal(await page.locator("#sensitive").innerText(), "source-token");
    assert.equal(followupParent.normalized_result.steps.length, 3);
    assert.ok(
      followupParent.normalized_result.steps.every(
        (step) =>
          step.artifacts.screenshot.state === "missing" &&
          step.completeness.missing_sections.includes("screenshot"),
      ),
    );
    assert.ok(
      followupParent.normalized_result.completeness.missing_sections.includes(
        "screenshot",
      ),
    );
    const consoleEvents = followupParent.normalized_result.events.items.filter(
      (event) => event.kind === "console" && event.text.includes("REDACTED"),
    );
    assert.equal(consoleEvents.length, 1);
    assert.ok(
      !JSON.stringify(followupParent.normalized_result.events.items).includes(
        "source-token",
      ),
    );
    assert.ok(
      followup.normalized_result.summary.steps.every(
        (step) => step.status === "completed",
      ),
    );

    const followupPost = followupParent.normalized_result.events.items.find(
      (event) => event.kind === "request" && event.method === "POST",
    );
    assert.ok(followupPost);
    const followupEvents = followupParent.normalized_result.events.items.filter(
      (event) => event.transaction_id === followupPost.transaction_id,
    );
    assert.ok(!JSON.stringify(followupEvents).includes("source-token"));
    const followupBodies = decodeBodies({ events: followupEvents });
    assert.ok(
      followupBodies.some(
        (body) => body?.token === "[REDACTED:page:exchange.token]",
      ),
    );
    assert.ok(
      followupEvents.some(
        (event) => event.kind === "response" && event.status === 403,
      ),
    );
    assert.equal(
      (await (await fetch(countUrl)).json()).totalItems,
      beforeCount,
    );
    const publicScreenshot = await invoke("capture_browser_scenario", {
      ...sourceScenario,
      start_url: { url: origin + "/immediate-followup.html" },
      actions: [
        { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
      ],
      capture: {
        ...sourceScenario.capture,
        events: [],
        network: {
          request_body: false,
          response_body: false,
          header_values: false,
        },
        after_each_step: [],
        at_end: ["screenshot"],
      },
    });
    const publicPath = join(output, "public-screenshot-evidence.json");
    await invoke("export_evidence_bundle", { path: publicPath });
    const publicBundle = JSON.parse(await readFile(publicPath, "utf8"));
    const publicParent = publicBundle.records.find(
      (record) =>
        record.evidence_id ===
        publicScreenshot.normalized_result.parent_evidence_id,
    );
    assert.ok(publicParent);
    assert.equal(await page.locator("#sensitive").innerText(), "");
    const png =
      publicParent.normalized_result.steps.at(-1).artifacts.screenshot;
    assert.equal(png.state, "captured");
    assert.equal(
      Buffer.from(png.value.data_base64, "base64")
        .subarray(0, 8)
        .toString("hex"),
      "89504e470d0a1a0a",
    );
    runs.push({
      verification: "source-and-later-JSON-spellings",
      verified_bodies: bodies.length,
      metadata_only_source_url: true,
      whole_json_secret_withheld: true,
      immediate_followup_protected: true,
      immediate_console_protected: true,
      rendered_secret_screenshots_withheld: true,
      nonsecret_screenshot_captured: true,
      whole_json_status: postResponse.status,
    });
  }
  await writeFile(join(output, "calls.json"), JSON.stringify(calls), {
    mode: 0o600,
  });
  await writeFile(
    join(output, "metrics.json"),
    JSON.stringify({ mode: values.mode, runs }, null, 2),
  );
  console.log(JSON.stringify({ mode: values.mode, runs }));
} finally {
  await withVerifierCleanup(
    () => commands.close(),
    [
      async () => {
        if (commands.cleanupResources.length === 0)
          await rm(profile, { recursive: true, force: true });
      },
    ],
  );
}
