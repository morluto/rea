import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../src/application/JavaScriptApplicationService.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { reconstructJavaScriptArtifact } from "../src/application/JavaScriptArtifactReconstruction.js";
import { parseEvidence } from "../src/domain/evidence.js";
import { parseJavaScriptApplicationGraph } from "../src/domain/javascriptApplicationGraph.js";
import { analyzeJavaScriptApplicationInputSchema } from "../src/domain/javascriptApplicationAnalysis.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import { writeElectronBoundaryFixture } from "./fixtures/electronBoundaryApplication.js";

describe("static Electron application analysis", () => {
  it("requires explicit approval, an absolute path, and graph-safe combined bounds", () => {
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "relative/app.asar",
        approved: true,
      }).success,
    ).toBe(false);
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "/tmp/app.asar",
      }).success,
    ).toBe(false);
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "/tmp/app.asar",
        approved: true,
        limits: {
          max_entries: 100_000,
          max_findings: 200_000,
        },
      }).success,
    ).toBe(false);
    expect(
      analyzeJavaScriptApplicationInputSchema.parse({
        input_path: "/tmp/app.asar",
        approved: true,
      }),
    ).toMatchObject({
      format: "auto",
      source_map_read_approved: false,
      limits: { max_findings: 8_000 },
    });
  });

  it("maps windows, preload, contextBridge, IPC, validations, utility, and native boundaries without execution", async () => {
    const root = await fixtureDirectory();
    Reflect.deleteProperty(globalThis, "__rea_electron_fixture_executed");

    const first = await reconstructJavaScriptArtifact({ input_path: root });
    const second = await reconstructJavaScriptArtifact({ input_path: root });
    const graph = parseJavaScriptApplicationGraph(first.graph);

    expect(
      Reflect.get(globalThis, "__rea_electron_fixture_executed"),
    ).toBeUndefined();
    expect(first.graph).toEqual(second.graph);
    expect(first.electron_summary).toMatchObject({
      browser_windows: 3,
      explicit_web_preferences: 8,
      preload_entrypoints: 1,
      context_bridge_apis: 2,
      exposed_api_members: 5,
      ipc: {
        literal_channels: 5,
        dynamic_channel_operations: 2,
        paired_renderer_transmissions: 4,
        ambiguous_renderer_transmissions: 1,
        unpaired_literal_renderer_transmissions: 1,
      },
      sender_validation_observations: 2,
      utility_processes: 1,
      resolved_utility_entrypoints: 1,
      native_addon_bindings: 4,
      resolved_native_addon_bindings: 4,
    });
    expect(graph.nodes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "browser-window",
        "electron-preload",
        "context-bridge-api",
        "ipc-channel",
        "ipc-handler",
        "electron-utility",
        "native-addon",
        "native-export",
      ]),
    );
    const roles = graph.nodes.filter(({ kind }) =>
      ["electron-main", "electron-preload", "electron-renderer"].includes(kind),
    );
    expect(roles.length).toBeGreaterThanOrEqual(3);
    for (const role of roles) {
      for (const observation of role.observations)
        expect(observation.properties).toMatchObject({
          declared_path: expect.any(String),
          resolution_context: expect.stringMatching(
            /^(package-entrypoint|filesystem-expression|module-specifier|html-reference)$/u,
          ),
          resolution_status: expect.stringMatching(
            /^(resolved|not-found|unavailable|external|rejected)$/u,
          ),
          limitations: expect.any(Array),
        });
      if (
        role.observations.some(
          ({ properties }) => properties.resolution_status === "resolved",
        )
      )
        expect(
          graph.edges.some(
            (edge) =>
              edge.source_node_id === role.node_id &&
              edge.relation === "maps_to",
          ),
        ).toBe(true);
    }
    const dirnamePreload = roles.find(
      ({ kind, observations }) =>
        kind === "electron-preload" &&
        observations.some(
          ({ properties }) =>
            properties.declared_path === "preload.js" &&
            properties.resolution_context === "filesystem-expression",
        ),
    );
    expect(dirnamePreload?.observations[0]?.properties).toMatchObject({
      declared_path: "preload.js",
      resolution_context: "filesystem-expression",
      resolved_path: "preload.js",
      resolution_status: "resolved",
      limitations: [],
    });
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "browser-window",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                preload_path: "preload.js",
                absence_means_default: false,
                web_preferences: expect.arrayContaining([
                  expect.objectContaining({
                    name: "nodeIntegration",
                    value: expect.objectContaining({
                      status: "literal",
                      value: true,
                    }),
                  }),
                ]),
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "browser-window",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                web_preferences: expect.arrayContaining([
                  expect.objectContaining({
                    name: "nodeIntegration",
                    value: expect.objectContaining({
                      status: "literal",
                      value: false,
                    }),
                  }),
                  expect.objectContaining({
                    name: "contextIsolation",
                    value: expect.objectContaining({
                      status: "literal",
                      value: true,
                    }),
                  }),
                ]),
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "context-bridge-api",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                api_key: "reaApi",
                members: expect.arrayContaining([
                  "nested",
                  "nested.write",
                  "read",
                ]),
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "ipc-handler",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                fact_kind: "sender-validation-candidate",
                enforcement: "unknown",
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "native-export",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                native_export_verification: "not-performed",
              }),
            }),
          ]),
        }),
      ]),
    );
    const pairingEdges = graph.edges.filter(
      ({ properties }) =>
        properties.pairing_basis === "unique-exact-literal-channel",
    );
    expect(pairingEdges).toHaveLength(4);
    expect(
      pairingEdges.some(
        ({ properties }) => properties.channel === "rea:ambiguous",
      ),
    ).toBe(false);
    expect(graph.limitations.join(" ")).toMatch(/dynamic IPC|ambiguous/iu);
  });

  it("returns Evidence v2 only after exact investigation-input authorization", async () => {
    const root = await fixtureDirectory();
    const authority = permissionAuthority(root);

    const result = await analyzeJavaScriptApplication(authority, {
      input_path: root,
      approved: true,
    });

    if (!result.ok) throw result.error;
    const evidence = parseEvidence(result.value);
    expect(evidence).toMatchObject({
      operation: "analyze_javascript_application",
      predicate_type: "rea.javascript-application-analysis/v1",
      provider: { id: "rea-javascript-application" },
      authority: "shipped-artifact",
      confidence: "derived",
      subject: { local_path: root, format: "directory" },
      normalized_result: {
        schema_version: 1,
        input_path: root,
        summary: { browser_windows: 3 },
      },
    });

    const denied = await analyzeJavaScriptApplication(
      permissionAuthority(root),
      {
        input_path: join(root, ".."),
        approved: true,
      },
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { _tag: "PermissionRequiredError" },
    });
  });

  it("returns a tagged cancellation without executing application code", async () => {
    const root = await fixtureDirectory();
    const controller = new AbortController();
    controller.abort();
    Reflect.deleteProperty(globalThis, "__rea_electron_fixture_executed");

    const result = await analyzeJavaScriptApplication(
      permissionAuthority(root),
      { input_path: root, approved: true },
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    expect(
      Reflect.get(globalThis, "__rea_electron_fixture_executed"),
    ).toBeUndefined();
  });
});

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-boundaries-");
  await writeElectronBoundaryFixture(root);
  return root;
};

const permissionAuthority = (root: string): PermissionAuthority =>
  new PermissionAuthority(
    createPermissionPolicy(
      [scope(root)],
      [
        {
          ...scope(root),
          grant_id: "test:investigation-input",
          lifetime: "session",
          operation_identity: null,
          expires_at: null,
        },
      ],
    ),
  );

const scope = (root: string) => ({
  capability: "investigation_input" as const,
  roots: [root],
  executables: [],
  environment_names: [],
  network: "none" as const,
  mount: false,
});
