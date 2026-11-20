import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { createJavaScriptRuntimeObservationEvidence } from "../../../src/application/javascript/JavaScriptRuntimeObservationEvidence.js";
import { createBrowserEvidence } from "../../../src/application/BrowserEvidence.js";
import { observeJavaScriptRuntime } from "../../../src/application/javascript/JavaScriptRuntimeObservationService.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "../../../src/inspector/providerIdentity.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";
import type {
  JavaScriptRuntimeObservation,
  ObserveJavaScriptRuntimeInput,
} from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import {
  javascriptRuntimeObservationSchema,
  observeJavaScriptRuntimeInputSchema,
} from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  createEvidence,
  evidenceSubjectInput,
} from "../../../src/domain/evidence.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { parseRuntimeCapture } from "../../../src/domain/javascript/javascriptRuntimeReconciliationCaptureParsing.js";
import {
  nodeDiscoveryTargetUrl,
  startFakeV8Inspector,
} from "../../fixtures/inspector/fakeV8Inspector.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { createNodeDiscoveryTempDirectory } from "../../fixtures/temporaryDirectory.js";

test("reports static-layer Evidence digest failure at its caller path", () => {
  const layer = JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers[0];
  if (layer === undefined) throw new Error("Expected a static layer example");
  const runtime = createJavaScriptRuntimeObservationEvidence(
    "observe_javascript_runtime",
    {
      inspector_endpoint: "http://127.0.0.1:9229",
      target_id: "example-v8-target",
      runtime_kind: "electron-main",
      observation_ms: 100,
    },
    runtimeObservation("/tmp/index.html", "/tmp/main.js"),
    V8_INSPECTOR_PROVIDER_IDENTITY,
  );
  const result = reconcileJavaScriptRuntimeEvidence({
    static_layers: [
      {
        ...layer,
        analysis: { ...layer.analysis, evidence_id: `ev_${"0".repeat(64)}` },
      },
    ],
    runtime_observations: [runtime],
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["static_layers", 0, "analysis", "evidence_id"],
          reason: "invalid_value",
          message: expect.stringMatching(/semantic identifier.*not match/iu),
        },
      ],
    },
  });
});

test("reports browser origin scope mismatch at the caller parameter path", async () => {
  const browser = await startFakeCdpBrowser();
  try {
    const provider = new CdpBrowserProvider();
    const input = inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    });
    const observed = await provider.inspectPage(input);
    if (!observed.ok) throw observed.error;
    const evidence = createBrowserEvidence(
      "inspect_web_page",
      input,
      { source: jsonValueSchema.parse(observed.value), facts: observed.value },
      provider.identity(),
    );
    const invalidEvidence = createEvidence(
      evidenceSubjectInput(evidence.subject),
      evidence.provider,
      {
        predicateType: evidence.predicate_type,
        operation: evidence.operation,
        parameters: { ...evidence.parameters, allowed_origins: [] },
        result: evidence.normalized_result,
        confidence: evidence.confidence,
        authority: evidence.authority,
        environment: evidence.environment,
        limitations: evidence.limitations,
      },
    );
    const result = reconcileJavaScriptRuntimeEvidence({
      static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
      runtime_observations: [invalidEvidence],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["runtime_observations", 0, "parameters", "allowed_origins"],
            reason: "invalid_value",
            message: expect.stringMatching(
              /target.*outside.*recorded origin scope/i,
            ),
          },
        ],
      },
    });
  } finally {
    await browser.close();
  }
});

test("retains destroyed context metadata after ID reuse and records unseen destructions", async () => {
  const fixture = await runtimeFixture();
  const fake = await startFakeV8Inspector({
    targetUrl: pathToFileURL(fixture.entry).href,
    runtimeEvents: [
      {
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 1,
            origin: "https://old.example",
            name: "old context",
          },
        },
      },
      {
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: 1 },
      },
      {
        method: "Runtime.executionContextCreated",
        params: { context: { id: 1, origin: "", name: "" } },
      },
      {
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: 2 },
      },
    ],
  });
  try {
    const result = await new V8InspectorProvider().observe(
      observeInput(fake.endpoint, fake.targetId, "node"),
    );
    if (!result.ok) throw result.error;
    const contexts = result.value.execution_contexts;
    expect(contexts).toHaveLength(3);
    expect(new Set(contexts.map(({ context_key }) => context_key)).size).toBe(
      3,
    );
    expect(contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_context_id: 1,
          state: "destroyed",
          name: "old context",
          origin: "https://old.example",
        }),
        expect.objectContaining({
          execution_context_id: 1,
          state: "created",
          name: "",
          origin: "",
        }),
        expect.objectContaining({
          execution_context_id: 2,
          state: "destroyed",
          name: null,
          origin: null,
        }),
      ]),
    );
  } finally {
    await fake.close();
  }
});

test("counts malformed lifecycle events without altering valid Inspector contexts", async () => {
  const fixture = await runtimeFixture();
  const fake = await startFakeV8Inspector({
    targetUrl: pathToFileURL(fixture.entry).href,
    runtimeEvents: [
      {
        method: "Runtime.executionContextCreated",
        params: { context: { id: 1, name: "main", origin: "" } },
      },
      {
        method: "Runtime.executionContextCreated",
        params: { context: { id: "2", name: "bad", origin: "" } },
      },
      {
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: "1" },
      },
      {
        method: "Runtime.executionContextCreated",
        params: { context: { id: 2, name: "worker", origin: "" } },
      },
      {
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: 2 },
      },
    ],
    scriptEvents: [],
  });
  try {
    const result = await new V8InspectorProvider().observe(
      observeInput(fake.endpoint, fake.targetId, "node"),
    );
    if (!result.ok) throw result.error;
    expect(result.value.capture).toMatchObject({
      events_observed: 5,
      events_retained: 5,
      events_dropped: 0,
      truncated: false,
    });
    expect(result.value.execution_contexts).toEqual([
      {
        context_key: "context_0",
        execution_context_id: 1,
        state: "created",
        name: "main",
        origin: "",
      },
      {
        context_key: "context_1",
        execution_context_id: 2,
        state: "destroyed",
        name: "worker",
        origin: "",
      },
    ]);
    expect(
      result.value.unknowns.filter((text) =>
        text.includes("malformed execution-context ID"),
      ),
    ).toEqual([
      "2 execution-context lifecycle events with a missing or malformed execution-context ID were excluded; the affected contexts' lifecycle state is unknown.",
    ]);
  } finally {
    await fake.close();
  }
});

test("rejects unknown runtime observation fields", () => {
  expect(
    observeJavaScriptRuntimeInputSchema.safeParse({
      inspector_endpoint: "http://127.0.0.1:9229",
      target_id: "target-1",
      unknown_field: true,
    }).success,
  ).toBe(false);
});

// Node discovery turns backslashes into underscores, so a Windows host path
// stays unresolved instead of resolving to a file.
test.skipIf(process.platform === "win32")(
  "lists all connectable targets on the selected endpoint across directories",
  async () => {
    const fixture = await runtimeFixture();
    const outside = await temporaryFile("outside.js");
    const fake = await startFakeV8Inspector({
      targetUrl: nodeDiscoveryTargetUrl(fixture.entry),
      additionalTargets: [{ url: nodeDiscoveryTargetUrl(outside) }],
      additionalTargetCount: 205,
    });
    try {
      const listed = await new V8InspectorProvider().listTargets({
        inspector_endpoint: fake.endpoint,
      });
      if (!listed.ok) throw listed.error;
      const targets = listed.value.targets;
      expect(targets).toHaveLength(207);
      expect(new Set(targets.map(({ target_id }) => target_id)).size).toBe(207);
      expect(
        targets.find(({ target_id }) => target_id === fake.targetId)?.location,
      ).toMatchObject({ kind: "file", file_path: fixture.entry });
      expect(
        targets.find(({ target_id }) => target_id === fake.targetIds[1])
          ?.location,
      ).toMatchObject({ kind: "file", file_path: outside });
      expect(
        targets.find(
          ({ target_id }) =>
            target_id === "00000000-0000-4000-8000-000000000207",
        )?.location,
      ).toMatchObject({ kind: "file", file_path: fixture.entry });
    } finally {
      await fake.close();
    }
  },
);

test("preserves attachment facts and refuses attached or unconnectable Inspector targets", async () => {
  const fake = await startFakeV8Inspector({
    targetUrl: "https://example.test/omitted.js",
    additionalTargets: [
      { url: "https://example.test/malformed.js", attached: "unknown" },
      { url: "https://example.test/detached.js", attached: false },
      { url: "https://example.test/attached.js", attached: true },
      { url: "https://example.test/unconnectable.js", omitDebuggerUrl: true },
    ],
  });
  const [omitted, malformed, detached, attached, unconnectable] =
    fake.targetIds;
  if (
    omitted === undefined ||
    malformed === undefined ||
    detached === undefined ||
    attached === undefined ||
    unconnectable === undefined
  )
    throw new Error("Expected five Inspector targets");
  const malformedNotice = expect.stringContaining(
    `target ${malformed} reported malformed attached metadata "unknown"`,
  );
  const unknownNotice = expect.stringContaining(
    "did not report the target's current debugger attachment state",
  );
  const provider = new V8InspectorProvider();
  try {
    const listed = await provider.listTargets({
      inspector_endpoint: fake.endpoint,
    });
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toHaveLength(4);
    expect(listed.value.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_id: omitted, attached: null }),
        expect.objectContaining({ target_id: malformed, attached: null }),
        expect.objectContaining({ target_id: detached, attached: false }),
        expect.objectContaining({ target_id: attached, attached: true }),
      ]),
    );
    expect(listed.value.excluded).toEqual({
      unconnectable: 1,
      unsupported_location: 0,
    });
    expect(listed.value.limitations).toContainEqual(malformedNotice);
    expect(listed.value.limitations).toContainEqual(unknownNotice);

    const busy = await provider.observe(
      observeInput(fake.endpoint, attached, "node"),
    );
    if (busy.ok) throw new Error("Expected refusal for an attached target");
    expect(projectAnalysisError(busy.error)).toMatchObject({
      code: "target_unavailable",
      message: expect.stringContaining("attached: true"),
      details: { reason: "target_not_allowed" },
      remediation: {
        action: expect.stringContaining("Disconnect the other debugger"),
      },
    });
    const withoutSocket = await provider.observe(
      observeInput(fake.endpoint, unconnectable, "node"),
    );
    expect(withoutSocket).toMatchObject({
      ok: false,
      error: { reason: "invalid_endpoint_response" },
    });
    expect(fake.commands).toEqual([]);

    for (const [target_id, attachment] of [
      [omitted, null],
      [malformed, null],
      [detached, false],
    ] as const) {
      const observed = await provider.observe(
        observeInput(fake.endpoint, target_id, "node"),
      );
      if (!observed.ok) throw observed.error;
      expect(observed.value.target).toMatchObject({
        target_id,
        attached: attachment,
      });
      if (attachment === null)
        expect(observed.value.limitations).toContainEqual(unknownNotice);
      if (target_id === malformed)
        expect(observed.value.limitations).toContainEqual(malformedNotice);
    }
  } finally {
    await provider.close();
    await fake.close();
  }
});

// Node reports the raw pathname: spaces and % stay literal, and quotes or
// backslashes become underscores that cannot identify the original path.
test.skipIf(process.platform === "win32")(
  "resolves discovery paths with spaces and percent signs but not quote spellings",
  async () => {
    const root = await createNodeDiscoveryTempDirectory("rea-v8-spelling-");
    const spaced = join(root, "with space %41.js");
    const quoted = join(root, 'with "quote".js');
    await writeFile(spaced, "export {};\n");
    await writeFile(quoted, "export {};\n");
    expect(nodeDiscoveryTargetUrl(spaced)).toBe(`file://${spaced}`);
    expect(nodeDiscoveryTargetUrl(quoted)).toBe(
      `file://${join(root, "with _quote_.js")}`,
    );
    const fake = await startFakeV8Inspector({
      targetUrl: nodeDiscoveryTargetUrl(spaced),
      additionalTargets: [{ url: nodeDiscoveryTargetUrl(quoted) }],
    });
    try {
      const result = await new V8InspectorProvider().listTargets({
        inspector_endpoint: fake.endpoint,
      });
      if (!result.ok) throw result.error;
      expect(result.value.targets.map(({ location }) => location)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", file_path: spaced }),
          {
            kind: "unresolved",
            reported_url: nodeDiscoveryTargetUrl(quoted),
            reason: "unverifiable-file-location",
          },
        ]),
      );
    } finally {
      await fake.close();
    }
  },
);

test("captures complete metadata with two enable commands", async () => {
  const fixture = await runtimeFixture();
  const outside = await temporaryFile("secret.js");
  const fake = await startFakeV8Inspector({
    targetUrl: pathToFileURL(fixture.entry).href,
    scriptUrls: [
      pathToFileURL(fixture.entry).href,
      "node:fs",
      pathToFileURL(outside).href,
    ],
  });
  try {
    const result = await new V8InspectorProvider().observe(
      observeInput(fake.endpoint, fake.targetId, "node"),
    );
    if (!result.ok) throw result.error;
    expect(result.value.scripts.items).toHaveLength(3);
    expect(result.value.scripts.excluded.unsupported_location).toBe(0);
    expect(result.value.execution_contexts).toEqual([
      {
        context_key: "context_0",
        execution_context_id: 1,
        state: "created",
        name: "node[fixture]",
        origin: "",
      },
    ]);
    expect(new Set(fake.commands.map(({ method }) => method))).toEqual(
      new Set(["Runtime.enable", "Debugger.enable"]),
    );
    expect(result.value.scripts.items).toContainEqual(
      expect.objectContaining({
        location: expect.objectContaining({ file_path: outside }),
      }),
    );
    expect(result.value.unavailable_without_instrumentation).toContain(
      "Electron IPC messages and handlers",
    );
  } finally {
    await fake.close();
  }
});

test.each([
  {
    targetType: "node",
    allowed: ["node", "electron-main"],
    refused: ["electron-preload", "electron-renderer"],
  },
  {
    targetType: "page",
    allowed: ["electron-preload", "electron-renderer"],
    refused: ["node", "electron-main"],
  },
] as const)(
  "admits only compatible declared roles for a $targetType Inspector target",
  async ({ targetType, allowed, refused }) => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      targetType,
    });
    const provider = new V8InspectorProvider();
    try {
      for (const kind of refused) {
        const result = await provider.observe(
          observeInput(fake.endpoint, fake.targetId, kind),
        );
        if (result.ok) throw new Error(`Expected refusal for ${kind}`);
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "target_unavailable",
          message: expect.stringContaining(`runtime_kind ${kind}`),
          details: { reason: "target_not_allowed" },
          remediation: {
            action: expect.stringContaining("Correct runtime_kind"),
          },
        });
      }
      expect(fake.commands).toEqual([]);
      for (const kind of allowed) {
        const result = await provider.observe(
          observeInput(fake.endpoint, fake.targetId, kind),
        );
        if (!result.ok) throw result.error;
        expect(result.value.target).toMatchObject({
          protocol_type: targetType,
          runtime_kind: kind,
          runtime_kind_authority: "caller-declared-unverified",
        });
      }
      if (targetType === "page") {
        const input = observeInput(fake.endpoint, fake.targetId, "node");
        delete input.runtime_kind;
        const result = await provider.observe(input);
        if (!result.ok) throw result.error;
        expect(result.value.target).toMatchObject({
          protocol_type: "page",
          runtime_kind: "unknown",
          runtime_kind_authority: "not-declared",
        });
      }
    } finally {
      await provider.close();
      await fake.close();
    }
  },
);

test("retains 2,005 authorized scripts with complete URL and hash metadata", async () => {
  const shortUrl = "https://example.test/shared.js";
  const longUrl = `https://example.test/${"a".repeat(20_000)}`;
  const prefix = "h".repeat(512);
  const scriptHashes = Array.from({ length: 2_005 }, (_, index) =>
    index < 101 ? `${prefix}${index}` : `hash-${index}`,
  );
  const scriptUrls = scriptHashes.map((_, index) =>
    index === 2_004 ? longUrl : shortUrl,
  );
  const fake = await startFakeV8Inspector({
    targetUrl: longUrl,
    scriptUrls,
    scriptHashes,
  });
  try {
    const result = await new V8InspectorProvider().observe({
      ...observeInput(fake.endpoint, fake.targetId, "node"),
      observation_ms: 1_000,
    });
    if (!result.ok) throw result.error;
    expect(result.value.capture).toMatchObject({
      truncated: false,
      truncation_reasons: [],
      events_dropped: 0,
    });
    expect(result.value.target.location).toMatchObject({
      kind: "url",
      sanitized_url: longUrl,
    });
    const items = result.value.scripts.items;
    expect(items.map(({ cdp_hash }) => cdp_hash).sort()).toEqual(
      [...scriptHashes].sort(),
    );
    expect(
      items.find(({ cdp_hash }) => cdp_hash === "hash-2004")?.location,
    ).toMatchObject({
      kind: "url",
      origin: "https://example.test",
      sanitized_url: longUrl,
    });
  } finally {
    await fake.close();
  }
});

describe("bounded V8 Inspector capture", () => {
  test("bounds aggregate script and context metadata while retaining a useful partial capture", async () => {
    const fixture = await runtimeFixture();
    const url = pathToFileURL(fixture.entry).href;
    const scriptHashes = Array.from(
      { length: 2_300 },
      (_, index) => `${"h".repeat(4_096)}${String(index)}`,
    );
    const fake = await startFakeV8Inspector({
      targetUrl: url,
      scriptUrls: scriptHashes.map(() => url),
      scriptHashes,
      contextTransitionCount: 2_000,
    });
    try {
      const result = await new V8InspectorProvider().observe({
        ...observeInput(fake.endpoint, fake.targetId, "node"),
        observation_ms: 1_000,
      });
      if (!result.ok) throw result.error;
      expect(result.value.capture.truncated).toBe(true);
      expect(result.value.capture.truncation_reasons).toEqual([
        "retained_metadata_budget_exceeded",
      ]);
      expect(result.value.capture.events_dropped).toBeGreaterThan(0);
      expect(result.value.capture.metadata_bytes_retained).toBeLessThanOrEqual(
        8 * 1024 * 1024,
      );
      expect(result.value.capture.events_observed).toBeGreaterThan(
        result.value.capture.events_retained,
      );
      expect(result.value.execution_contexts).toMatchObject([
        { execution_context_id: 1, state: "destroyed" },
      ]);
      const retainedHashes = result.value.scripts.items.map(
        ({ cdp_hash }) => cdp_hash,
      );
      expect(retainedHashes).toContain(scriptHashes[0]);
      expect(retainedHashes).not.toContain(scriptHashes.at(-1));
      expect(result.value.scripts.observed_total).toBe(scriptHashes.length);
    } finally {
      await fake.close();
    }
  });

  test("rejects a CDP event larger than the configured transport payload budget", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      oversizedEventBytes: 16 * 1024 * 1024,
    });
    try {
      const result = await new V8InspectorProvider().observe(
        observeInput(fake.endpoint, fake.targetId, "node"),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        _tag: "BrowserObservationError",
        reason: "payload_limit",
      });
      expect(result.error.userMessage).toContain("protocol budget");
    } finally {
      await fake.close();
    }
  });
});

describe("passive V8 Inspector evidence", () => {
  test("produces deterministic Evidence through the service without grants", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
    });
    try {
      const input = observeInput(fake.endpoint, fake.targetId, "node");
      const first = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        input,
      );
      const second = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        input,
      );
      if (!first.ok) throw first.error;
      if (!second.ok) throw second.error;
      expect(second.value.evidence_id).toBe(first.value.evidence_id);
    } finally {
      await fake.close();
    }
  });

  test("keeps unverified partial script URLs unresolved during reconciliation", () => {
    const rawUrl = "file:///tmp/not-verified.js?caller-value=kept";
    const resolvedObservation = runtimeObservation(
      "/Applications/Example.app/Contents/Resources/app/index.html",
      "/Applications/Example.app/Contents/Resources/app/renderer.js",
    );
    const resolvedScript = resolvedObservation.scripts.items[0];
    if (resolvedScript === undefined)
      throw new Error("Expected the runtime fixture to have one script");
    const observation: JavaScriptRuntimeObservation = {
      ...resolvedObservation,
      scripts: {
        ...resolvedObservation.scripts,
        items: [
          ...resolvedObservation.scripts.items.map((script) => ({
            ...script,
            location: {
              kind: "unresolved" as const,
              reported_url: rawUrl,
              reason: "location-authorization-not-attempted" as const,
            },
          })),
          {
            ...resolvedScript,
            script_key: `v8_script_${"5".repeat(64)}`,
            location: {
              kind: "unresolved",
              reported_url: "",
              reason: "location-authorization-not-attempted",
            },
            cdp_hash: null,
            length: 0,
          },
        ],
      },
    };
    const runtimeEvidence = createJavaScriptRuntimeObservationEvidence(
      "observe_javascript_runtime",
      {
        inspector_endpoint: "http://127.0.0.1:9229",
        target_id: "example-v8-target",
        runtime_kind: "electron-main",
        observation_ms: 100,
      },
      observation,
      V8_INSPECTOR_PROVIDER_IDENTITY,
    );

    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
      runtime_observations: [runtimeEvidence],
    });
    if (!reconciled.ok) throw reconciled.error;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.evidence.normalized_result,
    );
    expect(result.summary.runtime_scripts).toBe(2);
    expect(result.reconciliations).toContainEqual(
      expect.objectContaining({
        entity_kind: "script",
        status: "unknown",
        reason: "runtime-location-unresolved",
      }),
    );
    const runtimeProperties = result.graph.nodes
      .filter(({ kind }) => kind === "runtime-script-instance")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties),
      );
    expect(runtimeProperties).toContainEqual(
      expect.objectContaining({ reported_url: rawUrl, cdp_hash: "v8-hash" }),
    );
    expect(runtimeProperties).toContainEqual(
      expect.objectContaining({ reported_url: "", cdp_hash: null }),
    );
  });
});

test("keeps Inspector parse failures separate and preserves file URL script identity through reconciliation", async () => {
  const fixture = await runtimeFixture();
  const firstUrl = `${pathToFileURL(fixture.entry).href}?instance=1#first`;
  const secondUrl = `${pathToFileURL(fixture.entry).href}?instance=2#second`;
  const fake = await startFakeV8Inspector({
    targetUrl: pathToFileURL(fixture.entry).href,
    scriptEvents: [
      ...[firstUrl, secondUrl].map((url, index) => ({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: String(index + 1),
          url,
          executionContextId: 1,
          hash: "same-source-hash",
          length: 42,
          isModule: true,
        },
      })),
      {
        method: "Debugger.scriptFailedToParse",
        params: { scriptId: "failed", url: firstUrl },
      },
    ],
  });
  try {
    const observed = await new V8InspectorProvider().observe(
      observeInput(fake.endpoint, fake.targetId, "node"),
    );
    if (!observed.ok) throw observed.error;
    expect(observed.value.scripts.items).toHaveLength(2);
    expect(observed.value.scripts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: { kind: "file", file_path: fixture.entry },
          reported_url: firstUrl,
        }),
        expect.objectContaining({
          location: { kind: "file", file_path: fixture.entry },
          reported_url: secondUrl,
        }),
      ]),
    );
    expect(
      new Set(observed.value.scripts.items.map(({ script_key }) => script_key))
        .size,
    ).toBe(2);
    expect(observed.value.scripts).toMatchObject({
      parse_failed_total: 1,
      excluded: {
        unsupported_location: 0,
        invalid_protocol_value: 0,
      },
    });

    const evidence = createJavaScriptRuntimeObservationEvidence(
      "observe_javascript_runtime",
      {
        inspector_endpoint: fake.endpoint,
        target_id: fake.targetId,
        runtime_kind: "node",
        observation_ms: 100,
      },
      observed.value,
      V8_INSPECTOR_PROVIDER_IDENTITY,
    );
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
      runtime_observations: [evidence],
    });
    if (!reconciled.ok) throw reconciled.error;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.evidence.normalized_result,
    );
    const runtimeScripts = result.graph.nodes.filter(
      (node) => node.kind === "runtime-script-instance",
    );
    const reportedUrls = runtimeScripts.flatMap((node) =>
      node.observations
        .map(({ properties }) => properties.reported_url)
        .filter((url): url is string => typeof url === "string"),
    );
    expect(reportedUrls).toEqual(expect.arrayContaining([firstUrl, secondUrl]));
    expect(new Set(reportedUrls).size).toBe(2);
    const scriptKeys = runtimeScripts.flatMap((node) =>
      node.identity.strategy === "runtime-instance"
        ? [node.identity.runtime_key]
        : [],
    );
    expect(new Set(scriptKeys).size).toBe(2);

    const parsedCapture = parseRuntimeCapture(evidence, [
      "runtime_observations",
      0,
    ]);
    if (parsedCapture?.kind !== "v8-inspector")
      throw new Error("Expected the Inspector Evidence to parse as V8 capture");
    expect(
      parsedCapture.inspection.completeness.unavailable_sections,
    ).not.toContain("scripts");

    const withoutCount = {
      ...observed.value,
      scripts: {
        ...observed.value.scripts,
      },
    };
    delete (withoutCount.scripts as { parse_failed_total?: number })
      .parse_failed_total;
    expect(
      javascriptRuntimeObservationSchema.safeParse(withoutCount).error?.issues,
    ).toMatchObject([{ path: ["scripts", "parse_failed_total"] }]);
  } finally {
    await fake.close();
  }
});

test("keeps malformed scriptFailedToParse protocol values in the invalid count", async () => {
  const fixture = await runtimeFixture();
  const fake = await startFakeV8Inspector({
    targetUrl: pathToFileURL(fixture.entry).href,
    scriptEvents: [
      {
        method: "Debugger.scriptFailedToParse",
        params: { url: pathToFileURL(fixture.entry).href },
      },
    ],
  });
  try {
    const observed = await new V8InspectorProvider().observe(
      observeInput(fake.endpoint, fake.targetId, "node"),
    );
    if (!observed.ok) throw observed.error;
    expect(observed.value.scripts.excluded).toMatchObject({
      invalid_protocol_value: 1,
    });
    expect(observed.value.scripts.parse_failed_total).toBe(0);
  } finally {
    await fake.close();
  }
});

const runtimeFixture = async () => {
  const root = await createNodeDiscoveryTempDirectory("rea-v8-runtime-");
  const entry = join(root, "entry.js");
  await writeFile(entry, "export const value = 1;\n");
  return { root, entry };
};

const temporaryFile = async (name: string): Promise<string> => {
  const root = await createNodeDiscoveryTempDirectory("rea-v8-outside-");
  const path = join(root, name);
  await writeFile(path, "export {};\n");
  return path;
};

const observeInput = (
  endpoint: string,
  targetId: string,
  runtimeKind: ObserveJavaScriptRuntimeInput["runtime_kind"],
): ObserveJavaScriptRuntimeInput => ({
  inspector_endpoint: endpoint,
  target_id: targetId,
  runtime_kind: runtimeKind,
  observation_ms: 10,
});

const runtimeObservation = (
  targetPath: string,
  scriptPath: string,
): JavaScriptRuntimeObservation => ({
  runtime: {
    product: "node.js/v24.4.1",
    protocol_version: "1.3",
    v8_version: "13.6",
  },
  target: {
    target_id: "example-v8-target",
    protocol_type: "node",
    attached: false,
    location: { kind: "file", file_path: targetPath },
    runtime_kind: "electron-main",
    runtime_kind_authority: "caller-declared-unverified",
  },
  capture: {
    observation_ms: 100,
    events_observed: 1,
    events_retained: 1,
    events_dropped: 0,
    metadata_bytes_retained: 100,
    truncated: false,
    truncation_reasons: [],
  },
  scripts: {
    items: [
      {
        script_key: `v8_script_${"4".repeat(64)}`,
        location: { kind: "file", file_path: scriptPath },
        execution_context_key: "1",
        execution_context_id: 1,
        cdp_hash: "v8-hash",
        length: 29,
        is_module: true,
        status: "observed-loaded",
      },
    ],
    observed_total: 1,
    parse_failed_total: 0,
    excluded: {
      unsupported_location: 0,
      invalid_protocol_value: 0,
    },
  },
  execution_contexts: [],
  directly_observed: ["Debugger.scriptParsed established script presence."],
  unavailable_without_instrumentation: [
    "require/import caller-to-callee edges",
  ],
  unknowns: ["Capture is bounded."],
  limitations: ["Passive Inspector metadata only."],
});
