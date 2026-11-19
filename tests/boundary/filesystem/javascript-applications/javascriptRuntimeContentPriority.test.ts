import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  readRuntimeReconciliationInput,
  reconcileJavaScriptRuntime,
} from "../../../../src/domain/javascript/javascriptRuntimeReconciliation.js";
import { reconcileRuntimeEntities } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationMatching.js";
import { classifyStaticLoadStates } from "../../../../src/domain/javascript/javascriptRuntimeLoadState.js";
import { projectRuntimeCaptures } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationRuntime.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { collectStaticRuntimeCandidates } from "../../../../src/domain/javascript/javascriptRuntimeStaticCandidates.js";
import {
  SOURCE,
  analyzeFixture,
  applicationFixture,
  electronRuntimeEvidence,
} from "../../../fixtures/javascriptRuntimeReconciliation.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const CAPTURED = "export const observed = 'different';\n";

const readInput = (
  input: Parameters<typeof readRuntimeReconciliationInput>[0],
) => {
  const result = readRuntimeReconciliationInput(input);
  if (!result.ok) throw result.error;
  return result.value;
};

it("retains the mapped disagreement despite equal bytes at other locations", async () => {
  const root = await applicationFixture();
  const live = await createTestTempDirectory("rea-runtime-content-live-");
  const extra = await createTestTempDirectory("rea-runtime-content-extra-");
  await Promise.all([
    writeFile(join(root, "other.js"), CAPTURED),
    writeFile(join(extra, "app.js"), CAPTURED),
  ]);
  const [application, assets] = await Promise.all([
    analyzeFixture(root),
    analyzeFixture(extra),
  ]);
  const captures = [root, live].map((path, index) =>
    electronRuntimeEvidence(path, CAPTURED, {
      includeWorker: false,
      targetId: `mismatch-${index}`,
    }),
  );
  const result = reconcileJavaScriptRuntime(
    readInput(
      reconcileJavaScriptRuntimeInputSchema.parse({
        static_layers: [
          {
            role: "application",
            analysis: application,
            runtime_mappings: [
              { kind: "file-root", root: live, artifact_prefix: "" },
            ],
          },
          { role: "assets", analysis: assets },
        ],
        runtime_observations: captures,
      }),
    ),
  );
  const layer = result.static_layers.find(({ role }) => role === "application");
  const node = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.length === 1 &&
      observations.some(({ properties }) => properties.path === "app.js"),
  );
  if (layer === undefined || node === undefined)
    throw new Error("Missing fixture application asset");
  for (const [index, basis] of [
    "artifact-path",
    "operator-file-mapping",
  ].entries()) {
    const script = result.reconciliations.find(
      ({ entity_kind, runtime_evidence_id }) =>
        entity_kind === "script" &&
        runtime_evidence_id === captures[index]?.evidence_id,
    );
    expect(script).toMatchObject({
      status: "unmatched",
      basis,
      confidence: "high",
      reason: "captured-content-disagrees-with-static-location",
      static_layer_id: null,
      static_node_id: null,
      candidate_static_count: 1,
      candidate_static_nodes: [
        { static_layer_id: layer.layer_id, static_node_id: node.node_id },
      ],
    });
    expect(
      result.graph.edges.some(
        ({ relation, target_node_id }) =>
          relation === "observed_as" &&
          target_node_id === script?.runtime_node_id,
      ),
    ).toBe(false);
  }
});

it("restricts content-and-location ambiguity to mapped candidates", async () => {
  const application = await applicationFixture();
  const cache = await applicationFixture();
  const other = await applicationFixture();
  const live = await createTestTempDirectory("rea-runtime-content-mapped-");
  const analysis = await analyzeFixture(application);
  const mapping = [{ kind: "file-root", root: live, artifact_prefix: "" }];
  const parsed = readInput(
    reconcileJavaScriptRuntimeInputSchema.parse({
      static_layers: [
        { role: "application", analysis, runtime_mappings: mapping },
        {
          role: "cache",
          analysis: await analyzeFixture(cache),
          runtime_mappings: mapping,
        },
        { role: "assets", analysis: await analyzeFixture(other) },
      ],
      runtime_observations: [
        electronRuntimeEvidence(live, SOURCE, { includeWorker: false }),
      ],
    }),
  );
  const result = reconcileJavaScriptRuntime(parsed);
  const script = result.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(script).toMatchObject({
    status: "ambiguous",
    reason: "ambiguous-static-candidates",
    candidate_static_count: 2,
  });
  const app = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "app.js"),
  );
  if (app === undefined)
    throw new Error("Missing fixture shared application asset");
  expect(script?.candidate_static_nodes).toEqual(
    result.static_layers
      .filter(({ role }) => role === "application" || role === "cache")
      .map(({ layer_id }) => ({
        static_layer_id: layer_id,
        static_node_id: app.node_id,
      })),
  );
});

it("matches exact bytes when either a mapped or unmapped location has no candidate", async () => {
  const root = await applicationFixture();
  await writeFile(join(root, "other.js"), CAPTURED);
  const mapped = await createTestTempDirectory(
    "rea-runtime-content-unlocated-",
  );
  const unmapped = await createTestTempDirectory(
    "rea-runtime-content-unmapped-",
  );
  const analysis = await analyzeFixture(root);
  const captures = [mapped, unmapped].map((path, index) =>
    electronRuntimeEvidence(path, CAPTURED, {
      scriptFile: "absent.js",
      includeWorker: false,
      targetId: `digest-only-${index}`,
    }),
  );
  const result = reconcileJavaScriptRuntime(
    readInput(
      reconcileJavaScriptRuntimeInputSchema.parse({
        static_layers: [
          {
            role: "application",
            analysis,
            runtime_mappings: [
              { kind: "file-root", root: mapped, artifact_prefix: "" },
            ],
          },
        ],
        runtime_observations: captures,
      }),
    ),
  );
  const expected = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "other.js"),
  );
  if (expected === undefined) throw new Error("Missing fixture digest match");
  const scripts = result.reconciliations.filter(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(scripts).toHaveLength(2);
  for (const { evidence_id } of captures)
    expect(
      scripts.find(
        ({ runtime_evidence_id }) => runtime_evidence_id === evidence_id,
      ),
    ).toMatchObject({
      status: "matched",
      basis: "content-sha256",
      confidence: "high",
      reason: "unique-content-match",
      candidate_static_count: 1,
      static_node_id: expected.node_id,
    });
});

it("keeps unavailable mapped digests unknown instead of borrowing unrelated matches", async () => {
  const root = await applicationFixture();
  await writeFile(join(root, "other.js"), CAPTURED);
  const live = await createTestTempDirectory("rea-runtime-content-unknown-");
  const parsed = readInput(
    reconcileJavaScriptRuntimeInputSchema.parse({
      static_layers: [
        {
          role: "application",
          analysis: await analyzeFixture(root),
          runtime_mappings: [
            { kind: "file-root", root: live, artifact_prefix: "" },
          ],
        },
      ],
      runtime_observations: [
        electronRuntimeEvidence(live, CAPTURED, { includeWorker: false }),
      ],
    }),
  );
  const candidates = collectStaticRuntimeCandidates(parsed.layers).map(
    (candidate) =>
      candidate.paths.includes("app.js") && candidate.category === "javascript"
        ? { ...candidate, digests: [] }
        : candidate,
  );
  // Model the matcher's supported missing-digest boundary; do not falsify Evidence.
  const runtime = projectRuntimeCaptures(parsed.captures);
  const result = reconcileRuntimeEntities({
    entities: runtime.entities,
    candidates,
    layers: parsed.layers,
  });
  expect(
    result.items.find(({ entity_kind }) => entity_kind === "script"),
  ).toMatchObject({
    status: "unknown",
    basis: "operator-file-mapping",
    confidence: "unknown",
    reason: "static-or-runtime-coverage-incomplete",
    candidate_static_count: 1,
  });
  const script = result.items.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  const candidate = script?.candidate_static_nodes[0];
  const states = classifyStaticLoadStates(
    parsed.layers,
    parsed.captures,
    runtime.entities,
    result.items,
    {
      reconciliationComplete: true,
    },
  );
  expect(
    states.states.find(
      (state) =>
        state.static_layer_id === candidate?.static_layer_id &&
        state.static_node_id === candidate?.static_node_id,
    ),
  ).toMatchObject({
    status: "unknown",
    reason: "static-or-runtime-coverage-incomplete",
  });
});

const UNRELATED = "export const unrelated = 17;\n";

it("reports absence only where a layer authorizes the capture location", async () => {
  const [application, cache, mappedApplication, mappedCache, unmapped] =
    await Promise.all([
      applicationFixture(),
      applicationFixture(),
      createTestTempDirectory("rea-runtime-application-mapped-"),
      createTestTempDirectory("rea-runtime-cache-mapped-"),
      createTestTempDirectory("rea-runtime-unmapped-"),
    ]);
  const [applicationEvidence, cacheEvidence] = await Promise.all([
    analyzeFixture(application),
    analyzeFixture(cache),
  ]);
  const captures = [application, mappedApplication, mappedCache, unmapped].map(
    (path, index) =>
      electronRuntimeEvidence(path, UNRELATED, {
        scriptFile: "absent.js",
        includeWorker: index === 3,
        targetId: `no-match-${index}`,
      }),
  );
  const result = reconcileJavaScriptRuntime(
    readInput(
      reconcileJavaScriptRuntimeInputSchema.parse({
        static_layers: [
          {
            role: "application",
            analysis: applicationEvidence,
            runtime_mappings: [
              {
                kind: "file-root",
                root: mappedApplication,
                artifact_prefix: "",
              },
            ],
          },
          {
            role: "cache",
            analysis: cacheEvidence,
            runtime_mappings: [
              { kind: "file-root", root: mappedCache, artifact_prefix: "" },
            ],
          },
        ],
        runtime_observations: captures,
      }),
    ),
  );
  const unmatched = {
    status: "unmatched",
    basis: "none",
    confidence: "high",
    reason: "no-static-content-match",
    static_layer_id: null,
    static_node_id: null,
    candidate_static_count: 0,
  };
  const unknown = {
    ...unmatched,
    status: "unknown",
    confidence: "unknown",
    reason: "no-authorized-location-mapping",
  };
  const code = result.reconciliations.filter(
    ({ entity_kind }) => entity_kind === "script" || entity_kind === "worker",
  );
  expect(code).toHaveLength(5);
  for (const [index, { evidence_id }] of captures.entries()) {
    const rows = code.filter(
      ({ runtime_evidence_id }) => runtime_evidence_id === evidence_id,
    );
    expect(
      rows.find(({ entity_kind }) => entity_kind === "script"),
    ).toMatchObject(index < 3 ? unmatched : unknown);
    if (index === 3)
      expect(
        rows.find(({ entity_kind }) => entity_kind === "worker"),
      ).toMatchObject(unknown);
  }
  const runtimeIds = new Set(
    code.map(({ runtime_node_id }) => runtime_node_id),
  );
  expect(
    result.graph.edges.some(
      ({ relation, target_node_id }) =>
        relation === "observed_as" && runtimeIds.has(target_node_id),
    ),
  ).toBe(false);
});

it("applies URL-prefix presence to captured scripts independently of origin lookalikes", async () => {
  const root = await applicationFixture();
  const parsed = readInput(
    reconcileJavaScriptRuntimeInputSchema.parse({
      static_layers: [
        {
          role: "application",
          analysis: await analyzeFixture(root),
          runtime_mappings: [
            {
              kind: "url-prefix",
              prefix: "https://example.test/assets/",
              artifact_prefix: "",
            },
          ],
        },
      ],
      runtime_observations: [
        electronRuntimeEvidence(root, UNRELATED, { includeWorker: false }),
      ],
    }),
  );
  const { entities } = projectRuntimeCaptures(parsed.captures);
  const candidates = collectStaticRuntimeCandidates(parsed.layers);
  // Browser and Inspector projections supply URLs to this same matcher.
  for (const [url, status, confidence, reason] of [
    [
      "https://example.test/assets/absent.js",
      "unmatched",
      "high",
      "no-static-content-match",
    ],
    [
      "https://other.test/assets/absent.js",
      "unknown",
      "unknown",
      "no-authorized-location-mapping",
    ],
  ] as const) {
    const result = reconcileRuntimeEntities({
      entities: entities.map((entity) =>
        entity.kind === "script"
          ? { ...entity, location: { kind: "url", value: url } }
          : entity,
      ),
      candidates,
      layers: parsed.layers,
    });
    expect(
      result.items.find(({ entity_kind }) => entity_kind === "script"),
      url,
    ).toMatchObject({ status, confidence, reason, candidate_static_count: 0 });
  }
});
