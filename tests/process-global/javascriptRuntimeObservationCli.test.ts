import { createCommandCli } from "../support/cli/commandCli.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import type { JavaScriptRuntimeObservationPort } from "../../src/ports/javascript/JavaScriptRuntimeObservationPort.js";
import { parseEvidence, type Evidence } from "../../src/domain/evidence.js";
import type { JavaScriptRuntimeTargetLocation } from "../../src/domain/javascript/javascriptRuntimeObservation.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { startFakeV8Inspector } from "../fixtures/inspector/fakeV8Inspector.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { registerJavaScriptRuntimeObservationCommands } from "../../src/cli/javascriptRuntimeCommands.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { ok } from "../../src/domain/result.js";
import { silentLogger } from "../../src/logger.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { completeApplicationAnalysis } from "../support/completeDetail.js";

const runtimeFactory = vi.hoisted(() => ({
  provider: undefined as JavaScriptRuntimeObservationPort | undefined,
}));

vi.mock("../../src/composition/javascriptRuntimeObservation.js", () => ({
  createJavaScriptRuntimeObservationProvider: () => {
    if (runtimeFactory.provider === undefined)
      throw new Error("No runtime observation provider was configured");
    return runtimeFactory.provider;
  },
}));

const resources: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  runtimeFactory.provider = undefined;
  await Promise.all(resources.splice(0).map((item) => item.close()));
});

cliTest(
  "reconciles verified script Evidence from an unresolved Inspector target through the CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-cli-");
    const entry = join(root, "entry.js");
    await writeFile(entry, "export const value = 1;\n");
    const reportedUrl = "file://C:_tools_entry.js";
    const targetLocation = {
      kind: "unresolved",
      reported_url: reportedUrl,
      reason: "unverifiable-file-location",
    } as const;
    const inspector = await startFakeV8Inspector({
      targetUrl: reportedUrl,
      scriptUrls: [pathToFileURL(entry).href],
    });
    resources.push(inspector);

    const listed = await cli.run({
      arguments: [
        "list-javascript-runtime-targets",
        inspector.endpoint,
        "--json",
      ],
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.json).toMatchObject({
      operation: "list_javascript_runtime_targets",
      provider: { id: "rea-v8-inspector" },
      normalized_result: {
        targets: [{ target_id: inspector.targetId, location: targetLocation }],
      },
    });

    const observed = await cli.run({
      arguments: [
        "observe-javascript-runtime",
        inspector.endpoint,
        inspector.targetId,
        "--runtime-kind",
        "node",
        "--observation-ms",
        "10",
        "--json",
      ],
    });
    expect(observed.exitCode, observed.stderr).toBe(0);
    const observation = parseEvidence(observed.json);
    expect(observation).toMatchObject({
      operation: "observe_javascript_runtime",
      provider: { id: "rea-v8-inspector" },
      parameters: {
        inspector_endpoint: inspector.endpoint,
        target_id: inspector.targetId,
        runtime_kind: "node",
        observation_ms: 10,
      },
      normalized_result: {
        target: {
          target_id: inspector.targetId,
          runtime_kind: "node",
          location: targetLocation,
        },
        scripts: {
          items: [
            expect.objectContaining({
              location: { kind: "file", file_path: entry },
            }),
          ],
        },
      },
    });
    const analyzed = await cli.run({
      arguments: completeApplicationAnalysis(root),
    });
    expect(analyzed.exitCode, analyzed.stderr).toBe(0);
    const analysis = parseEvidence(analyzed.json);
    const inputPath = join(root, "reconciliation.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        static_layers: [{ role: "application", analysis }],
        runtime_observations: [observation],
      }),
    );

    const reconciled = await cli.run({
      arguments: ["reconcile-javascript-runtime", inputPath, "--json"],
    });
    expect(reconciled.exitCode, reconciled.stderr).toBe(0);
    const reconciliation = parseEvidence(reconciled.json);
    assertUnresolvedTargetReconciliation(
      reconciliation,
      analysis,
      observation,
      targetLocation,
    );
  },
);

cliTest(
  "exits after Inspector disconnect and publishes the partial capture",
  async ({ cli }) => {
    const reportedUrl = "file:///inspector-fixture.js";
    const inspector = await startFakeV8Inspector({
      targetUrl: "https://example.test/fixture",
      scriptUrls: [reportedUrl],
      scriptHashes: ["before-disconnect"],
      disconnectAfterDebuggerEnable: true,
    });
    resources.push(inspector);

    // A leaked capture timer would keep a fresh process alive past the test deadline.
    const result = await cli.run({
      freshProcess: true,
      arguments: [
        "observe-javascript-runtime",
        inspector.endpoint,
        inspector.targetId,
        "--observation-ms",
        "3600000",
        "--json",
      ],
    });
    expect(result.signal).toBeNull();
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "provider_unavailable",
      details: {
        reason: "disconnected",
        partial_observation: {
          operation: "observe_javascript_runtime",
          normalized_result: {
            target: { target_id: inspector.targetId },
            capture: { events_observed: 2 },
            scripts: {
              observed_total: 1,
              items: [
                {
                  cdp_hash: "before-disconnect",
                  execution_context_id: 1,
                  length: 100,
                  location: {
                    kind: "unresolved",
                    reported_url: reportedUrl,
                    reason: "location-authorization-not-attempted",
                  },
                },
              ],
            },
            execution_contexts: [
              {
                execution_context_id: 1,
                name: "node[fixture]",
                state: "created",
              },
            ],
          },
        },
      },
    });
  },
);

test("waits for provider cleanup and retains completed Evidence on failure", async () => {
  let closeAttempts = 0;
  runtimeFactory.provider = {
    identity: () => ({
      id: "rea-v8-inspector",
      name: "V8 Inspector",
      version: "1",
    }),
    listTargets: async () =>
      ok({
        runtime: {
          product: "node.js/v24",
          protocol_version: "1.3",
          v8_version: "13.0",
        },
        targets: [],
        excluded: { unsupported_location: 0, unconnectable: 0 },
        limitations: [],
      }),
    observe: async () => {
      throw new Error("No runtime observation requested");
    },
    close: async () => {
      closeAttempts += 1;
      throw new ProviderCleanupError(
        "rea-v8-inspector",
        ["browser_transport"],
        { reason: "Inspector transport remains retained" },
        { operation: "list_javascript_runtime_targets" },
      );
    },
  };
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const cli = createCommandCli();
    registerJavaScriptRuntimeObservationCommands(cli, silentLogger, {});
    let stdout = "";
    await cli.serve(
      ["list-javascript-runtime-targets", "http://127.0.0.1:9229", "--json"],
      { exit: () => {}, stdout: (chunk) => (stdout += chunk) },
    );

    expect(closeAttempts, stdout).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        operation: "list_javascript_runtime_targets",
        partial_observation: {
          operation: "list_javascript_runtime_targets",
          normalized_result: {
            runtime: { product: "node.js/v24" },
            targets: [],
          },
        },
      },
    });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

function assertUnresolvedTargetReconciliation(
  reconciliation: Evidence,
  analysis: Evidence,
  observation: Evidence,
  targetLocation: Extract<
    JavaScriptRuntimeTargetLocation,
    { kind: "unresolved" }
  >,
): void {
  expect(reconciliation.operation).toBe("reconcile_javascript_runtime");
  const result = javascriptRuntimeReconciliationResultSchema.parse(
    reconciliation.normalized_result,
  );
  const [capture] = result.runtime_captures;
  const asset = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "entry.js"),
  );
  if (capture === undefined || asset === undefined)
    throw new Error("Missing runtime capture or static entry asset");
  expect(capture).toMatchObject({
    evidence_id: observation.evidence_id,
    target_location: targetLocation,
  });
  expect(result.reconciliations).toHaveLength(2);
  expect(result.reconciliations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_kind: "target",
        runtime_node_id: capture.target_node_id,
        status: "unknown",
        basis: "none",
        confidence: "unknown",
        reason: "runtime-location-unresolved",
        candidate_static_count: 0,
      }),
      expect.objectContaining({
        entity_kind: "script",
        runtime_evidence_id: observation.evidence_id,
        status: "matched",
        basis: "artifact-path",
        static_node_id: asset.node_id,
      }),
    ]),
  );
  const script = result.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  const target = result.graph.nodes.find(
    ({ node_id }) => node_id === capture.target_node_id,
  );
  expect(target?.observations[0]?.properties).toMatchObject({
    reported_url: targetLocation.reported_url,
    location_kind: "unresolved",
  });
  expect(target?.observations[0]?.properties).not.toHaveProperty("location");
  expect(
    result.graph.edges.filter(({ relation }) => relation === "observed_as"),
  ).toMatchObject([
    {
      source_node_id: asset.node_id,
      target_node_id: script?.runtime_node_id,
      evidence: {
        state: "inferred",
        evidence_ids: [analysis.evidence_id, observation.evidence_id].sort(),
      },
    },
  ]);
}
