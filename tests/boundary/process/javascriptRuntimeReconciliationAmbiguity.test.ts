import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createElectronEvidence } from "../../../src/application/javascript/ElectronEvidence.js";
import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntime } from "../../../src/domain/javascript/javascriptRuntimeReconciliation.js";
import { inspectElectronPageInputSchema } from "../../../src/domain/javascript/electronObservation.js";
import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";

const SOURCE = `const worker = new Worker("./worker.js");\nexport const observed = worker;\n`;
const execute = promisify(execFile);

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it("keeps byte-identical cross-layer candidates explicitly ambiguous", async () => {
  const application = await applicationFixture();
  const assets = await createTestTempDirectory("rea-runtime-assets-static-");
  const runtime = await createTestTempDirectory("rea-runtime-assets-live-");
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

it("retains all runtime entities and static load states without projection caps", async () => {
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
  });

  expect(result.runtime_captures).toHaveLength(2);
  expect(
    new Set(result.runtime_captures.map(({ target_node_id: id }) => id)).size,
  ).toBe(2);
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
  expect(result.static_load_states).toHaveLength(
    result.summary.static_loaded +
      result.summary.static_resident +
      result.summary.static_not_observed +
      result.summary.static_unknown,
  );
});

it("rejects runtime source bytes whose Evidence omits source-capture approval", async () => {
  const fixture = await applicationFixture();
  temporary.push(fixture);
  const staticEvidence = await analyzeFixture(fixture);
  const contradictoryRuntime = electronRuntimeEvidence(fixture, SOURCE, {
    includeWorker: false,
    sourceIncluded: false,
  });

  expect(() =>
    reconcileJavaScriptRuntime({
      static_layers: [{ role: "application", analysis: staticEvidence }],
      runtime_observations: [contradictoryRuntime],
    }),
  ).toThrow(/source-capture selection/u);
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
}, 10_000);

const applicationFixture = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-runtime-reconciliation-");
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
  const result = await analyzeJavaScriptApplication({
    input_path: root,
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
    readonly sourceIncluded?: boolean;
    readonly workersUnavailable?: boolean;
  } = {},
) => {
  const scriptFile = options.scriptFile ?? "app.js";
  const includeWorker = options.includeWorker ?? true;
  const targetId = options.targetId ?? "target-main";
  const sourceIncluded = options.sourceIncluded ?? true;
  const input = inspectElectronPageInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9223",
    target_id: targetId,
    observation_ms: 100,
    include_script_sources: sourceIncluded,
  });
  return createElectronEvidence(
    "inspect_electron_page",
    input,
    {
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
