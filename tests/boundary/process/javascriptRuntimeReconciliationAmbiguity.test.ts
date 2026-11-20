import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  readRuntimeReconciliationInput,
  reconcileJavaScriptRuntime,
} from "../../../src/domain/javascript/javascriptRuntimeReconciliation.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";

import {
  SOURCE,
  applicationFixture,
  analyzeFixture,
  electronRuntimeEvidence,
} from "../../fixtures/javascriptRuntimeReconciliation.js";

const reconcileInput = (input: unknown) => {
  const result = readRuntimeReconciliationInput(
    reconcileJavaScriptRuntimeInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return reconcileJavaScriptRuntime(result.value);
};

const execute = promisify(execFile);

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it("retains each capture and both runtime instances of a loaded asset", async () => {
  const fixture = await applicationFixture();
  temporary.push(fixture);
  const staticEvidence = await analyzeFixture(fixture);
  const runtimeObservations = [
    electronRuntimeEvidence(fixture, SOURCE, {
      includeWorker: false,
      targetId: "target-one",
    }),
    electronRuntimeEvidence(fixture, SOURCE, {
      includeWorker: false,
      targetId: "target-two",
    }),
  ];

  const result = reconcileInput({
    static_layers: [{ role: "application", analysis: staticEvidence }],
    runtime_observations: runtimeObservations,
  });

  expect(
    result.runtime_captures
      .map(({ evidence_id, target_key }) => [evidence_id, target_key])
      .sort(),
  ).toEqual(
    [
      [runtimeObservations[0]?.evidence_id, "target-one"],
      [runtimeObservations[1]?.evidence_id, "target-two"],
    ].sort(),
  );
  const app = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "app.js"),
  );
  if (app === undefined) throw new Error("Missing fixture application asset");
  const scripts = result.reconciliations.filter(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(scripts).toMatchObject([
    { status: "matched", static_node_id: app.node_id },
    { status: "matched", static_node_id: app.node_id },
  ]);
  expect(scripts[0]?.runtime_node_id).not.toBe(scripts[1]?.runtime_node_id);
  expect(
    result.static_load_states.find(
      ({ static_node_id }) => static_node_id === app.node_id,
    ),
  ).toMatchObject({
    status: "loaded",
    runtime_node_ids: scripts
      .map(({ runtime_node_id }) => runtime_node_id)
      .sort(),
  });
  expect(result.summary).toMatchObject({
    runtime_targets: 2,
    runtime_frames: 2,
    runtime_scripts: 2,
    runtime_workers: 0,
    static_not_observed: 2,
  });
  expect(result.coverage).toMatchObject({
    omitted_runtime_entities: 0,
    omitted_reconciliation_items: 0,
    omitted_static_load_states: 0,
  });
});

it("keeps graph omission counts unknown when a runtime section is unavailable", async () => {
  const fixture = await applicationFixture();
  temporary.push(fixture);
  const result = reconcileInput({
    static_layers: [
      { role: "application", analysis: await analyzeFixture(fixture) },
    ],
    runtime_observations: [
      electronRuntimeEvidence(fixture, SOURCE, {
        includeWorker: false,
        workersUnavailable: true,
      }),
    ],
  });

  expect(result.coverage).toMatchObject({
    status: "partial",
    truncated: false,
  });
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: false,
    omitted_count: null,
  });
});

it("runs the local verifier from operator-provided paths without emitting source", async () => {
  const fixture = await applicationFixture();
  const evidenceRoot = await createTestTempDirectory("rea-runtime-evidence-");
  const evidencePath = join(evidenceRoot, "runtime-evidence.json");
  temporary.push(fixture, evidenceRoot);
  await writeFile(
    evidencePath,
    JSON.stringify(electronRuntimeEvidence(fixture, SOURCE)),
  );

  const { stdout } = await execute(
    process.execPath,
    [
      "scripts/verify/javascript/runtime-observation.mjs",
      "--application",
      fixture,
      "--runtime-evidence",
      evidencePath,
    ],
    { cwd: process.cwd(), maxBuffer: 16 * 1_024 * 1_024 },
  );
  const output: unknown = JSON.parse(stdout);

  expect(output).toMatchObject({
    verified: true,
    summary: { runtime_scripts: 1 },
  });
  expect(stdout).not.toContain(SOURCE.trim());
});
