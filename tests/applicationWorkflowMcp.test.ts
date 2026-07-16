import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { BinarySession } from "../src/application/BinarySession.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
} from "../src/contracts/javascriptApplicationWorkflowExamples.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import { controlledReplayOutputSchema } from "../src/domain/javascriptReplay.js";

describe("application workflow MCP parity", () => {
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
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const traced = await client.callTool({
        name: "trace_application_feature",
        arguments: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      });
      expect(traced.isError).not.toBe(true);
      expect(traced.structuredContent).toMatchObject({
        operation: "trace_application_feature",
        provider: { id: "rea-javascript-application-workflows" },
        normalized_result: {
          schema_version: 1,
          coverage: { status: expect.any(String) },
        },
      });

      const compared = await client.callTool({
        name: "compare_application_versions",
        arguments: {
          ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
          unknown_registry_approved: true,
        },
      });
      expect(compared.isError).not.toBe(true);
      expect(compared.structuredContent).toMatchObject({
        operation: "compare_application_versions",
        normalized_result: {
          schema_version: 1,
          summary: { unknown: expect.any(Number) },
          coverage: { status: expect.any(String) },
        },
      });
      expect(session.exportEvidenceBundle().records.length).toBeGreaterThan(2);

      const spoofed = await client.callTool({
        name: "trace_application_feature",
        arguments: {
          ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
          application: {
            ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
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
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
