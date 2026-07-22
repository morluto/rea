import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { copyFile, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { BinarySession } from "../src/application/BinarySession.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
} from "../src/contracts/javascriptApplicationWorkflowExamples.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import { controlledReplayOutputSchema } from "../src/domain/javascriptReplay.js";
import { nodeCharacterizationPreparationOutputSchema } from "../src/domain/nodeRuntimeCharacterization.js";
import { analyzeJavaScriptApplication } from "../src/application/JavaScriptApplicationService.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

describe("application workflow MCP parity", () => {
  it("compares exact parser export shapes through full Evidence and session IDs", async () => {
    const root = await createTestTempDirectory("rea-export-shape-mcp-");
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      copyFile(
        resolve("tests/fixtures/replay/parser.mjs"),
        join(leftRoot, "parser.mjs"),
      ),
      copyFile(
        resolve("tests/fixtures/replay/parser-v2.mjs"),
        join(rightRoot, "parser.mjs"),
      ),
    ]);
    const authority = await permissionAuthorityForRoot(
      root,
      ["investigation_input"],
      ["investigation_input"],
    );
    const [left, right] = await Promise.all([
      analyzeJavaScriptApplication(authority, {
        input_path: leftRoot,
        approved: true,
      }),
      analyzeJavaScriptApplication(authority, {
        input_path: rightRoot,
        approved: true,
      }),
    ]);
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "export-shape-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const selectors = {
      left_module_path: "parser.mjs",
      left_export_name: "default",
      right_module_path: "parser.mjs",
      right_export_name: "default",
    };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const full = await client.callTool({
        name: "compare_javascript_export_shapes",
        arguments: { left: left.value, right: right.value, ...selectors },
      });
      expect(full.isError).not.toBe(true);
      expect(full.structuredContent).toMatchObject({
        result: {
          summary: { added: 1, removed: 0, changed: 0, unknown: 0 },
          changes: [
            {
              status: "added",
              path: "/depth",
              right: { availability: "literal", value: 1 },
            },
          ],
        },
      });
      expect(session.exportEvidenceBundle().records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "compare_javascript_export_shapes",
            predicate_type: "rea.javascript-export-shape-comparison/v1",
          }),
        ]),
      );

      const byId = await client.callTool({
        name: "compare_javascript_export_shapes",
        arguments: {
          left_evidence_id: left.value.evidence_id,
          right_evidence_id: right.value.evidence_id,
          ...selectors,
        },
      });
      expect(byId.isError).not.toBe(true);
      expect(byId.structuredContent).toMatchObject({
        result: {
          evidence_links: [left.value.evidence_id, right.value.evidence_id],
          changes: [expect.objectContaining({ path: "/depth" })],
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("traces and compares authenticated graph Evidence in the session", async () => {
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({
      name: "application-workflow-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let resourceListChanges = 0;
    client.setNotificationHandler(
      "notifications/resources/list_changed",
      () => {
        resourceListChanges += 1;
      },
    );
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const traced = await client.callTool({
        name: "trace_application_feature",
        arguments: JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
      });
      expect(traced.isError).not.toBe(true);
      expect(traced.structuredContent).toMatchObject({
        result: {
          schema_version: 1,
          coverage: { status: expect.any(String) },
        },
      });

      const compared = await client.callTool({
        name: "compare_application_versions",
        arguments: {
          ...JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
          unknown_registry_approved: true,
        },
      });
      expect(compared.isError).not.toBe(true);
      expect(compared.structuredContent).toMatchObject({
        result: {
          schema_version: 1,
          summary: { unknown: expect.any(Number) },
          coverage: { status: expect.any(String) },
        },
      });
      expect(session.exportEvidenceBundle().records.length).toBeGreaterThan(2);

      await new Promise<void>((resolve) => setImmediate(resolve));
      const notificationsBeforeIdReuse = resourceListChanges;
      const tracedById = await client.callTool({
        name: "trace_application_feature",
        arguments: {
          ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
          application_evidence_id:
            JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application
              .evidence_id,
        },
      });
      expect(tracedById.isError).not.toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resourceListChanges).toBe(notificationsBeforeIdReuse);

      const comparedById = await client.callTool({
        name: "compare_application_versions",
        arguments: {
          ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
          left_evidence_id:
            JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left
              .evidence_id,
          right_evidence_id:
            JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right
              .evidence_id,
        },
      });
      expect(comparedById).toMatchObject({
        structuredContent: {
          result: {
            evidence_links: expect.arrayContaining([
              JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left
                .evidence_id,
              JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right
                .evidence_id,
            ]),
          },
        },
      });

      const missing = await client.callTool({
        name: "trace_application_feature",
        arguments: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      });
      expect(missing).toMatchObject({
        isError: true,
        structuredContent: {
          error: { details: { reason: "missing" } },
        },
      });

      const wrongOperation = createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        { operation: "inventory_artifact", parameters: {}, result: {} },
      );
      const wrongPredicate = createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          predicateType: "fixture.application/v1",
          operation: "analyze_javascript_application",
          parameters: {},
          result: {},
        },
      );
      expect(session.recordEvidence(wrongOperation).ok).toBe(true);
      expect(session.recordEvidence(wrongPredicate).ok).toBe(true);
      for (const [record, reason] of [
        [wrongOperation, "wrong_operation"],
        [wrongPredicate, "wrong_predicate"],
      ] as const) {
        const rejected = await client.callTool({
          name: "trace_application_feature",
          arguments: {
            ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
            application_evidence_id: record.evidence_id,
          },
        });
        expect(rejected).toMatchObject({
          isError: true,
          structuredContent: { error: { details: { reason } } },
        });
      }

      const duplicateNative = await client.callTool({
        name: "trace_application_feature",
        arguments: {
          ...JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
          native_observations: [
            JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
          ],
          native_observation_evidence_ids: [
            JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application
              .evidence_id,
          ],
        },
      });
      expect(duplicateNative.isError).toBe(true);

      const spoofed = await client.callTool({
        name: "trace_application_feature",
        arguments: {
          ...JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
          application: {
            ...JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
            provider: { id: "spoofed", name: "spoofed", version: "1" },
          },
        },
      });
      expect(spoofed.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });

  it("plans and executes the same controlled replay contract", async () => {
    const root = resolve("tests/fixtures/replay");
    const policy = {
      enabled: true,
      roots: [root],
      nodePath: process.execPath,
      bubblewrapPath: process.execPath,
      systemdRunPath: process.execPath,
      systemctlPath: process.execPath,
      shellPath: process.execPath,
    };
    const ceiling = {
      capability: "javascript_replay" as const,
      roots: [root],
      executables: [
        policy.nodePath,
        policy.bubblewrapPath,
        policy.systemdRunPath,
        policy.systemctlPath,
        policy.shellPath,
      ],
      environment_names: [],
      network: "none" as const,
      mount: true,
    };
    const authority = new PermissionAuthority(
      createPermissionPolicy(
        [ceiling],
        [
          {
            ...ceiling,
            grant_id: "administrator:javascript_replay",
            lifetime: "administrator",
            operation_identity: null,
            expires_at: null,
          },
        ],
      ),
    );
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      permissionAuthority: authority,
      javascriptReplayPolicy: policy,
      javascriptReplayHost: {
        readSource: async (path) => ({
          canonicalPath: await realpath(path),
          bytes: await readFile(path),
        }),
        identifyExecutable: async (path) => ({
          path,
          version: "fixture",
          sha256: "1".repeat(64),
        }),
        identifyWorker: async () => ({
          path: "/fixture/worker.js",
          version: "fixture-worker-1",
          sha256: "2".repeat(64),
        }),
        identifyRuntimeClosure: async (path) => [
          {
            sourcePath: path,
            destinationPath: "/runtime/node",
            sha256: "1".repeat(64),
          },
        ],
        seccompDigest: () => "3".repeat(64),
        probe: async () => undefined,
      },
      javascriptReplayRunner: {
        execute: async (prepared) => ({
          schema_version: 1,
          plan_digest: prepared.publicPlan.plan_digest,
          outcomes: [
            {
              case_id: "heading",
              outcome: "return",
              value: { type: "heading", text: "Title" },
              input_sha256:
                prepared.publicPlan.cases[0]?.sha256 ?? "0".repeat(64),
              output_sha256: "2".repeat(64),
              truncated: false,
            },
          ],
          stderr: "",
          termination: "completed",
          cleanup: { state: "complete", residual_resources: [] },
          limitations: ["fixture runner"],
          reproducer: null,
        }),
      },
    });
    const client = new Client({ name: "replay-parity-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const input = {
      mode: "plan",
      left: {
        modules: [
          {
            alias: "parser",
            path: resolve(root, "parser.mjs"),
            format: "esm",
            role: "module",
            dependencies: {},
          },
        ],
        entry_alias: "parser",
        entry_export: "default",
      },
      cases: [{ case_id: "heading", arguments: ["# Title"] }],
      approved: false,
    };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const planned = await client.callTool({
        name: "run_controlled_replay",
        arguments: input,
      });
      expect(planned.isError).not.toBe(true);
      const digest = controlledReplayOutputSchema.parse(
        planned.structuredContent,
      ).plan?.plan_digest;
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
      const executed = await client.callTool({
        name: "run_controlled_replay",
        arguments: {
          ...input,
          mode: "execute",
          approved: true,
          plan_digest: digest,
        },
      });
      expect(executed.isError).not.toBe(true);
      expect(executed.structuredContent).toMatchObject({
        phase: "execute",
        evidence: {
          authority: "controlled-replay",
          provider: { id: "rea-javascript-replay" },
        },
      });
      expect(session.exportEvidenceBundle().records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ authority: "controlled-replay" }),
        ]),
      );
      const factoryPath = resolve(root, "sanitizer.factory.txt");
      const factoryBytes = await readFile(factoryPath);
      const factorySha256 = createHash("sha256")
        .update(factoryBytes)
        .digest("hex");
      const characterizationInput = {
        preparation_approved: true,
        selected_alias: "bundle",
        expected_effect: "pure",
        instrumentation: {
          artifact_path: factoryPath,
          artifact_sha256: factorySha256,
          selection: {
            byte_start: 0,
            byte_end: factoryBytes.byteLength,
            selected_sha256: factorySha256,
            export_name: "selected",
          },
        },
        replay: {
          mode: "plan",
          left: {
            modules: [
              {
                alias: "bundle",
                path: factoryPath,
                format: "commonjs-factory",
                role: "module",
                dependencies: {},
              },
            ],
            entry_alias: "bundle",
            entry_export: "selected",
          },
          cases: [{ case_id: "heading", arguments: ["# Title"] }],
          approved: false,
        },
      };
      const characterizationPlan = await client.callTool({
        name: "prepare_node_characterization",
        arguments: characterizationInput,
      });
      expect(characterizationPlan.isError).not.toBe(true);
      const approvedPlan = nodeCharacterizationPreparationOutputSchema.parse(
        characterizationPlan.structuredContent,
      ).plan;
      const characterized = await client.callTool({
        name: "execute_node_characterization",
        arguments: {
          execution_approved: true,
          approved_plan_sha256: approvedPlan.plan_sha256,
          preparation: characterizationInput,
        },
      });
      expect(characterized.isError).not.toBe(true);
      expect(characterized.structuredContent).toMatchObject({
        phase: "execution",
        evidence: {
          authority: "controlled-replay",
          provider: { id: "rea-node-characterization" },
        },
      });
      expect(session.exportEvidenceBundle().records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            predicate_type: "rea.javascript-export-transformation/v1",
          }),
          expect.objectContaining({
            predicate_type: "rea.runtime-characterization/v1",
          }),
        ]),
      );
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
