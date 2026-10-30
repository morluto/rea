import { expect, it, onTestFinished, vi } from "vitest";
import { createHash } from "node:crypto";
import { selectScriptCapture } from "../../../src/browser/assets/ScriptCaptureAdapters.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import {
  applicationFixture,
  analyzeFixture,
} from "../../fixtures/javascriptRuntimeReconciliation.js";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createBrowserEvidence } from "../../../src/application/BrowserEvidence.js";
import { parseRuntimeCaptures } from "../../../src/domain/javascript/javascriptRuntimeReconciliationCaptureParsing.js";
import { projectRuntimeCaptures } from "../../../src/domain/javascript/javascriptRuntimeReconciliationRuntime.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { browserWorkerEvidenceScopeSchema } from "../../../src/domain/browserWorkerEvidenceScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";

const source = 'postMessage("worker 🧪");';

it.each(["length", "cdp_hash", "is_module", "language"] as const)(
  "compares worker metadata only when mutually known: %s",
  async (field) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const before = captured.value;
    before.workers = before.workers.filter(
      (worker) => worker.target_id === "own",
    );
    for (const coverage of [
      before.completeness,
      before.workers[0]!.observation!.completeness,
    ]) {
      coverage.policy_filtered_sections = [];
      coverage.attach_limited_sections = [];
      coverage.truncated_sections = [];
      coverage.unavailable_sections = [];
      coverage.dropped_events.scripts = 0;
    }
    const first =
      field === "length" ? 0 : field === "is_module" ? false : "first";
    const second =
      field === "length" ? 1 : field === "is_module" ? true : "second";
    Object.assign(before.workers[0]!.observation!.scripts[0]!, {
      [field]: first,
    });
    const after = structuredClone(before);
    const script = after.workers[0]!.observation!.scripts[0]!;
    const compare = (left = before, right = after) =>
      compareWebCaptures({
        before: { inspection: left, webmcp: null },
        after: { inspection: right, webmcp: null },
      });
    for (const complete of [true, false]) {
      if (!complete) after.completeness.unavailable_sections.push("scripts");
      Object.assign(script, { [field]: null });
      for (const [left, right] of [
        [before, after],
        [after, before],
      ] as const) {
        expect(compare(left, right).dimensions.scripts).toMatchObject({
          status: complete ? "unchanged" : "unknown",
          total_changes: 0,
        });
        expect(compare(left, right).overall_status).not.toBe("changed");
      }
      if (field === "length") {
        delete script.length;
        expect(compare().dimensions.scripts.total_changes).toBe(0);
        expect(compare(after, before).dimensions.scripts.total_changes).toBe(0);
      }
      Object.assign(script, { [field]: second });
      expect(compare().dimensions.scripts).toMatchObject({
        status: "changed",
        total_changes: 1,
      });
    }
  },
);

it.each([
  "target",
  "origin",
  "origin-url",
  "unsanitized-page",
  "page-source-selection",
])(
  "rejects inconsistent captured page Evidence in both consumers: %s",
  async (mismatch) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    for (const keepWorkers of [true, false]) {
      const inspection = structuredClone(captured.value);
      if (!keepWorkers || mismatch === "page-source-selection")
        inspection.workers = [];
      if (mismatch === "target") inspection.target.target_id = "different-page";
      if (mismatch === "origin") {
        inspection.target.origin = "https://foreign.example";
        inspection.target.url = "https://foreign.example/page";
      }
      if (mismatch === "origin-url")
        inspection.target.url = "https://foreign.example/page";
      if (mismatch === "unsanitized-page") {
        const url = new URL(inspection.target.url);
        url.username = "user";
        inspection.target.url = url.href;
      }
      const evidence = createBrowserEvidence(
        "inspect_web_page",
        {
          ...input,
          allowed_origins: [captured.value.target.origin],
          include_script_sources:
            mismatch === "page-source-selection"
              ? false
              : input.include_script_sources,
        },
        inspection,
        provider.identity(),
      );
      expect(() => parseEvidence(evidence)).not.toThrow();
      expect(() => parseRuntimeCaptures([evidence])).toThrow();
      expect(() => selectScriptCapture(evidence)).toThrow();
      expect(() => selectScriptCapture(inspection)).not.toThrow();
    }
  },
);

it.each(["WebAssembly", "JavaScript", undefined, "Other"])(
  "respects worker script language before reading or matching: %s",
  async (scriptLanguage) => {
    const { provider, input, browser } = await fixture({
      commandEvents: (command, origin) =>
        command.method === "Debugger.enable" &&
        command.sessionId === "worker-own"
          ? [
              {
                method: "Debugger.scriptParsed",
                sessionId: "worker-own",
                params: {
                  scriptId: "language",
                  url: origin + "/same.js",
                  scriptLanguage,
                  length: 0,
                },
              },
            ]
          : undefined,
      commandResult: (command) =>
        command.method === "Debugger.getScriptSource" &&
        command.sessionId === "worker-own"
          ? { scriptSource: "", bytecode: "AGFzbQ==" }
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const script = captured.value.workers.find((w) => w.target_id === "own")!
      .observation!.scripts[0]!;
    const javascript =
      scriptLanguage === undefined || scriptLanguage === "JavaScript";
    expect(script.language).toBe(scriptLanguage ?? null);
    expect(script.source.included).toBe(javascript);
    expect(
      browser.commands.some(
        (c) =>
          c.method === "Debugger.getScriptSource" &&
          c.sessionId === "worker-own",
      ),
    ).toBe(javascript);
    // Historical captures with included bytes still cannot reinterpret Wasm as JS.
    script.source = {
      included: true,
      artifact: createWebTextArtifact("", "text/javascript"),
    };
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      captured.value,
      provider.identity(),
    );
    const projection = projectRuntimeCaptures(parseRuntimeCaptures([evidence]));
    expect(
      projection.entities.filter((entity) => entity.parentWorkerKey === "own"),
    ).toHaveLength(javascript ? 1 : 0);
    expect(
      selectScriptCapture(evidence).scripts.find(
        (s) =>
          s.source.kind === "worker-script" && s.source.target_id === "own",
      )?.content.state,
    ).toBe(javascript ? "captured" : "unavailable");
  },
);

it("retains worker length through capture, reconciliation and passive diff", async () => {
  const { provider, input } = await fixture();
  const selected = { ...input, include_script_sources: false };
  const result = await provider.inspectPage(selected);
  if (!result.ok) throw result.error;
  const before = result.value;
  const script = before.workers.find((w) => w.target_id === "own")!.observation!
    .scripts[0]!;
  expect(script.length).toBe(source.length);
  script.cdp_hash = null;
  const after = structuredClone(before);
  after.workers.find(
    (w) => w.target_id === "own",
  )!.observation!.scripts[0]!.length = source.length + 1;
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    selected,
    before,
    provider.identity(),
  );
  expect(
    projectRuntimeCaptures(parseRuntimeCaptures([evidence])).entities.find(
      (e) => e.parentWorkerKey === "own",
    )?.node.observations[0]?.properties.length,
  ).toBe(source.length);
  const diff = compareWebCaptures({
    before: { inspection: before, webmcp: null },
    after: { inspection: after, webmcp: null },
  });
  expect(diff.dimensions.scripts.total_changes).toBe(1);
  delete script.length;
  expect(() =>
    parseRuntimeCaptures([
      createBrowserEvidence(
        "inspect_web_page",
        selected,
        before,
        provider.identity(),
      ),
    ]),
  ).not.toThrow();
});

it("rejects a repeated worker script identity with a changed length", async () => {
  const { provider, input } = await fixture({
    commandEvents: (command, origin) =>
      command.method === "Debugger.enable" && command.sessionId === "worker-own"
        ? [1, 2].map((length) => ({
            method: "Debugger.scriptParsed",
            sessionId: "worker-own",
            params: { scriptId: "same", url: origin + "/same.js", length },
          }))
        : undefined,
  });
  expect(await provider.inspectPage(input)).toMatchObject({
    ok: false,
    error: { reason: "target_changed" },
  });
});

it.each([-32601, -32000, -32001])(
  "bounds unsupported worker source requests while preserving per-script failures: %s",
  async (code) => {
    const { provider, input, browser } = await fixture({
      commandEvents: (command, origin) =>
        command.method === "Debugger.enable" &&
        command.sessionId === "worker-own"
          ? Array.from({ length: 16 }, (_, index) => ({
              method: "Debugger.scriptParsed",
              sessionId: "worker-own",
              params: { scriptId: String(index), url: origin + "/same.js" },
            }))
          : undefined,
      commandError: (command) =>
        command.method === "Debugger.getScriptSource" &&
        command.sessionId === "worker-own" &&
        (code !== -32000 || command.params.scriptId === "0")
          ? {
              code,
              message:
                code === -32001
                  ? "Session with given id not found."
                  : "Source unavailable",
            }
          : undefined,
    });
    const captured = await provider.inspectPage({
      ...input,
      worker_target_ids: ["shared"],
    });
    if (!captured.ok) throw captured.error;
    const observation = captured.value.workers.find(
      (w) => w.target_id === "own",
    )!.observation!;
    expect(
      browser.commands.filter(
        (c) =>
          c.method === "Debugger.getScriptSource" &&
          c.sessionId === "worker-own",
      ),
    ).toHaveLength(code === -32000 ? 16 : 1);
    expect(observation.scripts.filter((s) => s.source.included)).toHaveLength(
      code === -32000 ? 15 : 0,
    );
    expect(
      observation.limitations.filter((s) =>
        s.includes("Debugger.getScriptSource was unavailable"),
      ),
    ).toHaveLength(code === -32601 ? 1 : 0);
    expect(
      captured.value.workers.find((w) => w.target_id === "shared")!.observation!
        .scripts[0]!.source.included,
    ).toBe(true);
  },
);

it.each(["revoked", "selected", "controlled"])(
  "charges worker event bytes only within collection scope: %s",
  async (scope) => {
    const { provider, input } = await fixture({
      eventsBeforeReply: [
        "ServiceWorker.enable",
        "Target.setAutoAttach",
        "Network.enable",
      ],
      commandEvents(command, origin) {
        const version = (clients: string[]): CdpEvent => ({
          method: "ServiceWorker.workerVersionUpdated",
          sessionId: "session-1",
          params: {
            versions: [{ targetId: "service", controlledClients: clients }],
          },
        });
        if (command.method === "ServiceWorker.enable")
          return [version(["allowed-page"])];
        if (
          command.method === "Target.setAutoAttach" &&
          command.params.autoAttach === true &&
          command.sessionId === "session-1"
        )
          return [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "worker-service",
                targetInfo: {
                  targetId: "service",
                  type: "service_worker",
                  url: origin + "/service.js",
                  attached: true,
                },
              },
            },
          ];
        if (
          command.method === "Network.enable" &&
          command.sessionId === "worker-service"
        )
          return [
            version(scope === "controlled" ? ["allowed-page"] : ["other-page"]),
            ...Array.from({ length: 10 }, () => ({
              method: "Runtime.consoleAPICalled",
              sessionId: "worker-service",
              params: {
                type: "log",
                args: [{ type: "string", value: "x".repeat(900_000) }],
              },
            })),
          ];
        return undefined;
      },
    });
    const captured = await provider.inspectPage({
      ...input,
      worker_target_ids: scope === "selected" ? ["service"] : [],
    });
    if (scope === "revoked") {
      if (!captured.ok) throw captured.error;
      expect(captured.value.target.target_id).toBe("allowed-page");
      expect(
        captured.value.workers
          .find((w) => w.target_id === "service")!
          .observation!.lifecycle.at(-1),
      ).toMatchObject({ controls_page: false });
    } else
      expect(captured).toMatchObject({
        ok: false,
        error: { reason: "payload_limit" },
      });
  },
);

it.each(["missing", "observation"] as const)(
  "rejects an explicitly selected worker without retained %s",
  async (kind) => {
    const { provider, input } = await fixture();
    const selected = { ...input, worker_target_ids: ["shared"] };
    const captured = await provider.inspectPage(selected);
    if (!captured.ok) throw captured.error;
    if (kind === "missing")
      captured.value.workers = captured.value.workers.filter(
        (w) => w.target_id !== "shared",
      );
    else
      delete captured.value.workers.find((w) => w.target_id === "shared")!
        .observation;
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      selected,
      captured.value,
      provider.identity(),
    );
    expect(() => parseRuntimeCaptures([evidence])).toThrow(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/selection/u),
          }),
        ]),
      }),
    );
    expect(() => selectScriptCapture(evidence)).toThrow(/selection/u);
  },
);

it.each(
  [null, [42], "malformed", [""], ["allowed-page", ""]].map(
    (controlledClients) => ({ controlledClients }),
  ),
)(
  "marks malformed controlled clients incomplete: %j",
  async ({ controlledClients }) => {
    const { provider, input } = await fixture({
      commandEvents: (command) =>
        command.method === "ServiceWorker.enable"
          ? [
              {
                method: "ServiceWorker.workerVersionUpdated",
                sessionId: "session-1",
                params: {
                  versions: [
                    {
                      targetId: "service",
                      controlledClients,
                      status: "activated",
                    },
                  ],
                },
              },
            ]
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    expect(captured.value.completeness.unavailable_sections).toContain(
      "workers",
    );
    expect(JSON.stringify(captured.value.completeness)).toContain(
      "invalid_protocol_value",
    );
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      captured.value,
      provider.identity(),
    );
    expect(
      parseRuntimeCaptures([evidence])[0]?.scriptsCompleteWithinScope,
    ).toBe(false);
  },
);

it.each([undefined, null, 42, []].map((targetInfo) => ({ targetInfo })))(
  "records malformed auto-attachment target info: %j",
  async ({ targetInfo }) => {
    const { provider, input, browser } = await fixture({
      commandEvents: (command) =>
        command.method === "Target.setAutoAttach" &&
        command.params.autoAttach === true &&
        command.sessionId === "session-1"
          ? [
              {
                method: "Target.attachedToTarget",
                sessionId: "session-1",
                params: { sessionId: "malformed-worker", targetInfo },
              },
            ]
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    expect(captured.value.completeness.unavailable_sections).toContain(
      "workers",
    );
    expect(JSON.stringify(captured.value.completeness)).toContain(
      "invalid_protocol_value",
    );
    expect(
      parseRuntimeCaptures([
        createBrowserEvidence(
          "inspect_web_page",
          input,
          captured.value,
          provider.identity(),
        ),
      ])[0]?.scriptsCompleteWithinScope,
    ).toBe(false);
    expect(
      browser.commands.some((c) => c.sessionId === "malformed-worker"),
    ).toBe(false);
  },
);

it.each(["changed", "same", "before-only", "after-only", "neither"] as const)(
  "compares mutually retained worker bytes: %s",
  async (kind) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const before = captured.value,
      after = structuredClone(before);
    const left = before.workers.find((w) => w.target_id === "own")!.observation!
      .scripts[0]!;
    const right = after.workers.find((w) => w.target_id === "own")!.observation!
      .scripts[0]!;
    left.cdp_hash = null;
    right.cdp_hash = null;
    if (kind === "changed")
      right.source = {
        included: true,
        artifact: createWebTextArtifact(
          'postMessage("changed");',
          "text/javascript",
        ),
      };
    if (kind === "before-only" || kind === "neither")
      right.source = { included: false, reason: "not approved" };
    if (kind === "after-only" || kind === "neither")
      left.source = { included: false, reason: "source unavailable" };
    const result = compareWebCaptures({
      before: { inspection: before, webmcp: null },
      after: { inspection: after, webmcp: null },
    }).dimensions.scripts;
    expect(result.total_changes).toBe(kind === "changed" ? 1 : 0);
    if (kind === "changed") expect(result.status).toBe("changed");
  },
);

it("retains selected worker metadata with explicit coverage limits on direct page transports", async () => {
  const { provider, input, browser } = await fixture({
    pageScopedVersionWebSocket: true,
    omitTargetWebSocket: true,
  });
  const result = await provider.inspectPage({
    ...input,
    worker_target_ids: ["shared"],
  });
  if (!result.ok) throw result.error;
  const worker = result.value.workers.find(
    ({ target_id }) => target_id === "shared",
  )!.observation!;
  expect(worker.selected_explicitly).toBe(true);
  expect(worker.scripts).toEqual([]);
  expect(worker.completeness.unavailable_sections).toEqual(
    expect.arrayContaining(["scripts", "network_requests"]),
  );
  expect(worker.limitations.join(" ")).toContain("browser-level CDP WebSocket");
  expect(
    browser.commands.some(
      ({ method, sessionId }) =>
        method === "Target.attachToTarget" ||
        method === "Target.detachFromTarget" ||
        method === "Target.setAutoAttach" ||
        sessionId !== undefined,
    ),
  ).toBe(false);
});

it.each(["explicit", "auto"] as const)(
  "rejects empty worker session IDs from %s attachments",
  async (kind) => {
    const { provider, input, browser } = await fixture({
      commandResult: (command) =>
        kind === "explicit" &&
        command.method === "Target.attachToTarget" &&
        command.params.targetId === "shared"
          ? { sessionId: "" }
          : undefined,
      commandEvents: (command, origin) =>
        kind === "auto" &&
        command.method === "Target.setAutoAttach" &&
        command.params.autoAttach === true
          ? [
              {
                method: "Target.attachedToTarget",
                sessionId: "session-1",
                params: {
                  sessionId: "",
                  targetInfo: {
                    targetId: "own",
                    type: "worker",
                    url: origin + "/same.js",
                    attached: true,
                  },
                },
              },
            ]
          : undefined,
    });
    const result = await provider.inspectPage({
      ...input,
      worker_target_ids: kind === "explicit" ? ["shared"] : [],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(browser.commands.some(({ sessionId }) => sessionId === "")).toBe(
      false,
    );
    await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  },
);

it.each([
  ["https://foreign.example/a.js", "disallowed_origin"],
  ["file:///worker.js", "unsupported_url"],
  ["", "unattributed_origin"],
  [undefined, "invalid_protocol_value"],
] as const)(
  "retains the exclusion reason for worker URL %s",
  async (url, reason) => {
    const { provider, input } = await fixture({
      commandResult: (command) =>
        command.method === "Target.getTargets"
          ? {
              targetInfos: [
                { targetId: "excluded", type: "worker", attached: false, url },
              ],
            }
          : undefined,
    });
    const result = await provider.inspectPage(input);
    if (!result.ok) throw result.error;
    expect(result.value.completeness.excluded).toContainEqual({
      section: "workers",
      reason,
      count: 1,
    });
  },
);

it.each(
  ["worker", "iframe"].flatMap((type) =>
    ["", "file:///worker.js", "https://foreign.example/a.js"].map((url) => ({
      type,
      url,
    })),
  ),
)("preserves coverage for a transient target: %j", async ({ type, url }) => {
  const { provider, input, browser } = await fixture({
    commandResult: (command) =>
      command.method === "Target.getTargets" ? { targetInfos: [] } : undefined,
    commandEvents: (command) =>
      command.method === "Target.setAutoAttach" &&
      command.params.autoAttach === true &&
      command.sessionId === "session-1"
        ? [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "transient-session",
                targetInfo: {
                  targetId: "transient",
                  type,
                  url,
                  attached: true,
                },
              },
            },
          ]
        : [],
  });
  const result = await provider.inspectPage(input);
  if (!result.ok) throw result.error;
  const excludedByOrigin = url.startsWith("https:");
  expect(result.value.workers).toEqual([]);
  expect(
    result.value.completeness.unavailable_sections.includes("workers"),
  ).toBe(!excludedByOrigin);
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    result.value,
    provider.identity(),
  );
  expect(parseRuntimeCaptures([evidence])[0]?.scriptsCompleteWithinScope).toBe(
    excludedByOrigin,
  );
  expect(
    browser.commands.some((c) => c.sessionId === "transient-session"),
  ).toBe(false);
});

it("preserves worker coverage and warnings through CLI export even without worker scripts", async () => {
  const { provider, input } = await fixture({
    commandError: (command) =>
      command.method === "Debugger.enable" && command.sessionId === "worker-own"
        ? { code: -32601, message: "Debugger is unavailable" }
        : undefined,
  });
  const result = await provider.inspectPage(input);
  if (!result.ok) throw result.error;
  const own = result.value.workers.find(
    ({ target_id }) => target_id === "own",
  )!;
  const observation = own.observation!;
  expect(observation.scripts).toEqual([]);
  expect(observation.network_requests).toEqual([]);
  expect(observation.completeness.excluded).toContainEqual({
    section: "json_body_shapes",
    reason: "not_approved",
    count: null,
  });
  expect(observation.completeness.unavailable_sections).toContain("scripts");
  result.value.workers.push({
    ...own,
    target_id: "legacy",
    observation: undefined,
  });
  const root = await createTestTempDirectory("rea-worker-export-coverage-");
  const capture = join(root, "capture.json");
  await writeFile(capture, JSON.stringify(result.value));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "scripts/rea.mjs",
      "export-web-scripts",
      capture,
      join(root, "export"),
      "--json",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const exported = parseEvidence(JSON.parse(stdout)).normalized_result;
  const expected = [
    {
      target_id: "own",
      completeness: observation.completeness,
      limitations: observation.limitations,
    },
    { target_id: "legacy", completeness: null, limitations: [] },
  ];
  expect(exported).toMatchObject({
    worker_coverage: expect.arrayContaining(expected),
  });
  const manifest = JSON.parse(
    await readFile(join(root, "export", "manifest.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    worker_coverage: expect.arrayContaining(expected),
  });
}, 30000);

it.each([false, true])(
  "retains worker JSON-shape selection with no requests: %s",
  async (selected) => {
    const { provider, input } = await fixture();
    const result = await provider.inspectPage({
      ...input,
      include_json_body_shapes: selected,
    });
    if (!result.ok) throw result.error;
    const own = result.value.workers.find(
      ({ target_id }) => target_id === "own",
    )!.observation!;
    expect(own.network_requests).toEqual([]);
    expect(
      own.completeness.excluded.some(
        ({ section, reason }) =>
          section === "json_body_shapes" && reason === "not_approved",
      ),
    ).toBe(!selected);
  },
);

it("does not enter worker observation for page-only bundle analysis", async () => {
  const { provider, input, browser } = await fixture({
    commandError: (command) =>
      command.method === "ServiceWorker.enable" ||
      command.method === "Target.setAutoAttach"
        ? { code: -32000, message: "Workers are unavailable" }
        : undefined,
  });
  const result = await provider.analyzeBundle(
    analyzeWebBundleInputSchema.parse({
      ...input,
      cdp_endpoint: browser.endpoint,
    }),
  );
  expect(result.ok).toBe(true);
  expect(
    browser.commands.some(
      (command) =>
        command.method.startsWith("ServiceWorker.") ||
        command.method === "Target.setAutoAttach" ||
        command.method === "Target.getTargets",
    ),
  ).toBe(false);
});

it.each(["", "https://foreign.example/changed.js"])(
  "rejects a previously retained script whose replacement leaves scope: %s",
  async (url) => {
    const { provider, input } = await fixture({
      eventsBeforeReply: ["Debugger.getScriptSource"],
      commandEvents: (command) =>
        command.method === "Debugger.getScriptSource" &&
        command.sessionId === "worker-own"
          ? [
              {
                method: "Debugger.scriptParsed",
                sessionId: "worker-own",
                params: { scriptId: "1", url, hash: "replacement" },
              },
            ]
          : undefined,
    });
    expect(await provider.inspectPage(input)).toMatchObject({
      ok: false,
      error: { reason: "target_changed" },
    });
  },
);

it("settles unfetched worker JSON responses as partial while retaining the request shape", async () => {
  const { provider, input } = await fixture({
    commandEvents: (command, origin) =>
      command.method === "Network.enable" && command.sessionId === "worker-own"
        ? [
            {
              method: "Network.requestWillBeSent",
              sessionId: "worker-own",
              params: {
                requestId: "post",
                type: "Fetch",
                request: {
                  url: origin + "/post",
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  postData: '{"selected":true}',
                },
                initiator: { type: "script" },
              },
            },
            {
              method: "Network.responseReceived",
              sessionId: "worker-own",
              params: {
                requestId: "post",
                response: {
                  url: origin + "/post",
                  status: 200,
                  mimeType: "application/json",
                  headers: {},
                },
              },
            },
            {
              method: "Network.loadingFinished",
              sessionId: "worker-own",
              params: { requestId: "post", encodedDataLength: 17 },
            },
          ]
        : undefined,
  });
  const result = await provider.inspectPage({
    ...input,
    include_json_body_shapes: true,
  });
  if (!result.ok) throw result.error;
  const observed = result.value.workers.find(
    (worker) => worker.target_id === "own",
  )!.observation!;
  expect(observed.network_requests[0]?.body_shapes).toMatchObject({
    status: "partial",
    response: null,
  });
  expect(observed.network_requests[0]?.body_shapes.request).not.toBeNull();
  expect(observed.completeness.unavailable_sections).toContain(
    "json_body_shapes",
  );
});

it("rejects a script identity change while its source read is pending", async () => {
  const { provider, input, browser } = await fixture({
    eventsBeforeReply: ["Debugger.getScriptSource"],
    commandEvents: (c, origin) =>
      c.method === "Debugger.getScriptSource" && c.sessionId === "worker-own"
        ? [
            {
              method: "Debugger.scriptParsed",
              sessionId: "worker-own",
              params: {
                scriptId: "1",
                url: origin + "/replacement.js",
                hash: "replacement",
                executionContextId: 1,
              },
            },
          ]
        : undefined,
  });
  expect(
    await provider.inspectPage({ ...input, observation_ms: 30_000 }),
  ).toMatchObject({ ok: false, error: { reason: "target_changed" } });
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});
async function fixture(extra: FakeOptions = {}) {
  const browser = await startFakeCdpBrowser({
    ...extra,
    commandResult(command, origin, reads) {
      const custom = extra.commandResult?.(command, origin, reads);
      if (custom !== undefined) return custom;
      if (
        command.method === "ServiceWorker.enable" ||
        command.method === "ServiceWorker.disable" ||
        command.method === "Target.setAutoAttach"
      )
        return {};
      if (command.method === "Target.getTargets")
        return {
          targetInfos: [
            {
              targetId: "own",
              type: "worker",
              url: origin + "/same.js",
              attached: false,
            },
            {
              targetId: "other",
              type: "worker",
              url: origin + "/same.js",
              attached: false,
            },
            {
              targetId: "shared",
              type: "shared_worker",
              url: origin + "/shared.js",
              attached: false,
            },
            {
              targetId: "foreign",
              type: "worker",
              url: "https://foreign.example/a.js",
              attached: false,
            },
          ],
        };
      if (
        command.method === "Target.attachToTarget" &&
        command.params.targetId === "shared"
      )
        return { sessionId: "worker-shared" };
      if (
        command.method === "Debugger.getScriptSource" &&
        command.sessionId?.startsWith("worker-")
      )
        return { scriptSource: source };
      return undefined;
    },
    commandEvents(command, origin) {
      const custom = extra.commandEvents?.(command, origin);
      if (custom !== undefined) return custom;
      if (
        command.method === "Target.setAutoAttach" &&
        command.params.autoAttach === true
      )
        return [
          {
            method: "Target.attachedToTarget",
            sessionId: "session-1",
            params: {
              sessionId: "worker-own",
              targetInfo: {
                targetId: "own",
                type: "worker",
                url: origin + "/same.js",
                attached: true,
              },
              waitingForDebugger: false,
            },
          },
        ];
      if (command.sessionId?.startsWith("worker-")) {
        if (command.method === "Runtime.enable")
          return [
            {
              method: "Runtime.executionContextCreated",
              sessionId: command.sessionId,
              params: {
                context: { id: 1, uniqueId: "worker-context", origin },
              },
            },
          ];
        if (command.method === "Debugger.enable")
          return [
            {
              method: "Debugger.scriptParsed",
              sessionId: command.sessionId,
              params: {
                scriptId: "1",
                url: origin + "/same.js",
                executionContextId: 1,
                hash: "producer",
                length: source.length,
              },
            },
          ];
        return [];
      }
      return undefined;
    },
  });
  onTestFinished(() => browser.close());
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    target_id: "allowed-page",
    observation_ms: 0,
    include_script_sources: true,
  });
  return { browser, input, provider: new CdpBrowserProvider() };
}
it("uses session ancestry rather than URL equality and retains unknown ownership", async () => {
  const { provider, input } = await fixture();
  const result = await provider.inspectPage(input);
  if (!result.ok) throw result.error;
  expect(result.value.workers.map((w) => w.target_id)).toEqual([
    "other",
    "own",
    "shared",
  ]);
  expect(
    result.value.workers.find((w) => w.target_id === "other")?.observation,
  ).toMatchObject({ ownership: "unknown", scripts: [] });
  expect(
    result.value.workers.find((w) => w.target_id === "own")?.observation,
  ).toMatchObject({
    ownership: "page_related",
    page_target_id: "allowed-page",
    scripts: [
      {
        script_id: "1",
        execution_context_id: 1,
        source: { included: true, artifact: { text: source } },
      },
    ],
  });
});
it("explicitly selected shared workers remain ownership-unknown", async () => {
  const { provider, input } = await fixture();
  const result = await provider.inspectPage({
    ...input,
    worker_target_ids: ["shared"],
  });
  if (!result.ok) throw result.error;
  expect(
    result.value.workers.find((w) => w.target_id === "shared")?.observation,
  ).toMatchObject({
    ownership: "unknown",
    page_target_id: null,
    selected_explicitly: true,
    scripts: [{ source: { included: true } }],
  });
});
it.each(["foreign", "missing"])(
  "rejects an explicit target outside authorized inventory: %s",
  async (id) => {
    const { provider, input, browser } = await fixture();
    expect(
      await provider.inspectPage({ ...input, worker_target_ids: [id] }),
    ).toMatchObject({ ok: false, error: { reason: "target_not_allowed" } });
    expect(
      browser.commands.some(
        (c) => c.method === "Target.attachToTarget" && c.params.targetId === id,
      ),
    ).toBe(false);
  },
);
it.each([{}, { scriptSource: null }])(
  "rejects malformed worker source: %j",
  async (reply) => {
    const { provider, input } = await fixture({
      commandResult: (c) =>
        c.method === "Debugger.getScriptSource" && c.sessionId === "worker-own"
          ? reply
          : undefined,
    });
    expect(await provider.inspectPage(input)).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  },
);
it("cancellation releases an in-flight source read and attached sessions", async () => {
  const { provider, input, browser } = await fixture({
    hangOnMethod: "Debugger.getScriptSource",
  });
  const controller = new AbortController();
  const pending = provider.inspectPage(input, { signal: controller.signal });
  await vi.waitFor(() =>
    expect(
      browser.commands.some(
        (c) =>
          c.method === "Debugger.getScriptSource" &&
          c.sessionId === "worker-own",
      ),
    ).toBe(true),
  );
  controller.abort();
  expect((await pending).ok).toBe(false);
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  expect(
    browser.commands.some(
      (c) =>
        c.method === "Target.detachFromTarget" &&
        c.params.sessionId === "worker-own",
    ),
  ).toBe(true);
  expect(
    browser.commands.some(
      (c) =>
        c.method === "Target.closeTarget" ||
        c.method === "Runtime.evaluate" ||
        c.method === "Runtime.runIfWaitingForDebugger",
    ),
  ).toBe(false);
});
it("does not request worker sources when source capture is disabled", async () => {
  const { provider, input, browser } = await fixture();
  const result = await provider.inspectPage({
    ...input,
    include_script_sources: false,
  });
  if (!result.ok) throw result.error;
  expect(
    result.value.workers.find((w) => w.target_id === "own")?.observation
      ?.scripts[0]?.source,
  ).toMatchObject({ included: false });
  expect(
    result.value.workers.find((w) => w.target_id === "own")?.observation
      ?.completeness.excluded,
  ).toContainEqual({
    section: "script_sources",
    reason: "not_approved",
    count: 1,
  });
  expect(
    browser.commands.some(
      (c) =>
        c.method === "Debugger.getScriptSource" && c.sessionId === "worker-own",
    ),
  ).toBe(false);
});

it.each([undefined, null, "", 42])(
  "distinguishes inactive service versions from malformed target IDs: %j",
  async (targetId) => {
    const { provider, input } = await fixture({
      commandEvents: (command) =>
        command.method === "ServiceWorker.enable"
          ? [
              {
                method: "ServiceWorker.workerVersionUpdated",
                sessionId: "session-1",
                params: {
                  versions: [
                    { targetId, runningStatus: "stopped", status: "installed" },
                  ],
                },
              },
            ]
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    expect(
      captured.value.completeness.excluded.some(
        (entry) =>
          entry.section === "workers" &&
          entry.reason === "invalid_protocol_value",
      ),
    ).toBe(targetId !== undefined);
  },
);

it.each([false, true, null])(
  "retains service worker client evidence before attachment (controls page: %s)",
  async (controls) => {
    const { provider, input, browser } = await fixture({
      eventsBeforeReply: ["ServiceWorker.enable", "Target.setAutoAttach"],
      commandEvents(command, origin) {
        if (command.method === "ServiceWorker.enable")
          return [
            {
              method: "ServiceWorker.workerVersionUpdated",
              sessionId: "session-1",
              params: {
                versions: [
                  {
                    targetId: "service",
                    ...(controls === null
                      ? {}
                      : {
                          controlledClients: controls
                            ? ["allowed-page"]
                            : ["another-page"],
                        }),
                    runningStatus: "running",
                    status: "activated",
                  },
                ],
              },
            },
          ];
        if (
          command.method === "Target.setAutoAttach" &&
          command.params.autoAttach === true
        )
          return [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "worker-service",
                targetInfo: {
                  targetId: "service",
                  type: "service_worker",
                  url: origin + "/service.js",
                  attached: true,
                },
              },
            },
          ];
        if (
          command.method === "Network.enable" &&
          command.sessionId === "worker-service"
        )
          return [
            {
              method: "ServiceWorker.workerVersionUpdated",
              sessionId: "session-1",
              params: {
                versions: [
                  {
                    targetId: "service",
                    controlledClients: [],
                    runningStatus: "running",
                    status: "activated",
                  },
                ],
              },
            },
            {
              method: "Debugger.scriptParsed",
              sessionId: "worker-service",
              params: {
                scriptId: "after-revocation",
                url: origin + "/late.js",
                executionContextId: 1,
              },
            },
          ];
        return undefined;
      },
    });
    const result = await provider.inspectPage(input);
    if (!result.ok) throw result.error;
    const observed = result.value.workers.find(
      (w) => w.target_id === "service",
    )!.observation!;
    expect(observed.ownership).toBe(
      controls ? "service_worker_client" : "unknown",
    );
    expect(observed.lifecycle[0]).toMatchObject({
      event: "version",
      controls_page: controls,
      version_status: "activated",
    });
    expect(observed.scripts).toHaveLength(controls ? 1 : 0);
    expect(
      browser.commands.some((c) => c.params.scriptId === "after-revocation"),
    ).toBe(false);
    if (controls)
      expect(observed.lifecycle.at(-1)).toMatchObject({ controls_page: false });
  },
);

it.each([undefined, "malformed", [42], []])(
  "retains ordered pre-admission transitions and distinguishes unknown clients from revocation: %j",
  async (clients) => {
    const { provider, input } = await fixture({
      eventsBeforeReply: ["ServiceWorker.enable", "Target.setAutoAttach"],
      commandEvents(command, origin) {
        if (command.method === "ServiceWorker.enable")
          return [["allowed-page"], clients].map((controlledClients) => ({
            method: "ServiceWorker.workerVersionUpdated",
            sessionId: "session-1",
            params: {
              versions: [
                { targetId: "service", controlledClients, status: "activated" },
              ],
            },
          }));
        if (
          command.method === "Target.setAutoAttach" &&
          command.params.autoAttach === true
        )
          return [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "worker-service",
                targetInfo: {
                  targetId: "service",
                  type: "service_worker",
                  url: origin + "/service.js",
                  attached: true,
                },
              },
            },
          ];
        if (
          command.method === "Network.enable" &&
          command.sessionId === "worker-service"
        )
          return [
            {
              method: "ServiceWorker.workerVersionUpdated",
              sessionId: "session-1",
              params: { versions: [{ targetId: "service" }] },
            },
            {
              method: "Debugger.scriptParsed",
              sessionId: "worker-service",
              params: {
                scriptId: "after-unknown",
                url: origin + "/late.js",
                executionContextId: 1,
              },
            },
          ];
        return undefined;
      },
    });
    const result = await provider.inspectPage(input);
    if (!result.ok) throw result.error;
    const observed = result.value.workers.find(
      (w) => w.target_id === "service",
    )!.observation!;
    const revoked = Array.isArray(clients) && clients.length === 0;
    expect(observed.ownership).toBe("service_worker_client");
    expect(
      observed.lifecycle.slice(0, 2).map((event) => event.controls_page),
    ).toEqual([true, revoked ? false : null]);
    expect(observed.scripts.map((script) => script.script_id)).toEqual(
      revoked ? [] : ["1", "after-unknown"],
    );
  },
);

it.each([
  [-32_000, "Source unavailable"],
  [-32_601, "Source unavailable"],
  [-32_001, "Session with given id not found."],
] as const)(
  "retains worker identity when source retrieval becomes unavailable (%s)",
  async (code, message) => {
    const { provider, input } = await fixture({
      commandError: (c) =>
        c.method === "Debugger.getScriptSource" && c.sessionId === "worker-own"
          ? { code, message }
          : undefined,
    });
    const result = await provider.inspectPage(input);
    if (!result.ok) throw result.error;
    const observed = result.value.workers.find(
      (w) => w.target_id === "own",
    )!.observation!;
    expect(observed.scripts[0]?.source.included).toBe(false);
    expect(observed.completeness.unavailable_sections).toContain(
      "script_sources",
    );
  },
);

it.each([
  "Target.setAutoAttach",
  "Runtime.enable",
  "Debugger.enable",
  "Network.enable",
])("retains page evidence when a worker exits during %s", async (method) => {
  const { provider, input, browser } = await fixture({
    commandError: (command) =>
      command.method === method && command.sessionId === "worker-own"
        ? { code: -32_001, message: "Session with given id not found." }
        : undefined,
  });
  const result = await provider.inspectPage(input);
  if (!result.ok) throw result.error;
  expect(result.value.target.target_id).toBe(input.target_id);
  expect(result.value.scripts.items.length).toBeGreaterThan(0);
  const observed = result.value.workers.find(
    (worker) => worker.target_id === "own",
  )!.observation!;
  expect(observed.completeness.unavailable_sections).toContain("workers");
  expect(observed.limitations.join(" ")).toContain(method);
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it.each([-32_001, -32_602])(
  "propagates other worker source command rejections (%s)",
  async (code) => {
    const { provider, input, browser } = await fixture({
      commandError: (command) =>
        command.method === "Debugger.getScriptSource" &&
        command.sessionId === "worker-own"
          ? { code, message: "Unexpected command failure" }
          : undefined,
    });
    expect(await provider.inspectPage(input)).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  },
);

it("rejects one session ID assigned to two workers", async () => {
  const { provider, input } = await fixture({
    commandResult: (command) =>
      command.method === "Target.attachToTarget" &&
      command.params.targetId === "shared"
        ? { sessionId: "worker-own" }
        : undefined,
  });
  const result = await provider.inspectPage({
    ...input,
    worker_target_ids: ["shared"],
  });
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "protocol_error" },
  });
});

it("reconciliation retains unknown workers without asserting page containment", async () => {
  const { provider, input } = await fixture();
  const result = await provider.inspectPage(input);
  if (!result.ok) throw result.error;
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    result.value,
    provider.identity(),
  );
  const projected = projectRuntimeCaptures(parseRuntimeCaptures([evidence]));
  for (const worker of projected.entities.filter(
    ({ kind }) => kind === "worker",
  )) {
    expect(
      projected.edges.some(
        ({ target_node_id }) => target_node_id === worker.node.node_id,
      ),
    ).toBe(worker.runtimeKey === "own");
    expect(worker.node.observations[0]?.properties).toMatchObject({
      ownership: worker.runtimeKey === "own" ? "page_related" : "unknown",
    });
  }
});

it("reconciles retained worker sources against static artifacts", async () => {
  const { provider, input } = await fixture();
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    captured.value,
    provider.identity(),
  );
  const projection = projectRuntimeCaptures(parseRuntimeCaptures([evidence]));
  const workerScript = projection.entities.find(
    (entity) => entity.parentWorkerKey === "own",
  );
  expect(workerScript?.sourceSha256).toBe(
    createHash("sha256").update(source).digest("hex"),
  );
  const root = await applicationFixture();
  await writeFile(join(root, "worker.js"), source);
  const reconciled = reconcileJavaScriptRuntimeEvidence({
    static_layers: [
      { role: "application", analysis: await analyzeFixture(root) },
    ],
    runtime_observations: [evidence],
  });
  if (!reconciled.ok) throw reconciled.error;
  const result = javascriptRuntimeReconciliationResultSchema.parse(
    reconciled.value.normalized_result,
  );
  expect(result.reconciliations).toContainEqual(
    expect.objectContaining({
      entity_kind: "script",
      runtime_node_id: workerScript?.node.node_id,
      status: "matched",
    }),
  );
  expect(result.graph.edges).toContainEqual(
    expect.objectContaining({
      target_node_id: workerScript?.node.node_id,
      relation: "loads",
      evidence: expect.objectContaining({
        location: expect.objectContaining({
          value: expect.objectContaining({ target_key: "own" }),
        }),
      }),
    }),
  );
});

it("preserves page-script export from legacy unidentified workers", async () => {
  const { provider, input } = await fixture();
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  const original = captured.value.workers[0];
  if (original === undefined) throw new Error("Expected an inventoried worker");
  const { observation: _observation, ...metadata } = original;
  const legacy = {
    ...captured.value,
    workers: [{ ...metadata, target_id: "" }],
  };
  const selected = selectScriptCapture(legacy);
  expect(selected.workerCoverage).toEqual([]);
  expect(selected.scripts).toHaveLength(legacy.scripts.items.length);
  expect(selected.limitations.join(" ")).toContain(
    "Worker identity was unavailable for 1 observations",
  );
});

it.each([undefined, null, 42])(
  "rejects missing or non-string auto-attachment sessions: %j",
  async (sessionId) => {
    const { provider, input } = await fixture({
      commandEvents: (command, origin) =>
        command.method === "Target.setAutoAttach" &&
        command.sessionId === "session-1" &&
        command.params.autoAttach === true
          ? [
              {
                method: "Target.attachedToTarget",
                sessionId: "session-1",
                params: {
                  sessionId,
                  targetInfo: {
                    targetId: "own",
                    type: "worker",
                    url: origin + "/same.js",
                    attached: true,
                  },
                },
              },
            ]
          : undefined,
    });
    const result = await provider.inspectPage(input);
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  },
);

it("records and excludes empty worker script identifiers at ingestion", async () => {
  const { provider, input } = await fixture({
    commandEvents: (command, origin) =>
      command.method === "Debugger.enable" && command.sessionId === "worker-own"
        ? [
            {
              method: "Debugger.scriptParsed",
              sessionId: "worker-own",
              params: {
                scriptId: "",
                url: origin + "/same.js",
                executionContextId: 1,
              },
            },
          ]
        : undefined,
  });
  const result = await provider.inspectPage(input);
  if (!result.ok) throw result.error;
  const worker = result.value.workers.find(
    ({ target_id }) => target_id === "own",
  );
  expect(worker?.observation?.scripts).toEqual([]);
  expect(worker?.observation?.completeness.excluded).toContainEqual({
    section: "scripts",
    reason: "invalid_protocol_value",
    count: 1,
  });
});

it.each(["Target.setAutoAttach", "Runtime.enable", "Debugger.enable"])(
  "marks worker domains not enabled before detachment at %s",
  async (stage) => {
    const { provider, input } = await fixture({
      eventsBeforeReply: [stage],
      commandEvents: (command) =>
        command.sessionId === "worker-own" && command.method === stage
          ? [
              {
                method: "Target.detachedFromTarget",
                sessionId: "session-1",
                params: { sessionId: "worker-own" },
              },
            ]
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const observation = captured.value.workers.find(
      (w) => w.target_id === "own",
    )!.observation!;
    expect(observation.completeness.unavailable_sections).toContain(
      "network_requests",
    );
    if (stage !== "Debugger.enable")
      expect(observation.completeness.unavailable_sections).toContain(
        "scripts",
      );
  },
);

it.each([undefined, null, 42, ""])(
  "rejects malformed worker detachment session %j",
  async (sessionId) => {
    const { provider, input } = await fixture({
      commandEvents: (command) =>
        command.sessionId === "worker-own" &&
        command.method === "Network.enable"
          ? [
              {
                method: "Target.detachedFromTarget",
                sessionId: "session-1",
                params: { sessionId },
              },
            ]
          : undefined,
    });
    expect(await provider.inspectPage(input)).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  },
);

it("observes workers reached through an allowed iframe session and releases it", async () => {
  const { provider, input, browser } = await fixture({
    commandEvents: (command, origin) => {
      if (
        command.method !== "Target.setAutoAttach" ||
        command.params.autoAttach !== true
      )
        return undefined;
      if (command.sessionId === "session-1")
        return [
          {
            method: "Target.attachedToTarget",
            sessionId: "session-1",
            params: {
              sessionId: "iframe-session",
              targetInfo: {
                targetId: "iframe-target",
                type: "iframe",
                url: origin + "/frame",
                attached: true,
              },
            },
          },
        ];
      if (command.sessionId === "iframe-session")
        return [
          {
            method: "Target.attachedToTarget",
            sessionId: "iframe-session",
            params: {
              sessionId: "worker-child",
              targetInfo: {
                targetId: "child",
                type: "worker",
                url: origin + "/same.js",
                attached: true,
              },
            },
          },
        ];
      return [];
    },
  });
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  expect(
    captured.value.workers.find((w) => w.target_id === "child")?.observation,
  ).toMatchObject({
    ownership: "page_related",
    page_target_id: "allowed-page",
    scripts: [{ source: { included: true } }],
  });
  expect(browser.commands).toContainEqual(
    expect.objectContaining({
      method: "Target.detachFromTarget",
      params: { sessionId: "iframe-session" },
    }),
  );
});

it.each([
  "before",
  "before-unknown",
  "before-revoked",
  "after",
  "foreign",
  "detached",
  "detached-unknown",
  "detached-malformed",
] as const)(
  "scopes service worker clients to owned iframe targets (%s)",
  async (order) => {
    const { provider, input, browser } = await fixture({
      commandEvents: (command, origin) => {
        if (
          command.method !== "Target.setAutoAttach" ||
          command.params.autoAttach !== true ||
          command.sessionId !== "session-1"
        )
          return undefined;
        const frame = {
          method: "Target.attachedToTarget",
          sessionId: "session-1",
          params: {
            sessionId: "iframe-session",
            targetInfo: {
              targetId: "iframe-target",
              type: "iframe",
              url:
                order === "foreign"
                  ? "https://foreign.example/frame"
                  : origin + "/frame",
              attached: true,
            },
          },
        };
        const version = {
          method: "ServiceWorker.workerVersionUpdated",
          sessionId: "session-1",
          params: {
            versions: [
              {
                targetId: "service",
                controlledClients: ["iframe-target"],
                status: "activated",
              },
            ],
          },
        };
        const service = {
          method: "Target.attachedToTarget",
          sessionId: "session-1",
          params: {
            sessionId: "worker-service",
            targetInfo: {
              targetId: "service",
              type: "service_worker",
              url: origin + "/service.js",
              attached: true,
            },
          },
        };
        const versions: CdpEvent[] = [version];
        if (
          order.includes("unknown") ||
          order.includes("malformed") ||
          order === "before-revoked"
        )
          versions.push({
            ...version,
            params: {
              versions: [
                {
                  targetId: "service",
                  status: "activated",
                  ...(order === "before-revoked"
                    ? { controlledClients: [] }
                    : order.includes("malformed")
                      ? { controlledClients: [42] }
                      : {}),
                },
              ],
            },
          });
        const events = order.startsWith("before")
          ? [...versions, service, frame]
          : [frame, ...versions, service];
        return order.startsWith("detached")
          ? [
              ...events,
              {
                method: "Target.detachedFromTarget",
                sessionId: "session-1",
                params: { sessionId: "iframe-session" },
              },
            ]
          : events;
      },
    });
    const result = await provider.inspectPage(input);
    if (!result.ok) throw result.error;
    const observation = result.value.workers.find(
      (w) => w.target_id === "service",
    )?.observation;
    const enabled = browser.commands.some(
      (c) => c.sessionId === "worker-service" && c.method === "Debugger.enable",
    );
    if (order.includes("unknown") || order.includes("malformed"))
      expect(
        observation?.lifecycle
          .filter((event) => event.event === "version")
          .map((event) => event.controls_page),
      ).toEqual([true, null]);
    if (order === "before-unknown")
      expect(result.value.completeness.unavailable_sections).not.toContain(
        "workers",
      );
    if (order === "before-revoked") {
      expect(observation?.ownership).toBe("service_worker_client");
      expect(
        observation?.lifecycle
          .filter((event) => event.event === "version")
          .map((event) => event.controls_page),
      ).toEqual([true, false]);
      expect(observation?.scripts).toEqual([]);
    } else if (order === "foreign" || order.startsWith("detached")) {
      if (order === "foreign") expect(enabled).toBe(false);
      expect(observation?.scripts).toEqual([]);
      if (order.startsWith("detached"))
        expect(observation?.completeness.unavailable_sections).toContain(
          "scripts",
        );
    } else {
      expect(enabled).toBe(true);
      expect(observation).toMatchObject({
        ownership: "service_worker_client",
        page_target_id: "allowed-page",
        lifecycle: expect.arrayContaining([
          expect.objectContaining({ event: "version", controls_page: true }),
        ]),
      });
      expect(observation?.scripts[0]?.source.included).toBe(true);
    }
  },
);

it("bounds worker source requests while retaining cancellation cleanup", async () => {
  const { provider, input, browser } = await fixture({
    hangOnMethod: "Debugger.getScriptSource",
    commandEvents: (command, origin) =>
      command.method === "Debugger.enable" && command.sessionId === "worker-own"
        ? Array.from({ length: 64 }, (_, index) => ({
            method: "Debugger.scriptParsed",
            sessionId: "worker-own",
            params: {
              scriptId: String(index),
              url: origin + "/" + String(index) + ".js",
              hash: "hash",
              executionContextId: 1,
            },
          }))
        : undefined,
  });
  const abort = new AbortController();
  const pending = provider.inspectPage(input, { signal: abort.signal });
  try {
    await vi.waitFor(() =>
      expect(
        browser.commands.filter((c) => c.method === "Debugger.getScriptSource")
          .length,
      ).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      browser.commands.filter((c) => c.method === "Debugger.getScriptSource"),
    ).toHaveLength(1);
  } finally {
    abort.abort();
    await pending;
  }
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("authenticates explicit worker selections in retained Evidence", async () => {
  const { provider, input } = await fixture();
  const selected = { ...input, worker_target_ids: ["shared"] };
  const captured = await provider.inspectPage(selected);
  if (!captured.ok) throw captured.error;
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    selected,
    captured.value,
    provider.identity(),
  );
  expect(() => parseRuntimeCaptures([evidence])).not.toThrow();
  expect(selectScriptCapture(evidence).sourceEvidenceId).toBe(
    evidence.evidence_id,
  );
  for (const worker_target_ids of [undefined, [], ["other"]]) {
    const inconsistent = createBrowserEvidence(
      "inspect_web_page",
      { ...input, worker_target_ids },
      captured.value,
      provider.identity(),
    );
    expect(() => parseRuntimeCaptures([inconsistent])).toThrow();
    expect(() => selectScriptCapture(inconsistent)).toThrow();
  }
  const unknown = captured.value.workers.find(
    (w) => w.target_id === "shared",
  )!.observation!;
  unknown.selected_explicitly = false;
  const unselected = createBrowserEvidence(
    "inspect_web_page",
    input,
    captured.value,
    provider.identity(),
  );
  expect(() => parseRuntimeCaptures([unselected])).toThrow();
  expect(() => selectScriptCapture(unselected)).toThrow();
});

it.each(["explicit", "worker", "iframe"] as const)(
  "rejects child %s sessions aliasing the selected page",
  async (kind) => {
    const { provider, input, browser } = await fixture({
      commandResult: (c) =>
        kind === "explicit" &&
        c.method === "Target.attachToTarget" &&
        c.params.targetId === "shared"
          ? { sessionId: "session-1" }
          : undefined,
      commandEvents: (c, origin) =>
        kind !== "explicit" &&
        c.method === "Target.setAutoAttach" &&
        c.params.autoAttach === true &&
        c.sessionId === "session-1"
          ? [
              {
                method: "Target.attachedToTarget",
                sessionId: "session-1",
                params: {
                  sessionId: "session-1",
                  targetInfo: {
                    targetId: "child",
                    type: kind,
                    url: origin + "/child",
                    attached: true,
                  },
                },
              },
            ]
          : undefined,
    });
    expect(
      await provider.inspectPage({
        ...input,
        worker_target_ids: kind === "explicit" ? ["shared"] : [],
      }),
    ).toMatchObject({ ok: false, error: { reason: "protocol_error" } });
    // Only the outer owner may detach its page; child cleanup must not detach it twice.
    expect(
      browser.commands.filter(
        (c) =>
          c.method === "Target.detachFromTarget" &&
          c.params.sessionId === "session-1",
      ),
    ).toHaveLength(1);
    await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  },
);

it.each([undefined, { length: 1 }, []])(
  "distinguishes unknown worker inventories from explicit empty arrays: %j",
  async (targetInfos) => {
    const { provider, input } = await fixture({
      commandResult: (command) =>
        command.method === "Target.getTargets" ? { targetInfos } : undefined,
      commandEvents: () => [],
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    expect(captured.value.workers).toEqual([]);
    expect(
      captured.value.completeness.unavailable_sections.includes("workers"),
    ).toBe(!Array.isArray(targetInfos));
  },
);

it.each([
  { type: undefined },
  { type: 7 },
  { type: "" },
  { targetId: "" },
  { url: undefined },
  { attached: null },
  { openerId: null },
  { openerId: "" },
  { parentFrameId: null },
  { parentFrameId: "" },
])(
  "admits worker facts before applying origin or ownership policy: %j",
  async (override) => {
    const { provider, input } = await fixture({
      commandEvents: () => [],
      commandResult: (command) =>
        command.method === "Target.getTargets"
          ? {
              targetInfos: [
                { type: "page" },
                {
                  targetId: "worker",
                  type: "worker",
                  url: "https://outside.example/worker.js",
                  attached: false,
                  openerId: "foreign-page",
                  ...override,
                },
              ],
            }
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    expect(captured.value.workers).toEqual([]);
    expect(captured.value.completeness.unavailable_sections).toContain(
      "workers",
    );
    expect(
      captured.value.completeness.excluded.filter(
        ({ section }) => section === "workers",
      ),
    ).toEqual([
      { section: "workers", reason: "invalid_protocol_value", count: 1 },
    ]);
  },
);

it("retains valid worker records beside malformed inventory entries", async () => {
  const { provider, input } = await fixture({
    commandEvents: () => [],
    commandResult: (command, origin) =>
      command.method === "Target.getTargets"
        ? {
            targetInfos: [
              null,
              {
                targetId: "worker-1",
                type: "service_worker",
                url: origin + "/worker.js",
                attached: true,
                openerId: "allowed-page",
              },
              {
                targetId: "missing-url",
                type: "worker",
                attached: true,
                openerId: "another-page",
              },
              {
                type: "worker",
                url: origin + "/missing-id.js",
                attached: true,
              },
              {
                targetId: "bad-attached",
                type: "worker",
                url: origin + "/bad.js",
                attached: "true",
              },
              "malformed",
            ],
          }
        : undefined,
  });
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  expect(captured.value.workers.map((worker) => worker.target_id)).toEqual([
    "worker-1",
  ]);
  expect(captured.value.completeness.excluded).toContainEqual({
    section: "workers",
    reason: "invalid_protocol_value",
    count: 5,
  });
});

it.each(["attached", "url", "type"] as const)(
  "refreshes worker inventory while checking stable identity (%s)",
  async (change) => {
    let inventories = 0;
    const { provider, input } = await fixture({
      commandResult: (c, origin) => {
        if (c.method !== "Target.getTargets") return undefined;
        inventories += 1;
        return {
          targetInfos: [
            {
              targetId: "shared",
              type:
                inventories > 1 && change === "type"
                  ? "worker"
                  : "shared_worker",
              url:
                origin +
                (inventories > 1 && change === "url"
                  ? "/changed.js"
                  : "/shared.js"),
              attached: inventories > 1,
            },
          ],
        };
      },
    });
    const result = await provider.inspectPage({
      ...input,
      worker_target_ids: ["shared"],
    });
    if (change !== "attached") {
      expect(result).toMatchObject({
        ok: false,
        error: { reason: "target_changed" },
      });
      return;
    }
    if (!result.ok) throw result.error;
    expect(
      result.value.workers.find((w) => w.target_id === "shared"),
    ).toMatchObject({
      attached: true,
      observation: { scripts: [{ source: { included: true } }] },
    });
  },
);

it.each(["target_id", "allowed_origins", "include_script_sources"] as const)(
  "reports contradictory page %s at its caller parameter in both Evidence consumers",
  async (field) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const original = createBrowserEvidence(
      "inspect_web_page",
      input,
      captured.value,
      provider.identity(),
    );
    const evidence = createEvidence(undefined, original.provider, {
      predicateType: original.predicate_type,
      operation: original.operation,
      parameters: {
        ...original.parameters,
        [field]:
          field === "target_id"
            ? "another-page"
            : field === "allowed_origins"
              ? []
              : false,
      },
      result: original.normalized_result,
      confidence: original.confidence,
      authority: original.authority,
      environment: original.environment,
      limitations: original.limitations,
    });
    const checked = browserWorkerEvidenceScopeSchema.safeParse(evidence);
    expect(checked.success).toBe(false);
    if (checked.success) throw new Error("Expected contradictory selection");
    expect(checked.error.issues).toContainEqual(
      expect.objectContaining({ path: ["parameters", field] }),
    );
    expect(() => parseRuntimeCaptures([evidence])).toThrow();
    expect(() => selectScriptCapture(evidence)).toThrow();
  },
);

it("reports a contradictory page origin at the captured target", async () => {
  const { provider, input } = await fixture();
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  captured.value.target.origin = "https://foreign.example";
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    captured.value,
    provider.identity(),
  );
  const checked = browserWorkerEvidenceScopeSchema.safeParse(evidence);
  expect(checked.success).toBe(false);
  if (checked.success) throw new Error("Expected contradictory origin");
  expect(checked.error.issues).toContainEqual(
    expect.objectContaining({ path: ["normalized_result", "target"] }),
  );
  expect(() => parseRuntimeCaptures([evidence])).toThrow(
    expect.objectContaining({
      _tag: "AnalysisInputError",
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/origin scope/u),
        }),
      ]),
    }),
  );
  expect(() => selectScriptCapture(evidence)).toThrow(/origin scope/u);
});

it.each(["target", "script", "origin"] as const)(
  "rejects out-of-scope worker %s in Evidence consumers",
  async (changed) => {
    const { provider, input } = await fixture();
    const selected = { ...input, worker_target_ids: ["shared"] };
    const captured = await provider.inspectPage(selected);
    if (!captured.ok) throw captured.error;
    const worker = captured.value.workers.find(
      (w) => w.target_id === "shared",
    )!;
    if (changed === "target") {
      worker.url = "https://foreign.example/worker.js";
      worker.origin = "https://foreign.example";
    } else if (changed === "origin") worker.origin = "https://foreign.example";
    else
      worker.observation!.scripts[0]!.url = "https://foreign.example/child.js";
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      selected,
      captured.value,
      provider.identity(),
    );
    // A canonical digest authenticates these bytes, not their selection consistency.
    expect(() => parseEvidence(evidence)).not.toThrow();
    expect(() => parseRuntimeCaptures([evidence])).toThrow(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/origin scope/u),
          }),
        ]),
      }),
    );
    expect(() => selectScriptCapture(evidence)).toThrow(/origin scope/u);
  },
);

it.each([
  ["page_related", null],
  ["page_related", "another-page"],
  ["service_worker_client", null],
  ["service_worker_client", "another-page"],
  ["unknown", "allowed-page"],
] as const)(
  "rejects contradictory worker ownership %s / %s in Evidence consumers",
  async (ownership, pageTargetId) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage({
      ...input,
      worker_target_ids: ["shared"],
    });
    if (!captured.ok) throw captured.error;
    const observation = captured.value.workers.find(
      (w) => w.target_id === "shared",
    )!.observation!;
    observation.ownership = ownership;
    observation.page_target_id = pageTargetId;
    observation.selected_explicitly = ownership === "unknown";
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      ownership === "unknown"
        ? { ...input, worker_target_ids: ["shared"] }
        : input,
      captured.value,
      provider.identity(),
    );
    expect(() => parseEvidence(evidence)).not.toThrow();
    expect(() => parseRuntimeCaptures([evidence])).toThrow(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/ownership/u),
          }),
        ]),
      }),
    );
    expect(() => selectScriptCapture(evidence)).toThrow(/ownership/u);
  },
);

it.each([
  "page",
  "worker",
  "service",
  "clients",
  "unresolved-version",
  "inventory",
  "legacy",
  "none",
] as const)(
  "keeps script absence unknown after failed %s discovery",
  async (failed) => {
    const { provider, input } = await fixture({
      commandEvents: (command) =>
        (failed === "clients" || failed === "unresolved-version") &&
        command.method === "ServiceWorker.enable"
          ? [
              {
                method: "ServiceWorker.workerVersionUpdated",
                sessionId: "session-1",
                params: {
                  versions: [
                    {
                      targetId: "service",
                      status: "activated",
                      ...(failed === "unresolved-version"
                        ? { controlledClients: ["allowed-page"] }
                        : {}),
                    },
                  ],
                },
              },
            ]
          : undefined,
      commandError: (c) =>
        (
          failed === "service"
            ? c.method === "ServiceWorker.enable"
            : failed === "inventory"
              ? c.method === "Target.getTargets"
              : failed !== "none" &&
                failed !== "clients" &&
                failed !== "unresolved-version" &&
                failed !== "legacy" &&
                c.method === "Target.setAutoAttach" &&
                c.params.autoAttach === true &&
                c.sessionId === (failed === "page" ? "session-1" : "worker-own")
        )
          ? { code: -32601, message: "Unavailable" }
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    if (failed === "legacy")
      for (const worker of captured.value.workers) delete worker.observation;
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      captured.value,
      provider.identity(),
    );
    expect(
      parseRuntimeCaptures([evidence])[0]?.scriptsCompleteWithinScope,
    ).toBe(failed === "none");
    const root = await applicationFixture();
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: [
        {
          role: "application",
          analysis: await analyzeFixture(root),
          runtime_mappings: [
            {
              kind: "url-prefix",
              prefix: captured.value.target.origin + "/",
              artifact_prefix: "",
            },
          ],
        },
      ],
      runtime_observations: [evidence],
    });
    if (!reconciled.ok) throw reconciled.error;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.normalized_result,
    );
    expect(
      result.static_load_states.some(
        (state) => state.status === "not-observed-in-capture",
      ),
    ).toBe(false);
    // Discovery success does not establish pre-attachment worker code coverage.
    expect(result.static_load_states).toContainEqual(
      expect.objectContaining({
        status: "unknown",
        reason: "static-or-runtime-coverage-incomplete",
      }),
    );
  },
);

it.each(
  [undefined, null, {}, [null], [5], [{ status: "stopped" }, null]].map(
    (versions) => ({ versions }),
  ),
)(
  "retains unknown worker coverage after a malformed version update: %j",
  async ({ versions }) => {
    const { provider, input } = await fixture({
      commandEvents: (command) =>
        command.method === "ServiceWorker.enable"
          ? [
              {
                method: "ServiceWorker.workerVersionUpdated",
                sessionId: "session-1",
                params: { versions },
              },
            ]
          : undefined,
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    expect(captured.value.completeness.unavailable_sections).toContain(
      "workers",
    );
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      captured.value,
      provider.identity(),
    );
    expect(
      parseRuntimeCaptures([evidence])[0]?.scriptsCompleteWithinScope,
    ).toBe(false);
    const root = await applicationFixture();
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: [
        {
          role: "application",
          analysis: await analyzeFixture(root),
          runtime_mappings: [
            {
              kind: "url-prefix",
              prefix: captured.value.target.origin + "/",
              artifact_prefix: "",
            },
          ],
        },
      ],
      runtime_observations: [evidence],
    });
    if (!reconciled.ok) throw reconciled.error;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.normalized_result,
    );
    expect(
      result.static_load_states.some(
        (state) => state.status === "not-observed-in-capture",
      ),
    ).toBe(false);
    expect(result.static_load_states).toContainEqual(
      expect.objectContaining({
        status: "unknown",
        reason: "static-or-runtime-coverage-incomplete",
      }),
    );
  },
);

it("keeps unselected unknown-owner workers out of runtime matching", async () => {
  const { provider, input } = await fixture();
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    captured.value,
    provider.identity(),
  );
  const projected = projectRuntimeCaptures(parseRuntimeCaptures([evidence]));
  expect(
    projected.entities
      .filter((e) => e.kind === "worker")
      .map((e) => e.runtimeKey),
  ).toEqual(["own"]);
  expect(captured.value.workers.some((w) => w.target_id === "other")).toBe(
    true,
  );
});

it.each(["cdp_hash", "is_module", "source_map_url"] as const)(
  "compares observed worker script %s while preserving incomplete absence",
  async (field) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    if (field === "is_module")
      captured.value.workers.find(
        (w) => w.target_id === "own",
      )!.observation!.scripts[0]!.is_module = false;
    const before = captured.value,
      after = structuredClone(before);
    const observation = after.workers.find(
      (w) => w.target_id === "own",
    )!.observation!;
    Object.assign(observation.scripts[0]!, {
      [field]: field === "is_module" ? true : "changed",
    });
    const compare = () =>
      compareWebCaptures({
        before: { inspection: before, webmcp: null },
        after: { inspection: after, webmcp: null },
      }).dimensions.scripts;
    expect(compare()).toMatchObject({ status: "changed", total_changes: 1 });
    observation.scripts = [];
    observation.completeness.unavailable_sections.push("scripts");
    expect(compare()).toMatchObject({ status: "unknown", total_changes: 0 });
  },
);

it.each(["target", "script"] as const)(
  "rejects unsanitized worker %s URLs",
  async (location) => {
    const { provider, input } = await fixture();
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const worker = captured.value.workers.find((w) => w.target_id === "own")!;
    const selected =
      location === "target" ? worker : worker.observation!.scripts[0]!;
    const url = new URL(selected.url);
    url.username = "user";
    url.password = "secret";
    selected.url = url.href;
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      captured.value,
      provider.identity(),
    );
    expect(() => parseRuntimeCaptures([evidence])).toThrow(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/sanitized/u),
          }),
        ]),
      }),
    );
    expect(() => selectScriptCapture(evidence)).toThrow(/sanitized/u);
  },
);

it.each([false, true])(
  "retains worker console and websocket evidence with selected content=%s",
  async (selected) => {
    const { provider, input } = await fixture({
      commandEvents(command, origin) {
        if (
          command.method !== "Network.enable" ||
          command.sessionId !== "worker-own"
        )
          return undefined;
        return [
          {
            method: "Runtime.consoleAPICalled",
            sessionId: "worker-own",
            params: {
              type: "log",
              timestamp: 1,
              args: [{ type: "string", value: "worker text" }],
              stackTrace: {
                callFrames: [
                  { url: origin + "/same.js", lineNumber: 0, columnNumber: 0 },
                ],
              },
            },
          },
          {
            method: "Network.webSocketCreated",
            sessionId: "worker-own",
            params: {
              requestId: "ws",
              url: origin.replace("http:", "ws:") + "/socket",
            },
          },
          {
            method: "Network.webSocketFrameReceived",
            sessionId: "worker-own",
            params: {
              requestId: "ws",
              response: { opcode: 1, payloadData: '{"value":1}' },
            },
          },
        ];
      },
    });
    const captured = await provider.inspectPage({
      ...input,
      include_console_text: selected,
      include_websocket_shapes: selected,
    });
    if (!captured.ok) throw captured.error;
    const observation = captured.value.workers.find(
      (w) => w.target_id === "own",
    )!.observation!;
    expect(observation).toMatchObject({
      console_events: [
        {
          type: "log",
          text_capture: { status: selected ? "included" : "not_approved" },
        },
      ],
      websocket_connections: [
        { events: [{ direction: "received", opcode: 1 }] },
      ],
    });
    expect(JSON.stringify(observation)).toContain(
      selected ? "worker text" : "not_approved",
    );
    if (!selected)
      expect(JSON.stringify(observation)).not.toContain("worker text");
  },
);

it.each(["before", "after", "detached", "foreign"] as const)(
  "recognizes page-owned dedicated clients of service workers: %s",
  async (order) => {
    const { provider, input, browser } = await fixture({
      commandEvents(command, origin) {
        if (
          command.method !== "Target.setAutoAttach" ||
          command.params.autoAttach !== true ||
          command.sessionId !== "session-1"
        )
          return undefined;
        const attached = (id: string, type: string): CdpEvent => ({
          method: "Target.attachedToTarget",
          sessionId: "session-1",
          params: {
            sessionId: "worker-" + id,
            targetInfo: {
              targetId: id,
              type,
              url: origin + "/" + id + ".js",
              attached: true,
            },
          },
        });
        const version: CdpEvent = {
          method: "ServiceWorker.workerVersionUpdated",
          sessionId: "session-1",
          params: {
            versions: [
              {
                targetId: "service",
                controlledClients: [order === "foreign" ? "unowned" : "client"],
                status: "activated",
              },
            ],
          },
        };
        const events =
          order === "before"
            ? [
                version,
                attached("service", "service_worker"),
                attached("client", "worker"),
              ]
            : [
                attached("client", "worker"),
                version,
                attached("service", "service_worker"),
              ];
        if (order === "detached")
          events.push({
            method: "Target.detachedFromTarget",
            sessionId: "session-1",
            params: { sessionId: "worker-client" },
          });
        return events;
      },
    });
    const captured = await provider.inspectPage(input);
    if (!captured.ok) throw captured.error;
    const observation = captured.value.workers.find(
      (w) => w.target_id === "service",
    )!.observation!;
    expect(observation.ownership).toBe(
      order === "foreign" ? "unknown" : "service_worker_client",
    );
    expect(
      observation.lifecycle.find((x) => x.event === "version")?.controls_page,
    ).toBe(order !== "foreign");
    expect(
      browser.commands.some(
        (c) =>
          c.method === "Debugger.enable" && c.sessionId === "worker-service",
      ),
    ).toBe(order !== "foreign" && order !== "detached");
    if (order === "detached") {
      // The client is detached before this queued service-worker enable starts.
      // Keep the historical ownership event, but issue no new domain commands
      // and retain no script evidence outside the remaining capture scope.
      expect(observation.scripts).toEqual([]);
      expect(observation.completeness.unavailable_sections).toEqual(
        expect.arrayContaining([
          "console_events",
          "websocket_connections",
          "websocket_frames",
        ]),
      );
      expect(observation.completeness.unavailable_sections).toContain(
        "scripts",
      );
    }
  },
);

it.each(["own", "shared"])(
  "rejects worker %s source bytes contrary to recorded source selection",
  async (targetId) => {
    const { provider, input } = await fixture();
    const selected = { ...input, worker_target_ids: ["shared"] };
    const captured = await provider.inspectPage(selected);
    if (!captured.ok) throw captured.error;
    captured.value.scripts = { total: 0, items: [] };
    captured.value.workers = captured.value.workers.filter(
      (worker) => worker.target_id === targetId,
    );
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      { ...selected, include_script_sources: false },
      captured.value,
      provider.identity(),
    );
    expect(() => parseEvidence(evidence)).not.toThrow();
    expect(() => parseRuntimeCaptures([evidence])).toThrow(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/source/u),
          }),
        ]),
      }),
    );
    expect(() => selectScriptCapture(evidence)).toThrow(/source/u);
    expect(() => selectScriptCapture(captured.value)).not.toThrow();
  },
);

it.each([
  "selection",
  "origin",
  "ownership",
  "source-selection",
  "unsanitized",
  "missing-selection",
  "missing-observation",
  "service-target-type",
  "dedicated-target-type",
  "page-target",
  "page-origin",
  "page-source-selection",
  "page-unsanitized",
] as const)(
  "rejects inconsistent worker Evidence through CLI and MCP without publishing: %s",
  async (mismatch) => {
    const { provider, input } = await fixture();
    const selected = { ...input, worker_target_ids: ["shared"] };
    const captured = await provider.inspectPage(selected);
    if (!captured.ok) throw captured.error;
    const root = await createTestTempDirectory(
      "rea-worker-selection-boundary-",
    );
    const { call, client } = await connectLocalToolsMcp();
    const inspection = structuredClone(captured.value);
    if (mismatch === "page-target")
      inspection.target.target_id = "different-page";
    if (mismatch === "page-origin")
      inspection.target.url = "https://foreign.example/page";
    if (mismatch === "page-source-selection") inspection.workers = [];
    if (mismatch === "page-unsanitized") {
      const url = new URL(inspection.target.url);
      url.username = "user";
      inspection.target.url = url.href;
    }
    if (mismatch === "missing-selection")
      inspection.workers = inspection.workers.filter(
        (w) => w.target_id !== "shared",
      );
    if (mismatch === "missing-observation")
      delete inspection.workers.find((w) => w.target_id === "shared")!
        .observation;
    if (mismatch === "unsanitized") {
      const script = inspection.workers.find((w) => w.target_id === "shared")!
        .observation!.scripts[0]!;
      const url = new URL(script.url);
      url.username = "user";
      url.password = "secret";
      script.url = url.href;
    }
    if (mismatch === "origin")
      inspection.workers.find(
        (w) => w.target_id === "shared",
      )!.observation!.scripts[0]!.url = "https://foreign.example/worker.js";
    if (mismatch === "ownership") {
      const observation = inspection.workers.find(
        (w) => w.target_id === "shared",
      )!.observation!;
      observation.selected_explicitly = false;
      observation.ownership = "page_related";
      observation.page_target_id = null;
    }
    if (mismatch === "dedicated-target-type") {
      const observation = inspection.workers.find(
        (w) => w.target_id === "shared",
      )!.observation!;
      observation.ownership = "page_related";
      observation.selected_explicitly = false;
      observation.page_target_id = input.target_id;
    }
    if (mismatch === "service-target-type") {
      const observation = inspection.workers.find(
        (w) => w.target_id === "shared",
      )!.observation!;
      observation.ownership = "service_worker_client";
      observation.page_target_id = input.target_id;
    }
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      mismatch === "source-selection" || mismatch === "page-source-selection"
        ? { ...selected, include_script_sources: false }
        : mismatch === "origin" ||
            mismatch === "unsanitized" ||
            mismatch === "missing-selection" ||
            mismatch === "missing-observation" ||
            mismatch === "service-target-type" ||
            mismatch.startsWith("page-")
          ? selected
          : input,
      inspection,
      provider.identity(),
    );
    const capture = join(root, mismatch + ".json");
    const bytes = JSON.stringify(evidence);
    await writeFile(capture, bytes);
    const cliOutput = join(root, mismatch + "-cli");
    const mcpOutput = join(root, mismatch + "-mcp");
    await expect(
      promisify(execFile)(
        process.execPath,
        ["scripts/rea.mjs", "export-web-scripts", capture, cliOutput, "--json"],
        { maxBuffer: 8 * 1024 * 1024 },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("invalid_request"),
    });
    const response = await call("export_web_scripts", {
      capture_path: capture,
      output_directory: mcpOutput,
    });
    expect(parseMcpToolError(response)).toMatchObject({
      error: { code: "invalid_request" },
    });
    for (const output of [cliOutput, mcpOutput])
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(capture, "utf8")).toBe(bytes);
    await client.ping();
  },
  30000,
);

it("retains attach-limited worker node and containment coverage", async () => {
  const { provider, input } = await fixture();
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    captured.value,
    provider.identity(),
  );
  const projected = projectRuntimeCaptures(parseRuntimeCaptures([evidence]));
  const worker = projected.entities.find(
    (e) => e.kind === "worker" && e.runtimeKey === "own",
  )!;
  expect(worker.coverage).toMatchObject({
    status: "partial",
    omitted_count: null,
  });
  expect(
    projected.edges.find((e) => e.target_node_id === worker.node.node_id)
      ?.evidence.coverage,
  ).toMatchObject({ status: "partial", omitted_count: null });
});

it.each(["controlled", "revoked", "foreign"] as const)(
  "retains discovery gaps for unresolved Service Worker versions: %s",
  (scope) => verifyUnresolved(scope),
);
async function verifyUnresolved(scope: "controlled" | "revoked" | "foreign") {
  const { provider, input } = await fixture({
    commandEvents: (command) =>
      command.method === "ServiceWorker.enable"
        ? [
            {
              method: "ServiceWorker.workerVersionUpdated",
              sessionId: "session-1",
              params: {
                versions: [
                  {
                    targetId: "vanished",
                    controlledClients: [
                      scope === "foreign" ? "other-page" : "allowed-page",
                    ],
                    status: "activated",
                  },
                  ...(scope === "revoked"
                    ? [
                        {
                          targetId: "vanished",
                          controlledClients: [],
                          status: "redundant",
                        },
                      ]
                    : []),
                ],
              },
            },
          ]
        : undefined,
  });
  const captured = await provider.inspectPage(input);
  if (!captured.ok) throw captured.error;
  expect(captured.value.workers.some((w) => w.target_id === "vanished")).toBe(
    false,
  );
  expect(
    captured.value.completeness.unavailable_sections.includes("workers"),
  ).toBe(scope !== "foreign");
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    captured.value,
    provider.identity(),
  );
  expect(parseRuntimeCaptures([evidence])[0]?.scriptsCompleteWithinScope).toBe(
    scope === "foreign",
  );
}

it.each(["worker", "shared_worker"] as const)(
  "rejects Service Worker ownership on a %s across event orders",
  async (type) => {
    for (const before of [true, false]) {
      const { provider, input, browser } = await fixture({
        commandEvents(command, origin) {
          if (
            command.method !== "Target.setAutoAttach" ||
            command.params.autoAttach !== true ||
            command.sessionId !== "session-1"
          )
            return undefined;
          const version: CdpEvent = {
            method: "ServiceWorker.workerVersionUpdated",
            sessionId: "session-1",
            params: {
              versions: [
                {
                  targetId: "mismatch",
                  controlledClients: ["allowed-page"],
                  status: "activated",
                },
              ],
            },
          };
          const attached: CdpEvent = {
            method: "Target.attachedToTarget",
            sessionId: "session-1",
            params: {
              sessionId: "worker-mismatch",
              targetInfo: {
                targetId: "mismatch",
                type,
                url: origin + "/mismatch.js",
                attached: true,
              },
            },
          };
          return before ? [version, attached] : [attached, version];
        },
      });
      const captured = await provider.inspectPage(input);
      if (!captured.ok) throw captured.error;
      const observation = captured.value.workers.find(
        (w) => w.target_id === "mismatch",
      )!.observation!;
      expect(observation.ownership).toBe(
        type === "worker" ? "page_related" : "unknown",
      );
      expect(observation.lifecycle.some((e) => e.event === "version")).toBe(
        false,
      );
      expect(captured.value.completeness.unavailable_sections).toContain(
        "workers",
      );
      expect(JSON.stringify(captured.value.completeness)).toContain(
        "invalid_protocol_value",
      );
      expect(
        browser.commands.some(
          (c) =>
            c.method === "Debugger.enable" && c.sessionId === "worker-mismatch",
        ),
      ).toBe(type === "worker");
      observation.ownership = "service_worker_client";
      observation.page_target_id = input.target_id;
      const evidence = createBrowserEvidence(
        "inspect_web_page",
        input,
        captured.value,
        provider.identity(),
      );
      expect(() => parseRuntimeCaptures([evidence])).toThrow(
        expect.objectContaining({
          _tag: "AnalysisInputError",
          issues: expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringMatching(/service_worker target/),
            }),
          ]),
        }),
      );
      expect(() => selectScriptCapture(evidence)).toThrow(
        /service_worker target/,
      );
    }
  },
);

it.each(["shared_worker", "service_worker"] as const)(
  "rejects forged page-related ownership for %s in both retained consumers",
  async (type) => {
    const { provider, input } = await fixture();
    const selected = { ...input, worker_target_ids: ["shared"] };
    const capture = await provider.inspectPage(selected);
    if (!capture.ok) throw capture.error;
    const worker = capture.value.workers.find((w) => w.target_id === "shared")!;
    worker.type = type;
    worker.observation!.ownership = "page_related";
    worker.observation!.page_target_id = input.target_id;
    worker.observation!.selected_explicitly = false;
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      capture.value,
      provider.identity(),
    );
    expect(() => parseRuntimeCaptures([evidence])).toThrow(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/dedicated worker/),
          }),
        ]),
      }),
    );
    expect(() => selectScriptCapture(evidence)).toThrow(/dedicated worker/);
  },
);

it("retains safe worker response metadata and untrusted agent hints through Evidence parsing", async () => {
  const { provider, input } = await fixture({
    commandEvents(command, origin) {
      if (
        command.method !== "Network.enable" ||
        command.sessionId !== "worker-own"
      )
        return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: "worker-own",
          params: {
            requestId: "headers",
            type: "Fetch",
            request: { url: origin + "/headers", method: "GET", headers: {} },
            initiator: { type: "script" },
          },
        },
        {
          method: "Network.responseReceived",
          sessionId: "worker-own",
          params: {
            requestId: "headers",
            response: {
              url: origin + "/headers",
              status: 200,
              mimeType: "text/plain",
              headers: {
                "Content-Security-Policy":
                  "default-src 'self';script-src 'nonce-secret-token'",
                Link: '</agent>; rel="mcp"',
                "Cross-Origin-Resource-Policy": "same-origin",
                "Set-Cookie": "credential-secret",
                Authorization: "Bearer credential-secret",
              },
            },
          },
        },
      ];
    },
  });
  const capture = await provider.inspectPage(input);
  if (!capture.ok) throw capture.error;
  const metadata = capture.value.workers.find(
    (w) => w.target_id === "own",
  )!.observation!;
  expect(metadata).toMatchObject({
    metadata: {
      headers_allowlisted: true,
      responses: [
        {
          request_id: "headers",
          csp: { nonce_count: 1 },
          policies: { corp: "same-origin" },
        },
      ],
      agent_hints: [{ declaration: "mcp", trust: "page-declared-untrusted" }],
    },
  });
  const evidence = createBrowserEvidence(
    "inspect_web_page",
    input,
    capture.value,
    provider.identity(),
  );
  const retained = parseEvidence(JSON.parse(JSON.stringify(evidence)));
  expect(JSON.stringify(retained)).toContain("headers_allowlisted");
  expect(JSON.stringify(metadata)).not.toMatch(
    /credential-secret|nonce-secret-token/,
  );
  expect(retained.normalized_result).toEqual(evidence.normalized_result);
  const scope = browserWorkerEvidenceScopeSchema.parse(evidence);
  expect(
    scope.normalized_result.workers.find((w) => w.target_id === "own")!
      .observation,
  ).toEqual(metadata);
});

it.each(["complete", "abort", "failure", "detach"] as const)(
  "bounds queued worker/frame lifecycle commands and settles %s",
  async (mode) => {
    const total = 20;
    const controller = new AbortController();
    const { provider, input, browser } = await fixture({
      hangOnCommand: (c) =>
        c.sessionId?.startsWith("burst-") === true &&
        c.method === "Target.setAutoAttach" &&
        c.params.autoAttach === true,
      commandEvents(c, origin) {
        if (
          c.method === "Target.setAutoAttach" &&
          c.params.autoAttach === true &&
          c.sessionId === "session-1"
        )
          return Array.from({ length: total }, (_, i) => ({
            method: "Target.attachedToTarget",
            sessionId: "session-1",
            params: {
              sessionId: `burst-${i}`,
              targetInfo: {
                targetId: `burst-target-${i}`,
                type: i < 16 ? "worker" : "iframe",
                url: origin + `/burst-${i}.js`,
                attached: true,
              },
            },
          }));
        if (c.sessionId?.startsWith("burst-")) return [];
        return undefined;
      },
    });
    const pending = provider.inspectPage(input, { signal: controller.signal });
    const attaching = () =>
      browser.commands.filter(
        (c) =>
          c.sessionId?.startsWith("burst-") &&
          c.method === "Target.setAutoAttach" &&
          c.params.autoAttach === true,
      );
    try {
      await vi.waitFor(() => expect(attaching()).toHaveLength(1));
      if (mode === "abort") controller.abort();
      else if (mode === "failure") {
        const first = attaching()[0]!;
        browser.emitRawMessage(
          JSON.stringify({
            id: first.id,
            sessionId: first.sessionId,
            error: { code: -32602, message: "Invalid params" },
          }),
        );
      } else {
        if (mode === "detach")
          browser.emitEvent({
            method: "Target.detachedFromTarget",
            sessionId: "session-1",
            params: { sessionId: "burst-1", targetId: "burst-target-1" },
          });
        for (let i = 0; i < total - (mode === "detach" ? 1 : 0); i++) {
          await vi.waitFor(() => expect(attaching()).toHaveLength(i + 1));
          const command = attaching()[i]!;
          browser.emitRawMessage(
            JSON.stringify({
              id: command.id,
              sessionId: command.sessionId,
              result: {},
            }),
          );
        }
      }
      const result = await pending;
      expect(result.ok).toBe(mode === "complete" || mode === "detach");
      if (mode === "abort" || mode === "failure")
        expect(attaching()).toHaveLength(1);
      else
        expect(
          browser.commands.filter(
            (c) =>
              c.sessionId?.startsWith("burst-") &&
              c.method === "Network.enable",
          ),
        ).toHaveLength(mode === "detach" ? 15 : 16);
      if (mode === "detach")
        expect(
          browser.commands.some(
            (c) => c.sessionId === "burst-1" && c.method === "Runtime.enable",
          ),
        ).toBe(false);
      await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      controller.abort();
      await pending;
    }
  },
);
