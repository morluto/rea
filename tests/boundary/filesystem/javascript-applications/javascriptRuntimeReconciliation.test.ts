import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { createElectronActiveEvidence } from "../../../../src/application/javascript/ElectronActiveEvidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import {
  createEvidence,
  evidenceSubjectInput,
} from "../../../../src/domain/evidence.js";
import { mappedRuntimePaths } from "../../../../src/domain/javascript/javascriptRuntimeStaticCandidates.js";
import { projectRuntimeCaptures } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationRuntime.js";
import { parseRuntimeCapture } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationCaptureParsing.js";
import { electronPageInspectionSchema } from "../../../../src/domain/javascript/electronObservation.js";
import {
  readRuntimeReconciliationInput,
  reconcileJavaScriptRuntime,
} from "../../../../src/domain/javascript/javascriptRuntimeReconciliation.js";
import {
  reconcileJavaScriptRuntimeInputSchema,
  javascriptRuntimeReconciliationResultSchema,
} from "../../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { electronActiveObservationInputSchema } from "../../../../src/domain/javascript/electronActiveObservation.js";
import { createElectronActiveObservationFixtureResult } from "../../../../src/domain/javascript/electronActiveObservation.fixture.js";

import {
  SOURCE,
  applicationFixture,
  analyzeFixture,
  electronRuntimeEvidence,
} from "../../../fixtures/javascriptRuntimeReconciliation.js";

const readInput = (input: unknown) => {
  const result = readRuntimeReconciliationInput(
    reconcileJavaScriptRuntimeInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

const reconcileInput = (input: unknown) =>
  reconcileJavaScriptRuntime(readInput(input));

it("attributes inconsistent runtime Evidence parameters to the exact input paths", async () => {
  const root = await applicationFixture();
  const application = await analyzeFixture(root);
  const runtime = electronRuntimeEvidence(root, SOURCE);
  for (const [parameter, value, message] of [
    [
      "include_script_sources",
      false,
      /source.*without source-capture selection/i,
    ],
    ["target_id", " target-main ", /target.*disagrees.*captured result/i],
  ] as const) {
    const invalidRuntime = createEvidence(
      evidenceSubjectInput(runtime.subject),
      runtime.provider,
      {
        predicateType: runtime.predicate_type,
        operation: runtime.operation,
        parameters: { ...runtime.parameters, [parameter]: value },
        result: runtime.normalized_result,
        confidence: runtime.confidence,
        authority: runtime.authority,
      },
    );
    expect(
      reconcileJavaScriptRuntimeEvidence({
        static_layers: [{ role: "application", analysis: application }],
        runtime_observations: [invalidRuntime],
      }),
      parameter,
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "reconcile_javascript_runtime",
        issues: [
          {
            path: ["runtime_observations", 0, "parameters", parameter],
            reason: "invalid_value",
            message: expect.stringMatching(message),
          },
        ],
      },
    });
  }
});

it("reconciles runtime scripts inside dot-prefixed child directories", async () => {
  const root = await applicationFixture();
  await mkdir(join(root, "..cache"));
  await writeFile(join(root, "..cache", "app.js"), SOURCE);
  const result = reconcileInput({
    static_layers: [
      { role: "application", analysis: await analyzeFixture(root) },
    ],
    runtime_observations: [
      electronRuntimeEvidence(root, SOURCE, {
        scriptFile: "..cache/app.js",
        includeWorker: false,
      }),
    ],
  });
  expect(result.reconciliations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_kind: "script",
        status: "matched",
        basis: "content-and-location",
      }),
    ]),
  );
});

it("matches renderer, frame, script bytes, and worker without claiming execution", async () => {
  const fixture = await applicationFixture();
  const staticEvidence = await analyzeFixture(fixture);
  const runtimeEvidence = electronRuntimeEvidence(fixture, SOURCE);

  const result = reconcileInput({
    static_layers: [{ role: "application", analysis: staticEvidence }],
    runtime_observations: [runtimeEvidence],
  });

  expect(javascriptRuntimeReconciliationResultSchema.parse(result)).toEqual(
    result,
  );
  expect(result.source_map_authority).toMatchObject({
    used_for_primary_matching: false,
    static_layer_count: 1,
    runtime_script_declarations: 0,
  });
  expect(result.summary).toMatchObject({
    runtime_targets: 1,
    runtime_frames: 1,
    runtime_scripts: 1,
    runtime_workers: 1,
    matched: 2,
    ambiguous: 2,
    unmatched: 0,
  });
  expect(result.reconciliations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_kind: "script",
        status: "matched",
        basis: "content-and-location",
      }),
      expect.objectContaining({
        entity_kind: "worker",
        status: "matched",
        basis: "artifact-path",
      }),
      expect.objectContaining({
        entity_kind: "target",
        status: "ambiguous",
        reason: "ambiguous-static-candidates",
      }),
    ]),
  );
  const matched = result.reconciliations.find(
    ({ status }) => status === "matched",
  );
  if (matched === undefined)
    throw new TypeError("Expected one matched runtime reconciliation");
  expect(
    javascriptRuntimeReconciliationResultSchema.safeParse({
      ...result,
      reconciliations: [{ ...matched, static_node_id: null }],
    }).error?.issues,
  ).toMatchObject([
    {
      path: ["reconciliations", 0],
      code: "invalid_union",
      errors: expect.arrayContaining([
        [expect.objectContaining({ path: ["static_node_id"] })],
      ]),
    },
  ]);
  expect(result.static_load_states).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "javascript-asset",
        status: "loaded",
      }),
    ]),
  );
  expect(result.limitations.join(" ")).toMatch(
    /not reported as executed|not code reachability/u,
  );
  const exportBindings = javascriptApplicationAnalysisResultSchema
    .parse(staticEvidence.normalized_result)
    .graph.nodes.filter((node) =>
      node.observations.some(
        (observation) =>
          observation.properties.semantic_role === "export-binding",
      ),
    )
    .map((node) => node.node_id);
  expect(exportBindings.length).toBeGreaterThan(0);
  expect(
    result.static_load_states.filter((row) =>
      exportBindings.includes(row.static_node_id),
    ),
  ).toEqual([]);
  expect(
    result.reconciliations.filter(
      (row) =>
        row.static_node_id !== null &&
        exportBindings.includes(row.static_node_id),
    ),
  ).toEqual([]);
  const observedAsEdges = result.graph.edges.filter(
    ({ relation }) => relation === "observed_as",
  );
  expect(observedAsEdges).toHaveLength(2);
  for (const [entityKind, basis] of [
    ["script", "content-and-location"],
    ["worker", "artifact-path"],
  ] as const) {
    const reconciliation = result.reconciliations.find(
      ({ entity_kind }) => entity_kind === entityKind,
    );
    if (reconciliation === undefined || reconciliation.status !== "matched")
      throw new TypeError(`Expected matched ${entityKind} reconciliation`);
    expect(observedAsEdges).toContainEqual(
      expect.objectContaining({
        source_node_id: reconciliation.static_node_id,
        target_node_id: reconciliation.runtime_node_id,
        relation: "observed_as",
        properties: expect.objectContaining({
          reconciliation_id: reconciliation.reconciliation_id,
          static_layer_id: reconciliation.static_layer_id,
          basis,
        }),
        evidence: expect.objectContaining({
          authority: "cross-layer-reconciliation",
          state: "inferred",
        }),
      }),
    );
  }
  const worker = result.reconciliations.find(
    ({ entity_kind: kind }) => kind === "worker",
  );
  const frame = result.reconciliations.find(
    ({ entity_kind: kind }) => kind === "frame",
  );
  expect(result.graph.edges).toContainEqual(
    expect.objectContaining({
      source_node_id: frame?.runtime_node_id,
      target_node_id: worker?.runtime_node_id,
      relation: "contains",
    }),
  );
});

it("retains observed scripts while incomplete capture sections leave absence unknown", async () => {
  const fixture = await applicationFixture();
  const outside = await createTestTempDirectory("rea-outside-runtime-scope-");
  const analysis = await analyzeFixture(fixture);
  const { graph } = javascriptApplicationAnalysisResultSchema.parse(
    analysis.normalized_result,
  );
  const assetId = (path: string) => {
    const asset = graph.nodes.find(
      ({ kind, observations }) =>
        kind === "javascript-asset" &&
        observations.some(({ properties }) => properties.path === path),
    );
    if (asset === undefined) throw new Error(`Missing fixture asset ${path}`);
    return asset.node_id;
  };
  const appId = assetId("app.js");
  const workerId = assetId("worker.js");

  const complete = electronRuntimeEvidence(fixture, SOURCE, {
    includeWorker: false,
    targetId: "complete",
  });
  const outsideComplete = electronRuntimeEvidence(
    outside,
    "export const unrelated = 1;",
    {
      includeWorker: false,
      targetId: "outside-complete",
    },
  );
  const outsideIncomplete = electronRuntimeEvidence(
    outside,
    "export const unrelated = 1;",
    {
      includeWorker: false,
      scriptsUnavailable: true,
      targetId: "outside-incomplete",
    },
  );
  const scopedIncomplete = electronRuntimeEvidence(fixture, SOURCE, {
    includeWorker: false,
    scriptsUnavailable: true,
    targetId: "scoped-incomplete",
  });
  const noWorkers = electronRuntimeEvidence(fixture, SOURCE, {
    includeWorker: false,
    workersUnavailable: true,
    targetId: "workers-unavailable",
  });
  const reconcile = (
    ...runtime_observations: ReturnType<typeof electronRuntimeEvidence>[]
  ) =>
    reconcileInput({
      static_layers: [{ role: "application", analysis }],
      runtime_observations,
    });

  expect(
    reconcile(complete, outsideComplete).static_load_states.find(
      ({ static_node_id }) => static_node_id === workerId,
    ),
  ).toMatchObject({
    status: "not-observed-in-capture",
    reason: "not-observed-in-bounded-capture",
  });
  for (const { captures, scriptScope } of [
    {
      captures: [complete, scopedIncomplete],
      scriptScope: [
        ["complete", true],
        ["scoped-incomplete", false],
      ],
    },
    {
      captures: [complete, outsideIncomplete],
      scriptScope: [
        ["complete", true],
        ["outside-incomplete", false],
      ],
    },
    {
      captures: [outsideIncomplete, complete],
      scriptScope: [
        ["complete", true],
        ["outside-incomplete", false],
      ],
    },
    { captures: [noWorkers], scriptScope: [["workers-unavailable", true]] },
  ]) {
    const result = reconcile(...captures);
    expect(
      result.runtime_captures
        .map(({ target_key, scripts_complete_within_scope }) => [
          target_key,
          scripts_complete_within_scope,
        ])
        .sort(),
    ).toEqual(scriptScope);
    expect(result.summary.static_not_observed).toBe(0);
    const script = result.reconciliations.find(
      ({ entity_kind, status, static_node_id }) =>
        entity_kind === "script" &&
        status === "matched" &&
        static_node_id === appId,
    );
    expect(script).toBeDefined();
    expect(
      result.static_load_states.find(
        ({ static_node_id }) => static_node_id === appId,
      ),
    ).toMatchObject({
      status: "loaded",
      reason: "runtime-script-correspondence",
      runtime_node_ids: expect.arrayContaining([script?.runtime_node_id]),
    });
    expect(
      result.static_load_states.find(
        ({ static_node_id }) => static_node_id === workerId,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "static-or-runtime-coverage-incomplete",
      runtime_node_ids: [],
    });
  }
});

it("preserves unknown Electron frame provenance without linking it to an authorized frame", async () => {
  const root = await applicationFixture();
  const recorded = electronRuntimeEvidence(root, SOURCE);
  const inspection = electronPageInspectionSchema.parse(
    recorded.normalized_result,
  );
  const evidence = createEvidence(
    evidenceSubjectInput(recorded.subject),
    recorded.provider,
    {
      predicateType: recorded.predicate_type,
      operation: recorded.operation,
      parameters: recorded.parameters,
      confidence: recorded.confidence,
      authority: recorded.authority,
      result: {
        ...inspection,
        completeness: {
          ...inspection.completeness,
          status: "attach_limited",
          conditions: ["attach_limited"],
          attach_limited_sections: ["scripts"],
        },
        scripts: {
          ...inspection.scripts,
          items: inspection.scripts.items.map((script) => ({
            ...script,
            frame_scope: "unknown",
            has_source_url: true,
            reported_url: "file:///reported-label.js",
            frame_claims: {
              script_event_frame_id: "declared-frame",
              execution_context_frame_id: "context-frame",
            },
          })),
        },
      },
    },
  );
  const captures = [parseRuntimeCapture(evidence, ["runtime_observations", 0])];
  expect(captures[0]?.scriptsCompleteWithinScope).toBe(false);
  const projected = projectRuntimeCaptures(captures);
  const script = projected.entities.find(({ kind }) => kind === "script");
  const target = projected.entities.find(({ kind }) => kind === "target");
  if (script === undefined || target === undefined)
    throw new Error("Expected the observed script and selected target");
  expect(script.frameKey).toBeNull();
  expect(script.node.observations).toEqual([
    expect.objectContaining({
      properties: expect.objectContaining({
        frame_scope: "unknown",
        reported_frame_id: inspection.scripts.items[0]?.frame_id,
        has_source_url: true,
        reported_url: "file:///reported-label.js",
        frame_claims: {
          script_event_frame_id: "declared-frame",
          execution_context_frame_id: "context-frame",
        },
      }),
    }),
  ]);
  expect(projected.edges).toContainEqual(
    expect.objectContaining({
      source_node_id: target.node.node_id,
      target_node_id: script.node.node_id,
      relation: "loads",
    }),
  );
  const frameIds = new Set(
    projected.entities
      .filter(({ kind }) => kind === "frame")
      .map(({ node }) => node.node_id),
  );
  expect(frameIds.size).toBeGreaterThan(0);
  expect(
    projected.edges.some(
      (edge) =>
        frameIds.has(edge.source_node_id) &&
        edge.target_node_id === script.node.node_id,
    ),
  ).toBe(false);
});

const activeElectronProvider = {
  id: "rea-playwright-electron-active",
  name: "REA Playwright active Electron observation provider",
  version: "1",
};

it("reconciles active Electron targets through admitted paths and rejects inconsistent Evidence", async () => {
  const fixture = await applicationFixture();
  const analysis = await analyzeFixture(fixture);
  const applicationPath = join(fixture, "main.js");
  const alias = join(fixture, "selected-main.js");
  await symlink(applicationPath, alias);
  const executablePath = await realpath(process.execPath);
  const resolved = {
    ...electronActiveObservationInputSchema.parse({
      executable_path: executablePath,
      application_path: applicationPath,
    }),
    application_root: fixture,
  };
  const selected = electronActiveObservationInputSchema.parse({
    executable_path: process.execPath,
    application_path: alias,
  });
  const capture = createElectronActiveObservationFixtureResult(applicationPath);
  capture.application.executable_path = executablePath;
  const canonicalEvidence = createElectronActiveEvidence(
    resolved,
    capture,
    activeElectronProvider,
    resolved,
  );
  const selectedEvidence = createElectronActiveEvidence(
    selected,
    capture,
    activeElectronProvider,
    resolved,
  );
  expect(selectedEvidence.parameters).toMatchObject({
    application_path: alias,
    resolved_paths: {
      executable_path: executablePath,
      application_path: applicationPath,
      application_root: fixture,
    },
  });

  const static_layers = [{ role: "application" as const, analysis }];
  const result = reconcileInput({
    static_layers,
    runtime_observations: [canonicalEvidence, selectedEvidence],
  });
  expect(result.coverage.status).toBe("partial");
  expect(result.runtime_captures).toMatchObject(
    [canonicalEvidence, selectedEvidence]
      .map(({ evidence_id }) => ({
        evidence_id,
        kind: "electron-active",
        target_location: applicationPath,
        scripts: 0,
        frames: 0,
        workers: 0,
        scripts_complete_within_scope: false,
      }))
      .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  );
  expect(result.reconciliations.map(({ entity_kind }) => entity_kind)).toEqual([
    "target",
    "target",
  ]);
  expect(result.runtime_captures[0]?.target_node_id).not.toBe(
    result.runtime_captures[1]?.target_node_id,
  );

  const { resolved_paths: _paths, ...withoutPaths } =
    selectedEvidence.parameters;
  for (const [parameters, field] of [
    [withoutPaths, ["parameters", "resolved_paths"]],
    [
      {
        ...selectedEvidence.parameters,
        resolved_paths: {
          executable_path: executablePath,
          application_path: alias,
          application_root: fixture,
        },
      },
      ["normalized_result", "application", "application_path"],
    ],
  ] as const) {
    const invalid = createEvidence(
      evidenceSubjectInput(selectedEvidence.subject),
      selectedEvidence.provider,
      {
        predicateType: selectedEvidence.predicate_type,
        operation: selectedEvidence.operation,
        parameters,
        result: selectedEvidence.normalized_result,
        confidence: selectedEvidence.confidence,
        authority: selectedEvidence.authority,
      },
    );
    expect(
      reconcileJavaScriptRuntimeEvidence({
        static_layers,
        runtime_observations: [invalid],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["runtime_observations", 0, ...field] }],
      },
    });
  }
});

it("commits complete Electron actions independently from selected arguments", async () => {
  const fixture = await applicationFixture();
  const applicationPath = join(fixture, "main.js");
  const makeInput = (secret: string, selector: string) => ({
    ...electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: applicationPath,
      application_root: fixture,
      args: ["--token", secret],
      actions: [
        { step_id: "click", kind: "click", selector },
        { step_id: "settle", kind: "wait", duration_ms: 37 },
        {
          step_id: "open",
          kind: "deep-link",
          delivery: "second-instance",
          url: "rea-fixture://open/item?token=selected",
        },
      ],
    }),
    application_root: fixture,
  });
  const firstInput = makeInput("first-secret", "#first-secret");
  const secondInput = makeInput("first-secret", "#second-secret");
  const first = createElectronActiveEvidence(
    firstInput,
    createElectronActiveObservationFixtureResult(applicationPath),
    activeElectronProvider,
    firstInput,
  );
  const second = createElectronActiveEvidence(
    secondInput,
    createElectronActiveObservationFixtureResult(applicationPath),
    activeElectronProvider,
    secondInput,
  );

  expect(first.parameters.scenario_sha256).not.toBe(
    second.parameters.scenario_sha256,
  );
  expect(first.parameters.actions).toEqual([
    {
      step_id: "click",
      kind: "click",
      selector: "#first-secret",
      window_index: 0,
    },
    { step_id: "settle", kind: "wait", duration_ms: 37 },
    {
      step_id: "open",
      kind: "deep-link",
      delivery: "second-instance",
      url: "rea-fixture://open/item?token=selected",
    },
  ]);
  expect(first.parameters.args).toEqual(["--token", "first-secret"]);
});

it("uses the operator mapping to select one occurrence of a shared cache asset", async () => {
  const application = await applicationFixture();
  const cache = await createTestTempDirectory("rea-runtime-cache-static-");
  const runtimeCache = await createTestTempDirectory("rea-runtime-cache-live-");
  await mkdir(join(cache, "mapped"));
  await Promise.all([
    writeFile(join(cache, "mapped", "chunk.js"), SOURCE),
    writeFile(join(cache, "outside.js"), "export const outside = true;\n"),
  ]);
  const [applicationEvidence, cacheEvidence] = await Promise.all([
    analyzeFixture(application),
    analyzeFixture(cache),
  ]);
  const runtime = electronRuntimeEvidence(runtimeCache, SOURCE, {
    scriptFile: "chunk.js",
    includeWorker: false,
  });
  const reconcile = (withMapping: boolean) =>
    reconcileInput({
      static_layers: [
        { role: "application", analysis: applicationEvidence },
        {
          role: "cache",
          analysis: cacheEvidence,
          runtime_mappings: withMapping
            ? [
                {
                  kind: "file-root",
                  root: runtimeCache,
                  artifact_prefix: "mapped",
                },
              ]
            : [],
        },
      ],
      runtime_observations: [runtime],
    });
  const mapped = reconcile(true);
  const unmapped = reconcile(false);
  const cacheLayer = mapped.static_layers.find(({ role }) => role === "cache");
  const shared = mapped.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "app.js"),
  );
  expect(
    shared?.observations.map(({ properties }) => properties.path).sort(),
  ).toEqual(["app.js", "mapped/chunk.js"]);
  expect(
    mapped.reconciliations.find(({ entity_kind }) => entity_kind === "script"),
  ).toMatchObject({
    status: "matched",
    basis: "content-and-location",
    static_layer_id: cacheLayer?.layer_id,
    static_node_id: shared?.node_id,
    candidate_static_count: 1,
  });
  const outside = mapped.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "outside.js"),
  );
  expect(
    mapped.static_load_states.find(
      ({ static_node_id }) => static_node_id === outside?.node_id,
    ),
  ).toMatchObject({
    static_layer_id: cacheLayer?.layer_id,
    status: "unknown",
    reason: "layer-outside-runtime-scope",
  });

  const script = unmapped.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(script).toMatchObject({
    status: "ambiguous",
    reason: "ambiguous-static-candidates",
    candidate_static_count: 2,
    static_node_id: null,
  });
  expect(script?.candidate_static_nodes).toEqual(
    unmapped.static_layers.map(({ layer_id }) => ({
      static_layer_id: layer_id,
      static_node_id: shared?.node_id,
    })),
  );
});

const sourceFreeRuntime = (runtimeRoot: string, scriptFile: string) => {
  const runtime = electronRuntimeEvidence(runtimeRoot, "", {
    scriptFile,
    sourceIncluded: false,
    includeWorker: false,
  });
  const observation = electronPageInspectionSchema.parse(
    runtime.normalized_result,
  );
  for (const script of observation.scripts.items)
    script.source = { included: false, reason: "not-requested" };
  return createEvidence(
    evidenceSubjectInput(runtime.subject),
    runtime.provider,
    {
      operation: runtime.operation,
      predicateType: runtime.predicate_type,
      parameters: runtime.parameters,
      result: observation,
      confidence: runtime.confidence,
      authority: runtime.authority,
    },
  );
};

const reconcileScriptLocation = (
  application: Awaited<ReturnType<typeof analyzeFixture>>,
  root: string,
  scriptFile: string,
  runtimeRoot = root,
) => {
  return reconcileInput({
    static_layers: [
      {
        role: "application",
        analysis: application,
        runtime_mappings:
          runtimeRoot === root
            ? []
            : [{ kind: "file-root", root: runtimeRoot, artifact_prefix: "" }],
      },
    ],
    runtime_observations: [sourceFreeRuntime(runtimeRoot, scriptFile)],
  }).reconciliations.find(({ entity_kind }) => entity_kind === "script");
};

it("uses a whole bundle for location-only matches and exact bytes for factory matches", async () => {
  const root = await createTestTempDirectory("rea-runtime-bundler-location-");
  const factory = "(module)=>{module.exports=1;}";
  const source = `(globalThis["webpackChunkfixture"] = globalThis["webpackChunkfixture"] || []).push([["main"],{1:${factory}},(__webpack_require__)=>{__webpack_require__(1);}]);\n`;
  await writeFile(join(root, "runtime.js"), source);
  const application = await analyzeFixture(root);
  const { graph } = javascriptApplicationAnalysisResultSchema.parse(
    application.normalized_result,
  );
  const asset = graph.nodes.find(({ kind }) => kind === "javascript-asset");
  const module = graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-module" &&
      observations.some(({ properties }) => properties.module_key === "1"),
  );
  if (asset === undefined || module === undefined)
    throw new Error("Missing fixture bundle or factory");
  const secondRoot = await createTestTempDirectory(
    "rea-runtime-bundler-other-",
  );
  await writeFile(join(secondRoot, "runtime.js"), source);
  const secondApplication = await analyzeFixture(secondRoot);
  const sourceFree = sourceFreeRuntime(root, "runtime.js");
  const withoutSource = reconcileInput({
    static_layers: [{ role: "application", analysis: application }],
    runtime_observations: [sourceFree],
  });
  const script = withoutSource.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(script).toMatchObject({
    status: "matched",
    basis: "artifact-path",
    confidence: "medium",
    candidate_static_count: 1,
    static_node_id: asset.node_id,
  });
  expect(withoutSource.static_load_states).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        static_node_id: asset.node_id,
        status: "loaded",
        runtime_node_ids: [script?.runtime_node_id],
      }),
      expect.objectContaining({
        static_node_id: module.node_id,
        status: "resident-in-loaded-asset",
        runtime_node_ids: [],
      }),
    ]),
  );

  const captures = [source, factory].map((text, index) =>
    electronRuntimeEvidence(root, text, {
      scriptFile: "runtime.js",
      includeWorker: false,
      targetId: `script-${index}`,
    }),
  );
  const withSource = reconcileInput({
    static_layers: [{ role: "application", analysis: application }],
    runtime_observations: captures,
  });
  for (const [index, nodeId] of [asset.node_id, module.node_id].entries())
    expect(
      withSource.reconciliations.find(
        ({ entity_kind, runtime_evidence_id }) =>
          entity_kind === "script" &&
          runtime_evidence_id === captures[index]?.evidence_id,
      ),
    ).toMatchObject({
      status: "matched",
      basis: "content-and-location",
      static_node_id: nodeId,
      candidate_static_count: 1,
    });

  const acrossLayers = reconcileInput({
    static_layers: [
      { role: "application", analysis: application },
      {
        role: "cache",
        analysis: secondApplication,
        runtime_mappings: [{ kind: "file-root", root, artifact_prefix: "" }],
      },
    ],
    runtime_observations: [sourceFree],
  });
  const ambiguous = acrossLayers.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(ambiguous).toMatchObject({
    status: "ambiguous",
    reason: "ambiguous-static-candidates",
    candidate_static_count: 2,
    static_node_id: null,
  });
  expect(ambiguous?.candidate_static_nodes).toEqual(
    acrossLayers.static_layers.map(({ layer_id }) => ({
      static_layer_id: layer_id,
      static_node_id: asset.node_id,
    })),
  );
});

it.skipIf(process.platform === "win32")(
  "matches POSIX literal paths and Windows separators without conflating slash decoys",
  async () => {
    const root = await createTestTempDirectory("rea-backslash-runtime-pair-");
    const onlyLiteral = "missing\\sibling.js";
    const literal = "literal\\name.js";
    await mkdir(join(root, "literal"));
    await Promise.all([
      writeFile(join(root, onlyLiteral), "export const marker = 'unpaired';\n"),
      writeFile(join(root, literal), "export const marker = 'literal';\n"),
      writeFile(
        join(root, "literal", "name.js"),
        "export const marker = 'slash';\n",
      ),
    ]);
    const application = await analyzeFixture(root);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      application.normalized_result,
    );
    const assetId = (path: string) => {
      const node = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "javascript-asset" &&
          observations.some(({ properties }) => properties.path === path),
      );
      if (node === undefined) throw new Error(`Missing fixture asset ${path}`);
      return node.node_id;
    };
    for (const path of [onlyLiteral, literal, "literal/name.js"])
      expect(reconcileScriptLocation(application, root, path)).toMatchObject({
        status: "matched",
        basis: "artifact-path",
        static_node_id: assetId(path),
      });
    expect(
      reconcileScriptLocation(application, root, "missing/sibling.js"),
    ).toMatchObject({
      status: "unmatched",
    });
    // Recorded Windows paths exercise matching without native Windows IO.
    expect(
      reconcileScriptLocation(application, root, literal, "C:\\runtime"),
    ).toMatchObject({
      status: "matched",
      basis: "operator-file-mapping",
      static_node_id: assetId("literal/name.js"),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "preserves URL-prefix path semantics separately from logical artifact names",
  async () => {
    const root = await createTestTempDirectory("rea-backslash-runtime-url-");
    await writeFile(
      join(root, "literal\\name.js"),
      "export const marker = 42;\n",
    );
    const analysis = await analyzeFixture(root);
    const parsed = readInput(
      reconcileJavaScriptRuntimeInputSchema.parse({
        static_layers: [
          {
            analysis,
            role: "application",
            runtime_mappings: [
              {
                kind: "url-prefix",
                prefix: "https://example.test/assets/",
                artifact_prefix: "",
              },
            ],
          },
        ],
        runtime_observations: [sourceFreeRuntime(root, "literal\\name.js")],
      }),
    );
    const layer = parsed.layers[0];
    const entity = projectRuntimeCaptures(parsed.captures).entities.find(
      ({ kind }) => kind === "script",
    );
    if (layer === undefined || entity === undefined)
      throw new Error("Expected parsed static layer and runtime script");
    const mapped = (value: string) =>
      mappedRuntimePaths(layer, {
        ...entity,
        location: { kind: "url", value },
      }).map(({ path }) => path);
    expect(mapped("https://example.test/assets/literal%5Cname.js")).toEqual([
      "literal\\name.js",
    ]);
    expect(mapped("https://example.test/assets/literal/name.js")).toEqual([
      "literal/name.js",
    ]);
    expect(mapped("https://example.test/assets/literal\\name.js")).toEqual([
      "literal/name.js",
    ]);
    expect(mapped("https://other.test/assets/literal/name.js")).toEqual([]);
    expect(mapped("https://example.test/assets/%2e%2e/outside.js")).toEqual([]);
  },
);

const rendererCapture = (runtimeRoot: string, filePath: string) => {
  const runtime = sourceFreeRuntime(runtimeRoot, "main.cjs");
  const observation = electronPageInspectionSchema.parse(
    runtime.normalized_result,
  );
  observation.target.file_path = filePath;
  for (const frame of observation.frames) frame.file_path = filePath;
  return createEvidence(
    evidenceSubjectInput(runtime.subject),
    runtime.provider,
    {
      operation: runtime.operation,
      predicateType: runtime.predicate_type,
      parameters: runtime.parameters,
      result: observation,
      confidence: runtime.confidence,
      authority: runtime.authority,
    },
  );
};

it.skipIf(process.platform === "win32")(
  "interprets raw loadFile declarations using the captured native path format",
  async () => {
    const root = await createTestTempDirectory(
      "rea-native-loadfile-declaration-",
    );
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "index.html"), "slash file");
    await writeFile(join(root, "dist\\index.html"), "literal file");
    await writeFile(
      join(root, "main.cjs"),
      `const { BrowserWindow } = require('electron'); const win = new BrowserWindow(); win.loadFile(${JSON.stringify("dist\\index.html")});`,
    );
    const analysis = await analyzeFixture(root);
    const reconcileTarget = (runtimeRoot: string, path: string) =>
      reconcileInput({
        static_layers: [
          {
            analysis,
            role: "application",
            runtime_mappings: [
              { kind: "file-root", root: runtimeRoot, artifact_prefix: "" },
            ],
          },
        ],
        runtime_observations: [rendererCapture(runtimeRoot, path)],
      }).reconciliations.find(({ entity_kind }) => entity_kind === "target");
    // These Windows paths are recorded data, not native Windows execution.
    expect(
      reconcileTarget("C:\\runtime", "C:\\runtime\\dist\\index.html"),
    ).toMatchObject({ status: "matched" });
    expect(reconcileTarget(root, join(root, "dist\\index.html"))).toMatchObject(
      { status: "matched" },
    );
    expect(
      reconcileTarget(root, join(root, "dist", "index.html")),
    ).toMatchObject({ status: "unmatched" });
  },
);

it.skipIf(process.platform === "win32")(
  "maps literal and percent-escaped artifact prefixes to different assets",
  async () => {
    const root = await createTestTempDirectory("rea-literal-artifact-prefix-");
    const prefixes = ["literal\\dir", "literal%5Cdir"] as const;
    for (const [index, prefix] of prefixes.entries()) {
      await mkdir(join(root, prefix));
      await writeFile(
        join(root, prefix, "app.js"),
        `export const marker = ${index};\n`,
      );
    }
    const analysis = await analyzeFixture(root);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      analysis.normalized_result,
    );
    for (const prefix of prefixes) {
      const expected = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "javascript-asset" &&
          observations.some(
            ({ properties }) => properties.path === `${prefix}/app.js`,
          ),
      );
      if (expected === undefined)
        throw new Error(`Missing fixture asset ${prefix}/app.js`);
      const result = reconcileInput({
        static_layers: [
          {
            analysis,
            role: "application",
            runtime_mappings: [
              { kind: "file-root", root: "/deployed", artifact_prefix: prefix },
            ],
          },
        ],
        runtime_observations: [sourceFreeRuntime("/deployed", "app.js")],
      });
      expect(
        result.reconciliations.find(
          ({ entity_kind }) => entity_kind === "script",
        ),
      ).toMatchObject({
        status: "matched",
        basis: "operator-file-mapping",
        static_node_id: expected.node_id,
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "uses resolved artifact paths instead of a raw declaration alias",
  async () => {
    const root = await createTestTempDirectory("rea-resolved-loadfile-alias-");
    const directory = "literal\\dir";
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, "index.html"), "owned target");
    await writeFile(join(root, "index.html"), "different target");
    await writeFile(
      join(root, directory, "package.json"),
      JSON.stringify({
        name: "literal-renderer",
        version: "1.0.0",
        renderer: "./index.html",
      }),
    );
    const analysis = await analyzeFixture(root);
    const reconcileTarget = (path: string) =>
      reconcileInput({
        static_layers: [{ analysis, role: "application" }],
        runtime_observations: [rendererCapture(root, path)],
      }).reconciliations.find(({ entity_kind }) => entity_kind === "target");
    expect(reconcileTarget(join(root, directory, "index.html"))).toMatchObject({
      status: "matched",
    });
    expect(reconcileTarget(join(root, "index.html"))).toMatchObject({
      status: "unmatched",
    });
  },
);

it("rejects unsafe logical artifact prefixes without decoding literal names", async () => {
  const root = await createTestTempDirectory("rea-prefix-admission-");
  await writeFile(join(root, "app.js"), "export const marker = 42;\n");
  const analysis = await analyzeFixture(root);
  const admission = (artifact_prefix: string) =>
    reconcileJavaScriptRuntimeInputSchema.safeParse({
      static_layers: [
        {
          analysis,
          role: "application",
          runtime_mappings: [
            { kind: "file-root", root: "/deployed", artifact_prefix },
          ],
        },
      ],
      runtime_observations: [sourceFreeRuntime("/deployed", "app.js")],
    });
  for (const prefix of [
    "\0",
    "/absolute",
    ".",
    "..",
    "a/../b",
    "a//b",
    "a/",
    "./a",
  ])
    expect(admission(prefix).error?.issues, prefix).toMatchObject([
      {
        path: ["static_layers", 0, "runtime_mappings", 0, "artifact_prefix"],
        message: "Artifact prefix must be empty or a safe relative POSIX path",
      },
    ]);
  for (const prefix of ["", "literal\\dir", "literal%5Cdir", "literal%2Fdir"])
    expect(
      admission(prefix).data?.static_layers[0]?.runtime_mappings,
      prefix,
    ).toMatchObject([{ artifact_prefix: prefix }]);
});

it.skipIf(process.platform === "win32")(
  "keeps a leading backslash declaration literal only for POSIX captures",
  async () => {
    const root = await createTestTempDirectory("rea-leading-loadfile-");
    await writeFile(join(root, "\\index.html"), "literal target");
    await writeFile(
      join(root, "main.cjs"),
      `const { BrowserWindow } = require('electron'); const win = new BrowserWindow(); win.loadFile(${JSON.stringify("\\index.html")});`,
    );
    const analysis = await analyzeFixture(root);
    const reconcileTarget = (runtimeRoot: string, path: string) =>
      reconcileInput({
        static_layers: [
          {
            analysis,
            role: "application",
            runtime_mappings: [
              { kind: "file-root", root: runtimeRoot, artifact_prefix: "" },
            ],
          },
        ],
        runtime_observations: [rendererCapture(runtimeRoot, path)],
      }).reconciliations.find(({ entity_kind }) => entity_kind === "target");
    expect(reconcileTarget(root, join(root, "\\index.html"))).toMatchObject({
      status: "matched",
    });
    expect(
      reconcileTarget("C:\\runtime", "C:\\runtime\\index.html"),
    ).toMatchObject({ status: "unmatched" });
  },
);

it("matches owned and raw renderer declarations against their respective application roots", async () => {
  const root = await createTestTempDirectory("rea-renderer-ownership-");
  await Promise.all(
    ["app/dist", "dist", "sub/dist"].map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  );
  const renderer = "const { BrowserWindow } = require('electron');";
  await Promise.all([
    writeFile(
      join(root, "app", "package.json"),
      JSON.stringify({ main: "main.cjs" }),
    ),
    writeFile(
      join(root, "app", "main.cjs"),
      `${renderer}
      new BrowserWindow().loadFile("generated.html");
      new BrowserWindow().loadFile("./generated.html");
      new BrowserWindow().loadFile("materialized.html");
      new BrowserWindow().loadFile("./materialized.html");
      new BrowserWindow().loadFile("dist/owned.html");
    `,
    ),
    writeFile(
      join(root, "sub", "main.cjs"),
      `${renderer}
      new BrowserWindow().loadFile("dist/raw.html");
    `,
    ),
    writeFile(join(root, "app", "materialized.html"), "present declared page"),
    writeFile(join(root, "app", "dist", "owned.html"), "owned target"),
    writeFile(join(root, "dist", "owned.html"), "root decoy"),
    writeFile(join(root, "dist", "raw.html"), "raw application target"),
    writeFile(join(root, "sub", "dist", "raw.html"), "nested decoy"),
  ]);
  const analysis = await analyzeFixture(root);
  const { graph } = javascriptApplicationAnalysisResultSchema.parse(
    analysis.normalized_result,
  );
  const roles = graph.nodes.filter(({ kind }) => kind === "electron-renderer");
  expect(roles).toHaveLength(4);

  const cases = [
    {
      path: "app/generated.html",
      declarations: ["./generated.html", "generated.html"],
    },
    {
      path: "app/materialized.html",
      declarations: ["./materialized.html", "materialized.html"],
    },
    { path: "app/dist/owned.html", declarations: ["dist/owned.html"] },
    { path: "dist/raw.html", declarations: ["dist/raw.html"] },
  ];
  const matched = cases.map(({ path, declarations }) => {
    const role = roles.find(({ observations }) =>
      observations.some(
        ({ properties }) => properties.declared_path === declarations[0],
      ),
    );
    if (role === undefined)
      throw new Error(`Missing fixture renderer for ${path}`);
    expect(
      role.observations
        .map(({ properties }) => properties.declared_path)
        .sort(),
    ).toEqual(declarations);
    return {
      evidence: rendererCapture(root, join(root, path)),
      nodeId: role.node_id,
    };
  });
  const decoys = [
    "generated.html",
    "materialized.html",
    "dist/owned.html",
    "sub/dist/raw.html",
  ].map((path) => rendererCapture(root, join(root, path)));
  const result = reconcileInput({
    static_layers: [{ analysis, role: "application" }],
    runtime_observations: [
      ...matched.map(({ evidence }) => evidence),
      ...decoys,
    ],
  });
  const targets = result.reconciliations.filter(
    ({ entity_kind }) => entity_kind === "target",
  );
  expect(targets).toHaveLength(8);
  for (const { evidence, nodeId } of matched)
    expect(
      targets.find(
        ({ runtime_evidence_id }) =>
          runtime_evidence_id === evidence.evidence_id,
      ),
    ).toMatchObject({
      status: "matched",
      basis: "artifact-path",
      static_node_id: nodeId,
      candidate_static_count: 1,
    });
  for (const evidence of decoys)
    expect(
      targets.find(
        ({ runtime_evidence_id }) =>
          runtime_evidence_id === evidence.evidence_id,
      ),
    ).toMatchObject({
      status: "unmatched",
      static_node_id: null,
      candidate_static_count: 0,
    });
});

it.skipIf(process.platform === "win32")(
  "maps raw renderer declarations through the exact logical artifact prefix",
  async () => {
    const root = await createTestTempDirectory("rea-prefixed-native-renderer-");
    // Separate the Unicode spellings' parents so the fixture also works on
    // filesystems that treat canonically equivalent names as the same entry.
    const prefixes = ["app", "literal\\app", "nfc/café", "nfd/cafe\u0301"];
    for (const prefix of prefixes) {
      await mkdir(join(root, prefix, "dist"), { recursive: true });
      await writeFile(
        join(root, prefix, "dist", "index.html"),
        `target ${prefix}`,
      );
      await writeFile(
        join(root, prefix, "main.cjs"),
        "const { BrowserWindow } = require('electron'); const win = new BrowserWindow(); win.loadFile('dist/index.html');",
      );
    }
    const sources = ["app", "literal\\app", "nfc/café", "nfd/café"];
    const analysis = await analyzeFixture(root);
    const unix = rendererCapture("/deployed", "/deployed/dist/index.html");
    const windows = rendererCapture(
      "C:\\deployed",
      "C:\\deployed\\dist\\index.html",
    );
    const decoy = rendererCapture("/deployed", "/deployed/index.html");
    for (const [index, prefix] of prefixes.entries()) {
      const result = reconcileInput({
        static_layers: [
          {
            analysis,
            role: "application",
            runtime_mappings: [
              { kind: "file-root", root: "/deployed", artifact_prefix: prefix },
              {
                kind: "file-root",
                root: "C:\\deployed",
                artifact_prefix: prefix,
              },
            ],
          },
        ],
        runtime_observations: [unix, windows, decoy],
      });
      const targets = result.reconciliations.filter(
        ({ entity_kind }) => entity_kind === "target",
      );
      expect(targets).toHaveLength(3);
      for (const capture of [unix, windows]) {
        const target = targets.find(
          ({ runtime_evidence_id }) =>
            runtime_evidence_id === capture.evidence_id,
        );
        expect(target, prefix).toMatchObject({
          status: "matched",
          basis: "operator-file-mapping",
          candidate_static_count: 1,
        });
        const matched = result.graph.nodes.find(
          ({ node_id }) => node_id === target?.static_node_id,
        );
        expect(
          matched?.observations.map(({ evidence }) => evidence.location),
          prefix,
        ).toMatchObject([
          {
            available: true,
            value: {
              kind: "source-range",
              source: `${sources[index]}/main.cjs`,
            },
          },
        ]);
      }
      expect(
        targets.find(
          ({ runtime_evidence_id }) =>
            runtime_evidence_id === decoy.evidence_id,
        ),
      ).toMatchObject({ status: "unmatched" });
    }
  },
);

it("confines raw renderer declarations to the operator-selected artifact prefix", async () => {
  const root = await createTestTempDirectory("rea-native-prefix-isolation-");
  for (const app of ["appA", "appB"]) {
    await mkdir(join(root, app, "dist"), { recursive: true });
    await writeFile(join(root, app, "dist", "index.html"), app);
    await writeFile(
      join(root, app, "main.cjs"),
      "const { BrowserWindow } = require('electron'); const win = new BrowserWindow(); win.loadFile('dist/index.html');",
    );
  }
  const analysis = await analyzeFixture(root);
  const result = reconcileInput({
    static_layers: [
      {
        analysis,
        role: "application",
        runtime_mappings: [
          { kind: "file-root", root: "/deployed", artifact_prefix: "appA" },
        ],
      },
    ],
    runtime_observations: [
      rendererCapture("/deployed", "/deployed/dist/index.html"),
    ],
  });
  const target = result.reconciliations.find(
    ({ entity_kind }) => entity_kind === "target",
  );
  expect(target).toMatchObject({
    status: "matched",
    candidate_static_count: 1,
  });
  const node = result.graph.nodes.find(
    ({ node_id }) => node_id === target?.static_node_id,
  );
  expect(
    node?.observations.flatMap(({ evidence }) =>
      evidence.location.available &&
      evidence.location.value.kind === "source-range"
        ? [evidence.location.value.source]
        : [],
    ),
  ).toEqual(["appA/main.cjs"]);
});

it("retains uncertainty for overlapping file mappings with distinct application interpretations", async () => {
  const root = await createTestTempDirectory("rea-overlapping-native-prefix-");
  await mkdir(join(root, "app", "dist"), { recursive: true });
  await writeFile(join(root, "app", "dist", "index.html"), "shared target");
  for (const [path, declaration] of [
    ["app/main.cjs", "dist/index.html"],
    ["app/dist/main.cjs", "index.html"],
  ])
    await writeFile(
      join(root, path!),
      `const { BrowserWindow } = require('electron'); const win = new BrowserWindow(); win.loadFile(${JSON.stringify(declaration)});`,
    );
  const analysis = await analyzeFixture(root);
  const result = reconcileInput({
    static_layers: [
      {
        analysis,
        role: "application",
        runtime_mappings: [
          { kind: "file-root", root: "/deployed", artifact_prefix: "app" },
          {
            kind: "file-root",
            root: "/deployed/dist",
            artifact_prefix: "app/dist",
          },
        ],
      },
    ],
    runtime_observations: [
      rendererCapture("/deployed", "/deployed/dist/index.html"),
    ],
  });
  expect(
    result.reconciliations.find(({ entity_kind }) => entity_kind === "target"),
  ).toMatchObject({
    status: "ambiguous",
    confidence: "unknown",
    candidate_static_count: 2,
  });
});
