import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { createJavaScriptRuntimeObservationEvidence } from "../../../src/application/JavaScriptRuntimeObservationEvidence.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../../../src/application/JavaScriptRuntimeObservationService.js";
import { createPermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/JavaScriptRuntimeReconciliationService.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "../../../src/browser/V8InspectorProvider.js";
import { V8InspectorProvider } from "../../../src/browser/V8InspectorProvider.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascriptRuntimeReconciliationExample.js";
import type {
  JavaScriptRuntimeObservation,
  ObserveJavaScriptRuntimeInput,
} from "../../../src/domain/javascriptRuntimeObservation.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascriptRuntimeReconciliationSchemas.js";
import type {
  PermissionCeiling,
  PermissionGrant,
} from "../../../src/domain/permissionPolicy.js";
import { startFakeV8Inspector } from "../../fixtures/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("passive V8 Inspector provider", () => {
  test("filters target locations and never retains the excluded path", async () => {
    const fixture = await runtimeFixture();
    const outside = await temporaryFile("outside.js");
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      additionalTargetUrl: pathToFileURL(outside).href,
    });
    try {
      const result = await new V8InspectorProvider().listTargets({
        inspector_endpoint: fake.endpoint,
        allowed_file_roots: [fixture.root],
        allowed_origins: [],
        approved: true,
        offset: 0,
        limit: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets.total).toBe(1);
      expect(result.value.excluded.outside_file_roots).toBe(1);
      expect(JSON.stringify(result.value)).not.toContain(outside);
    } finally {
      await fake.close();
    }
  });

  test("captures only bounded metadata with two enable commands", async () => {
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
        observeInput(fake.endpoint, fake.targetId, fixture.root, "node"),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.scripts.items).toHaveLength(2);
      expect(result.value.scripts.excluded.outside_file_roots).toBe(1);
      expect(result.value.execution_contexts).toEqual([
        {
          context_key: "1",
          state: "created",
          name: null,
          origin: null,
        },
      ]);
      expect(fake.commands.map(({ method }) => method)).toEqual([
        "Runtime.enable",
        "Debugger.enable",
      ]);
      expect(JSON.stringify(result.value)).not.toContain(outside);
      expect(result.value.unavailable_without_instrumentation).toContain(
        "Electron IPC messages and handlers",
      );
    } finally {
      await fake.close();
    }
  });

  test("excludes an Electron main target that reports only bare file://", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: "file://",
      scriptUrls: [pathToFileURL(fixture.entry).href],
    });
    try {
      const provider = new V8InspectorProvider();
      const listed = await provider.listTargets({
        inspector_endpoint: fake.endpoint,
        allowed_file_roots: [fixture.root],
        allowed_origins: [],
        approved: true,
        offset: 0,
        limit: 100,
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.targets.total).toBe(0);
      expect(listed.value.targets.items).toEqual([]);

      const observed = await provider.observe(
        observeInput(
          fake.endpoint,
          fake.targetId,
          fixture.root,
          "electron-main",
        ),
      );
      expect(observed.ok).toBe(false);
      if (observed.ok) return;
      expect(observed.error.message).toMatch(/outside_file_roots|target/u);
    } finally {
      await fake.close();
    }
  });

  test.each([
    ["node", "node"],
    ["electron-main", "node"],
    ["electron-preload", "page"],
    ["electron-renderer", "page"],
  ] as const)(
    "admits declared %s only on its protocol target family",
    async (runtimeKind, targetType) => {
      const fixture = await runtimeFixture();
      const fake = await startFakeV8Inspector({
        targetUrl: pathToFileURL(fixture.entry).href,
        targetType,
      });
      try {
        const result = await new V8InspectorProvider().observe(
          observeInput(fake.endpoint, fake.targetId, fixture.root, runtimeKind),
        );
        expect(result.ok).toBe(true);
      } finally {
        await fake.close();
      }
    },
  );
});

describe("passive V8 Inspector evidence", () => {
  test("marks capture truncation instead of claiming complete coverage", async () => {
    const fixture = await runtimeFixture();
    const second = join(fixture.root, "second.js");
    await writeFile(second, "export {};\n");
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      scriptUrls: [
        pathToFileURL(fixture.entry).href,
        pathToFileURL(second).href,
      ],
    });
    try {
      const input = observeInput(
        fake.endpoint,
        fake.targetId,
        fixture.root,
        "node",
      );
      const result = await new V8InspectorProvider().observe({
        ...input,
        limits: { ...input.limits, max_scripts: 1 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.capture.truncated).toBe(true);
      expect(result.value.capture.truncation_reasons).toEqual(["max_scripts"]);
      expect(result.value.capture.events_dropped).toBe(1);
    } finally {
      await fake.close();
    }
  });

  test("produces deterministic Evidence through the authorized service", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
    });
    try {
      const input = observeInput(
        fake.endpoint,
        fake.targetId,
        fixture.root,
        "node",
      );
      const authority = await authorityFor(fake.endpoint, fixture.root);
      const first = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        authority,
        input,
      );
      const second = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        authority,
        input,
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.evidence_id).toBe(first.value.evidence_id);

      const listed = await listJavaScriptRuntimeTargets(
        new V8InspectorProvider(),
        authority,
        {
          inspector_endpoint: fake.endpoint,
          allowed_file_roots: [fixture.root],
          allowed_origins: [],
          approved: true,
          offset: 0,
          limit: 100,
        },
      );
      expect(listed.ok).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("reconciles V8 script presence with static Application Graph Evidence", () => {
    const root = "/Applications/Example.app/Contents/Resources/app";
    const observation = runtimeObservation(
      `${root}/index.html`,
      `${root}/renderer.js`,
    );
    const runtimeEvidence = createJavaScriptRuntimeObservationEvidence(
      "observe_javascript_runtime",
      {
        inspector_endpoint: "http://127.0.0.1:9229",
        allowed_file_roots: [root],
        allowed_origins: [],
        target_id: "example-v8-target",
        runtime_kind: "electron-main",
        approved: true,
        observation_ms: 100,
        limits: {
          max_events: 10_000,
          max_scripts: 2_000,
          max_execution_contexts: 1_000,
          max_location_bytes: 16_384,
          max_total_metadata_bytes: 4_194_304,
        },
      },
      observation,
      V8_INSPECTOR_PROVIDER_IDENTITY,
    );
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
      runtime_observations: [runtimeEvidence],
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.normalized_result,
    );
    expect(result.runtime_captures[0]?.kind).toBe("v8-inspector");
    expect(result.summary.runtime_scripts).toBe(1);
    expect(result.summary.matched).toBeGreaterThan(0);
  });
});

const runtimeFixture = async () => {
  const root = await createTestTempDirectory("rea-v8-runtime-");
  const entry = join(root, "entry.js");
  await writeFile(entry, "export const value = 1;\n");
  return { root, entry };
};

const temporaryFile = async (name: string): Promise<string> => {
  const root = await createTestTempDirectory("rea-v8-outside-");
  const path = join(root, name);
  await writeFile(path, "export {};\n");
  return path;
};

const observeInput = (
  endpoint: string,
  targetId: string,
  root: string,
  runtimeKind: ObserveJavaScriptRuntimeInput["runtime_kind"],
): ObserveJavaScriptRuntimeInput => ({
  inspector_endpoint: endpoint,
  allowed_file_roots: [root],
  allowed_origins: [],
  target_id: targetId,
  runtime_kind: runtimeKind,
  approved: true,
  observation_ms: 10,
  limits: {
    max_events: 10_000,
    max_scripts: 2_000,
    max_execution_contexts: 1_000,
    max_location_bytes: 16_384,
    max_total_metadata_bytes: 4_194_304,
  },
});

const authorityFor = async (endpoint: string, root: string) => {
  const scope: PermissionCeiling = {
    capability: "v8_inspector_observe",
    roots: [root],
    executables: [],
    environment_names: [],
    origins: [endpoint],
    network: "loopback",
    mount: false,
  };
  const grant: PermissionGrant = {
    ...scope,
    grant_id: "test:v8-inspector",
    lifetime: "administrator",
    operation_identity: null,
    expires_at: null,
  };
  const authority = await createPermissionAuthority([scope], [grant]);
  if (!authority.ok) throw authority.error;
  return authority.value;
};

const runtimeObservation = (
  targetPath: string,
  scriptPath: string,
): JavaScriptRuntimeObservation => ({
  schema_version: 1,
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
        cdp_hash: "v8-hash",
        length: 29,
        is_module: true,
        status: "observed-loaded",
      },
    ],
    observed_total: 1,
    excluded: {
      outside_file_roots: 0,
      outside_origins: 0,
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
