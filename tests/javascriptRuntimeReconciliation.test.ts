import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createElectronEvidence } from "../src/application/ElectronEvidence.js";
import { analyzeJavaScriptApplication } from "../src/application/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntime } from "../src/domain/javascriptRuntimeReconciliation.js";
import { javascriptRuntimeReconciliationResultSchema } from "../src/domain/javascriptRuntimeReconciliationSchemas.js";
import { createWebTextArtifact } from "../src/domain/webContentArtifact.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

const SOURCE = `const worker = new Worker("./worker.js");\nexport const observed = worker;\n`;
const execute = promisify(execFile);

describe("JavaScript static/passive-runtime reconciliation", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("matches renderer, frame, script bytes, and worker without claiming execution", async () => {
    const fixture = await applicationFixture();
    temporary.push(fixture);
    const staticEvidence = await analyzeFixture(fixture);
    const runtimeEvidence = electronRuntimeEvidence(fixture, SOURCE);

    const result = reconcileJavaScriptRuntime({
      static_layers: [{ role: "application", analysis: staticEvidence }],
      runtime_observations: [runtimeEvidence],
    });

    expect(() =>
      javascriptRuntimeReconciliationResultSchema.parse(result),
    ).not.toThrow();
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
    expect(
      result.graph.edges
        .filter(({ relation }) => relation === "observed_as")
        .every(
          ({ evidence }) =>
            evidence.authority === "cross-layer-reconciliation" &&
            evidence.state === "inferred",
        ),
    ).toBe(true);
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

  it("reports a captured digest disagreement instead of accepting a path match", async () => {
    const fixture = await applicationFixture();
    temporary.push(fixture);
    const staticEvidence = await analyzeFixture(fixture);
    const runtimeEvidence = electronRuntimeEvidence(
      fixture,
      "export const observed = 'different';\n",
    );

    const result = reconcileJavaScriptRuntime({
      static_layers: [{ role: "application", analysis: staticEvidence }],
      runtime_observations: [runtimeEvidence],
    });
    const script = result.reconciliations.find(
      ({ entity_kind: kind }) => kind === "script",
    );

    expect(script).toMatchObject({
      status: "unmatched",
      reason: "captured-content-disagrees-with-static-location",
    });
    expect(script?.candidate_static_nodes).toHaveLength(1);
  });

  it("keeps source-map declarations outside primary matching authority", async () => {
    const fixture = await applicationFixture();
    temporary.push(fixture);
    const staticEvidence = await analyzeFixture(fixture);
    const runtimeEvidence = electronRuntimeEvidence(fixture, SOURCE);
    const result = reconcileJavaScriptRuntime({
      static_layers: [{ role: "application", analysis: staticEvidence }],
      runtime_observations: [runtimeEvidence],
    });

    expect(result.source_map_authority).toMatchObject({
      used_for_primary_matching: false,
      static_layers_with_read_approval: 0,
      runtime_script_declarations: 0,
    });
  });

  it("imports an operator-provided cache layer through an explicit file mapping", async () => {
    const application = await applicationFixture();
    const cache = await mkdtemp(join(tmpdir(), "rea-runtime-cache-static-"));
    const runtimeCache = await mkdtemp(
      join(tmpdir(), "rea-runtime-cache-live-"),
    );
    temporary.push(application, cache, runtimeCache);
    const cacheSource = "export const cachedFeature = 'fixture';\n";
    await mkdir(join(cache, "mapped"));
    await Promise.all([
      writeFile(join(cache, "mapped", "chunk.js"), cacheSource),
      writeFile(join(cache, "outside.js"), "export const outside = true;\n"),
      writeFile(join(runtimeCache, "chunk.js"), cacheSource),
      writeFile(join(runtimeCache, "index.html"), "<script></script>"),
    ]);
    const applicationEvidence = await analyzeFixture(application);
    const cacheEvidence = await analyzeFixture(cache);
    const runtimeEvidence = electronRuntimeEvidence(runtimeCache, cacheSource, {
      scriptFile: "chunk.js",
      includeWorker: false,
    });

    const result = reconcileJavaScriptRuntime({
      static_layers: [
        { role: "application", analysis: applicationEvidence },
        {
          role: "cache",
          analysis: cacheEvidence,
          runtime_mappings: [
            {
              kind: "file-root",
              root: runtimeCache,
              artifact_prefix: "mapped",
            },
          ],
        },
      ],
      runtime_observations: [runtimeEvidence],
    });
    const script = result.reconciliations.find(
      ({ entity_kind: kind }) => kind === "script",
    );
    const cacheLayer = result.static_layers.find(
      ({ role }) => role === "cache",
    );

    expect(script).toMatchObject({
      status: "matched",
      basis: "content-and-location",
      static_layer_id: cacheLayer?.layer_id,
    });
    const outside = result.graph.nodes.find(
      (node) =>
        node.kind === "javascript-asset" &&
        node.observations.some(
          ({ properties }) => properties.path === "outside.js",
        ),
    );
    expect(
      result.static_load_states.find(
        ({ static_node_id: nodeId }) => nodeId === outside?.node_id,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "layer-outside-runtime-scope",
    });
  });

  it("keeps byte-identical cross-layer candidates explicitly ambiguous", async () => {
    const application = await applicationFixture();
    const assets = await mkdtemp(join(tmpdir(), "rea-runtime-assets-static-"));
    const runtime = await mkdtemp(join(tmpdir(), "rea-runtime-assets-live-"));
    temporary.push(application, assets, runtime);
    await Promise.all([
      writeFile(join(assets, "app.js"), SOURCE),
      writeFile(join(runtime, "app.js"), SOURCE),
      writeFile(join(runtime, "index.html"), "<script></script>"),
    ]);
    const result = reconcileJavaScriptRuntime({
      static_layers: [
        {
          role: "application",
          analysis: await analyzeFixture(application),
        },
        { role: "assets", analysis: await analyzeFixture(assets) },
      ],
      runtime_observations: [
        electronRuntimeEvidence(runtime, SOURCE, { includeWorker: false }),
      ],
    });
    const script = result.reconciliations.find(
      ({ entity_kind: kind }) => kind === "script",
    );

    expect(script).toMatchObject({
      status: "ambiguous",
      reason: "ambiguous-static-candidates",
      candidate_static_count: 2,
    });
    expect(script?.candidate_static_nodes).toHaveLength(2);
    expect(
      new Set(
        script?.candidate_static_nodes.map(
          ({ static_layer_id: layerId }) => layerId,
        ),
      ).size,
    ).toBe(2);
  });

  it("retains one target per capture and keeps load-state absence unknown when output is bounded", async () => {
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

    const result = reconcileJavaScriptRuntime({
      static_layers: [{ role: "application", analysis: staticEvidence }],
      runtime_observations: runtimeObservations,
      limits: {
        max_runtime_entities: 2,
        max_reconciliation_items: 2,
        max_static_load_states: 20_000,
      },
    });

    expect(result.runtime_captures).toHaveLength(2);
    expect(
      new Set(result.runtime_captures.map(({ target_node_id: id }) => id)).size,
    ).toBe(2);
    expect(result.summary).toMatchObject({
      runtime_targets: 2,
      runtime_frames: 0,
      runtime_scripts: 0,
      runtime_workers: 0,
      static_not_observed: 0,
    });
    expect(result.coverage).toMatchObject({
      status: "truncated",
      truncated: true,
      omitted_runtime_entities: 4,
    });
    expect(
      result.static_load_states.every(({ status }) => status === "unknown"),
    ).toBe(true);
  });

  it("rejects runtime source bytes whose Evidence omits source-capture approval", async () => {
    const fixture = await applicationFixture();
    temporary.push(fixture);
    const staticEvidence = await analyzeFixture(fixture);
    const contradictoryRuntime = electronRuntimeEvidence(fixture, SOURCE, {
      includeWorker: false,
      sourceCaptureApproved: false,
    });

    expect(() =>
      reconcileJavaScriptRuntime({
        static_layers: [{ role: "application", analysis: staticEvidence }],
        runtime_observations: [contradictoryRuntime],
      }),
    ).toThrow(/source-capture approval/u);
  });

  it("keeps graph omission counts unknown when a runtime section is unavailable", async () => {
    const fixture = await applicationFixture();
    temporary.push(fixture);
    const result = reconcileJavaScriptRuntime({
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
    const evidenceRoot = await mkdtemp(join(tmpdir(), "rea-runtime-evidence-"));
    const evidencePath = join(evidenceRoot, "runtime-evidence.json");
    temporary.push(fixture, evidenceRoot);
    await writeFile(
      evidencePath,
      JSON.stringify(electronRuntimeEvidence(fixture, SOURCE)),
    );

    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/verify-local-javascript-runtime.mjs",
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
});

const applicationFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-runtime-reconciliation-"));
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "rea-runtime-reconciliation-fixture",
        version: "1.0.0",
        renderer: "index.html",
      }),
    ),
    writeFile(join(root, "index.html"), "<script src='./app.js'></script>"),
    writeFile(join(root, "app.js"), SOURCE),
    writeFile(join(root, "worker.js"), "self.onmessage = () => undefined;\n"),
  ]);
  return root;
};

const analyzeFixture = async (root: string) => {
  const authority = await permissionAuthorityForRoot(
    root,
    ["investigation_input"],
    ["investigation_input"],
  );
  const result = await analyzeJavaScriptApplication(authority, {
    input_path: root,
    approved: true,
  });
  if (!result.ok) throw result.error;
  return result.value;
};

const electronRuntimeEvidence = (
  root: string,
  source: string,
  options: {
    readonly scriptFile?: string;
    readonly includeWorker?: boolean;
    readonly targetId?: string;
    readonly sourceCaptureApproved?: boolean;
    readonly workersUnavailable?: boolean;
  } = {},
) => {
  const scriptFile = options.scriptFile ?? "app.js";
  const includeWorker = options.includeWorker ?? true;
  const targetId = options.targetId ?? "target-main";
  const sourceCaptureApproved = options.sourceCaptureApproved ?? true;
  const input = {
    cdp_endpoint: "http://127.0.0.1:9223",
    allowed_file_roots: [root],
    target_id: targetId,
    approved: true as const,
    observation_ms: 100,
    include_script_sources: sourceCaptureApproved,
    source_capture_approved: sourceCaptureApproved,
    limits: {
      max_frames: 200,
      max_dom_nodes: 2_000,
      max_scripts: 500,
      max_resources: 2_000,
      max_workers: 500,
      max_script_source_bytes: 1_048_576,
      max_total_script_source_bytes: 4_194_304,
    },
  };
  return createElectronEvidence(
    "inspect_electron_page",
    input,
    {
      schema_version: 1,
      browser: {
        product: "Electron/fixture",
        protocol_version: "1.3",
        revision: "fixture",
        user_agent: "Electron fixture",
        js_version: "13",
      },
      target: {
        target_id: targetId,
        type: "page",
        title: "Fixture",
        file_path: join(root, "index.html"),
        attached: false,
      },
      capture_window: {
        started_at: "2026-07-15T00:00:00.000Z",
        ended_at: "2026-07-15T00:00:00.100Z",
        observation_ms: 100,
      },
      completeness: options.workersUnavailable
        ? {
            ...completeCapture(),
            status: "attach_limited" as const,
            conditions: ["attach_limited" as const],
            attach_limited_sections: ["workers" as const],
            unavailable_sections: ["workers" as const],
          }
        : completeCapture(),
      frames: [
        {
          frame_id: "frame-main",
          parent_frame_id: null,
          file_path: join(root, "index.html"),
        },
      ],
      dom: { total_nodes: 0, nodes: [] },
      scripts: {
        total: 1,
        items: [
          {
            script_key: `electron_script_${"1".repeat(64)}`,
            frame_id: "frame-main",
            file_path: join(root, scriptFile),
            cdp_hash: "fixture",
            length: Buffer.byteLength(source),
            is_module: true,
            language: "JavaScript",
            source: {
              included: true as const,
              artifact: createWebTextArtifact(source, "text/javascript"),
            },
          },
        ],
      },
      resources: [],
      workers: includeWorker
        ? [
            {
              target_id: "worker-main",
              type: "worker",
              file_path: join(root, "worker.js"),
              attached: false,
              opener_target_id: targetId,
              parent_frame_id: "frame-main",
            },
          ]
        : [],
      limitations: ["Synthetic passive capture fixture."],
    },
    {
      id: "rea-cdp-electron",
      name: "REA Electron file-page CDP observation provider",
      version: "1",
    },
  );
};

const completeCapture = () => ({
  status: "complete_within_window" as const,
  conditions: ["complete_within_window" as const],
  policy_filtered_sections: [],
  attach_limited_sections: [],
  truncated_sections: [],
  unavailable_sections: [],
  excluded: [],
  dropped_events: {
    scripts: 0,
    network_requests: 0,
    console_events: 0,
    websocket_connections: 0,
    websocket_frames: 0,
    webmcp_tools: 0,
    timeline_events: 0,
    total: 0,
  },
});
