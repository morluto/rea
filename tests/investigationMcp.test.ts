import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { BinarySession } from "../src/application/BinarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../src/contracts/functionComparisonExample.js";
import { INVESTIGATION_EXAMPLES } from "../src/contracts/investigationExamples.js";
import {
  FUNCTION_COMPARISON_EVIDENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_COMPARISON_EVIDENCE,
} from "../src/contracts/investigationExamples.js";
import { changedBehaviorResultSchema } from "../src/domain/changedBehavior.js";
import { createEvidence } from "../src/domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../src/domain/jsonValue.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import { readInvestigationWorkspace } from "../src/application/InvestigationWorkspaceStore.js";
import type { EvidenceFilePolicy } from "../src/domain/evidenceBundle.js";
import type { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

describe("investigation MCP workflows", () => {
  it("never retains derived evidence after request cancellation", async () => {
    const { session, server, client } = await connected();
    const inputs = [
      {
        name: "find_changed_behavior",
        arguments: INVESTIGATION_EXAMPLES.find_changed_behavior,
      },
      {
        name: "build_call_path",
        arguments: INVESTIGATION_EXAMPLES.build_call_path,
      },
      {
        name: "correlate_static_and_runtime",
        arguments: INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
      },
    ] as const;
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      FUNCTION_COMPARISON_EVIDENCE,
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    const initialCount = session.exportEvidenceBundle().records.length;
    try {
      for (const input of inputs) {
        const controller = new AbortController();
        const request = client.callTool(input, {
          signal: controller.signal,
          onprogress: () => controller.abort(),
        });
        await expect(request).rejects.toThrow(/abort/iu);
      }
      await expect
        .poll(() => session.exportEvidenceBundle().records.length)
        .toBe(initialCount);
    } finally {
      await close(session, server, client);
    }
  });

  it("runs and reuses a persistent cross-version workspace", async () => {
    const directory = await createTestTempDirectory("rea-investigation-mcp-");
    const left = join(directory, "left");
    const right = join(directory, "right");
    const workspace = join(directory, "workspace.json");
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
      writeFile(join(left, "feature.txt"), "old\n"),
      writeFile(join(right, "feature.txt"), "new\n"),
    ]);
    const filePolicy = evidencePolicy(directory);
    const { session, server, client } = await connected(filePolicy);
    try {
      const arguments_ = {
        investigation_run: {
          approved: true,
          workspace_path: workspace,
          workspace_name: "mcp-release-diff",
          left_path: left,
          right_path: right,
          options: { page_size: 500, change_limit: 100 },
        },
      };
      const first = await client.callTool({
        name: "find_changed_behavior",
        arguments: arguments_,
      });
      expect(first.isError).not.toBe(true);
      const firstEvidence = sessionEvidence(session, first.structuredContent);
      expect(firstEvidence.normalized_result).toMatchObject({
        behavior_status: "unknown",
        summary: { static_candidates: 2 },
        investigation_run: { inventory_evidence_count: 2 },
      });
      expect(session.hasEvidence(firstEvidence.evidence_id)).toBe(true);
      const loaded = await readInvestigationWorkspace(workspace, filePolicy);
      expect(loaded).toMatchObject({
        ok: true,
        value: { revision: 3, runs: [{ status: "complete" }] },
      });
      expect(first.content).toContainEqual(
        expect.objectContaining({
          type: "resource_link",
          uri: expect.stringMatching(
            /^rea:\/\/workspace\/ws_[a-f0-9]{64}\/revision\/3$/u,
          ),
        }),
      );
      const retainedWorkspace = session.investigationWorkspaces()[0];
      expect(retainedWorkspace).toBeDefined();
      if (retainedWorkspace !== undefined) {
        const resource = await client.readResource({
          uri: `rea://workspace/${retainedWorkspace.workspace_id}/revision/${String(retainedWorkspace.revision)}`,
        });
        expect(resource.contents[0]).toEqual(
          expect.objectContaining({
            text: expect.stringContaining(retainedWorkspace.revision_digest),
          }),
        );
      }

      const second = await client.callTool({
        name: "find_changed_behavior",
        arguments: arguments_,
      });
      expect(second.isError, JSON.stringify(second)).not.toBe(true);
      const secondEvidence = sessionEvidence(session, second.structuredContent);
      expect(secondEvidence.evidence_id).toBe(firstEvidence.evidence_id);
      expect(
        await readInvestigationWorkspace(workspace, filePolicy),
      ).toMatchObject({ ok: true, value: { revision: 3 } });
    } finally {
      await close(session, server, client);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a complete workspace without write authority", async () => {
    const directory = await createTestTempDirectory("rea-investigation-read-");
    const left = join(directory, "left");
    const right = join(directory, "right");
    const workspace = join(directory, "workspace.json");
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
      writeFile(join(left, "feature.txt"), "old\n"),
      writeFile(join(right, "feature.txt"), "new\n"),
    ]);
    const filePolicy = evidencePolicy(directory);
    const arguments_ = {
      investigation_run: {
        approved: true,
        workspace_path: workspace,
        workspace_name: "read-only-replay",
        left_path: left,
        right_path: right,
        options: { page_size: 500, change_limit: 100 },
      },
    };
    const writer = await investigationAuthority(directory, true);
    const initial = await connected(filePolicy, [directory], writer);
    try {
      const created = await initial.client.callTool({
        name: "find_changed_behavior",
        arguments: arguments_,
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
    } finally {
      await close(initial.session, initial.server, initial.client);
    }

    const reader = await investigationAuthority(directory, false);
    const replay = await connected(filePolicy, [directory], reader);
    try {
      const cached = await replay.client.callTool({
        name: "find_changed_behavior",
        arguments: arguments_,
      });
      expect(cached.isError, JSON.stringify(cached)).not.toBe(true);
      expect(
        await readInvestigationWorkspace(workspace, filePolicy),
      ).toMatchObject({ ok: true, value: { revision: 3 } });

      await writeFile(join(right, "feature.txt"), "changed again\n");
      const denied = await replay.client.callTool({
        name: "find_changed_behavior",
        arguments: arguments_,
      });
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "permission_required",
            details: { capability: "investigation_workspace_write" },
          },
        },
      });
    } finally {
      await close(replay.session, replay.server, replay.client);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defers input permission for an explicit replay with deleted inputs", async () => {
    const directory = await createTestTempDirectory(
      "rea-investigation-replay-",
    );
    const left = join(directory, "left");
    const right = join(directory, "right");
    const workspace = join(directory, "workspace.json");
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
      writeFile(join(left, "feature.txt"), "old\n"),
      writeFile(join(right, "feature.txt"), "new\n"),
    ]);
    const filePolicy = evidencePolicy(directory);
    const investigationRun = {
      approved: true,
      workspace_path: workspace,
      workspace_name: "selected-replay",
      left_path: left,
      right_path: right,
      options: { page_size: 500, change_limit: 100 },
    };
    const writer = await investigationAuthority(directory, true);
    const initial = await connected(filePolicy, [directory], writer);
    let runId: string | undefined;
    try {
      const created = await initial.client.callTool({
        name: "find_changed_behavior",
        arguments: { investigation_run: investigationRun },
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const evidence = sessionEvidence(
        initial.session,
        created.structuredContent,
      );
      const result = changedBehaviorResultSchema.parse(
        evidence.normalized_result,
      );
      runId = result.investigation_run?.run_id;
    } finally {
      await close(initial.session, initial.server, initial.client);
    }
    if (runId === undefined) throw new Error("missing completed run ID");

    await Promise.all([
      rm(left, { recursive: true, force: true }),
      rm(right, { recursive: true, force: true }),
    ]);
    const workspaceOnly = await permissionAuthorityForRoot(
      directory,
      [
        "investigation_workspace_read",
        "investigation_workspace_write",
        "investigation_input",
      ],
      ["investigation_workspace_read"],
    );
    const replay = await connected(filePolicy, [], workspaceOnly);
    try {
      const cached = await replay.client.callTool({
        name: "find_changed_behavior",
        arguments: {
          investigation_run: {
            ...investigationRun,
            replay_run_id: runId,
          },
        },
      });
      expect(cached.isError, JSON.stringify(cached)).not.toBe(true);
      expect(
        await readInvestigationWorkspace(workspace, filePolicy),
      ).toMatchObject({ ok: true, value: { revision: 3 } });
    } finally {
      await close(replay.session, replay.server, replay.client);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses automatic artifact reads outside operator-approved roots", async () => {
    const directory = await createTestTempDirectory("rea-investigation-mcp-");
    const approvedInputs = join(directory, "approved-inputs");
    const outsideInputs = join(directory, "outside-inputs");
    const evidenceRoot = join(directory, "evidence");
    await Promise.all([
      mkdir(approvedInputs),
      mkdir(outsideInputs),
      mkdir(evidenceRoot),
    ]);
    const left = join(outsideInputs, "left");
    const right = join(outsideInputs, "right");
    await Promise.all([mkdir(left), mkdir(right)]);
    const { session, server, client } = await connected(
      evidencePolicy(evidenceRoot),
      [approvedInputs],
    );
    try {
      const response = await client.callTool({
        name: "find_changed_behavior",
        arguments: {
          investigation_run: {
            approved: true,
            workspace_path: join(evidenceRoot, "workspace.json"),
            left_path: left,
            right_path: right,
          },
        },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0]).toEqual({
        type: "text",
        text: JSON.stringify(response.structuredContent),
      });
    } finally {
      await close(session, server, client);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aggregates comparison Evidence and records an approved runtime gap", async () => {
    const { session, server, client } = await connected();
    const comparison =
      INVESTIGATION_EXAMPLES.find_changed_behavior.comparisons[0];
    if (comparison === undefined) throw new Error("missing comparison fixture");
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      comparison,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "find_changed_behavior",
        arguments: {
          comparisons: [comparison],
          unknown_registry_approved: true,
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = sessionEvidence(session, response.structuredContent);
      expect(evidence).toMatchObject({
        provider: { id: "rea-changed-behavior" },
        normalized_result: { behavior_status: "unknown" },
      });
      expect(
        session.listUnknowns({ domain: "changed-behavior" }),
      ).toMatchObject([
        {
          question:
            "Did both versions behave the same under a complete controlled replay?",
        },
      ]);
    } finally {
      await close(session, server, client);
    }
  });

  it("builds a zero-hop exact-address path with dossier citations", async () => {
    const { session, server, client } = await connected();
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.left).ok).toBe(
      true,
    );
    try {
      const response = await client.callTool({
        name: "build_call_path",
        arguments: INVESTIGATION_EXAMPLES.build_call_path,
      });
      expect(response.isError).not.toBe(true);
      const evidence = sessionEvidence(session, response.structuredContent);
      expect(evidence).toMatchObject({
        provider: { id: "rea-call-path" },
        normalized_result: {
          status: "found",
          shortest_hops: 0,
          paths: { total: 1 },
        },
        evidence_links: [FUNCTION_COMPARISON_EXAMPLE.left.evidence_id],
      });
    } finally {
      await close(session, server, client);
    }
  });

  it("records a safe unresolved call-path question", async () => {
    const { session, server, client } = await connected();
    const base = FUNCTION_COMPARISON_EXAMPLE.left;
    if (base.subject === null) throw new Error("missing dossier subject");
    const dossier = createEvidence(
      {
        path: base.subject.local_path,
        sha256: base.subject.digest.sha256,
        format: base.subject.format,
        ...(base.subject.architecture === null
          ? {}
          : { architecture: base.subject.architecture }),
      },
      base.provider,
      {
        predicateType: base.predicate_type,
        operation: base.operation,
        parameters: base.parameters,
        result: jsonValueSchema.parse({
          ...jsonObjectSchema.parse(base.normalized_result),
          callees: {
            items: [{ address: "0x2000", name: "next" }],
            total: 1,
            returned: 1,
            truncated: false,
            next_offset: null,
          },
        }),
        rawResult: base.raw_result,
        confidence: base.confidence,
        authority: base.authority,
        limitations: base.limitations,
        locations: base.locations,
        evidenceLinks: base.evidence_links,
      },
    );
    expect(session.recordEvidence(dossier).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "build_call_path",
        arguments: {
          ...INVESTIGATION_EXAMPLES.build_call_path,
          functions: [dossier],
          start: { address: "0x1000" },
          goal: { address: "0x3000" },
          unknown_registry_approved: true,
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(session.listUnknowns({ domain: "call-path" })).toMatchObject([
        {
          question:
            "Can the requested call path be established from complete analysis?",
        },
      ]);
    } finally {
      await close(session, server, client);
    }
  });

  it("records an explicit non-causal static/runtime hypothesis", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      FUNCTION_COMPARISON_EVIDENCE,
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "correlate_static_and_runtime",
        arguments: INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
      });
      expect(response.isError).not.toBe(true);
      const evidence = sessionEvidence(session, response.structuredContent);
      expect(evidence).toMatchObject({
        provider: { id: "rea-static-runtime-correlation" },
        confidence: "inferred",
        normalized_result: {
          status: "correlated",
          summary: { hypotheses: 1 },
        },
      });
    } finally {
      await close(session, server, client);
    }
  });

  it("records a safe unresolved static/runtime question", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      FUNCTION_COMPARISON_EVIDENCE,
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    const mapping =
      INVESTIGATION_EXAMPLES.correlate_static_and_runtime.mappings[0];
    if (mapping === undefined) throw new Error("missing correlation fixture");
    try {
      const response = await client.callTool({
        name: "correlate_static_and_runtime",
        arguments: {
          ...INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
          mappings: [
            {
              ...mapping,
              static: {
                ...mapping.static,
                selector: { kind: "function", dimension: "assembly" },
              },
            },
          ],
          unknown_registry_approved: true,
        },
      });
      expect(response.isError).not.toBe(true);
      expect(
        session.listUnknowns({ domain: "static-runtime-correlation" }),
      ).toMatchObject([
        {
          question:
            "Does runtime behavior match the available static analysis?",
        },
      ]);
    } finally {
      await close(session, server, client);
    }
  });

  it("passes only the finite declared reconstruction specification", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "verify_reconstruction",
        arguments: {
          ...INVESTIGATION_EXAMPLES.verify_reconstruction,
          unknown_registry_approved: true,
        },
      });
      expect(response.isError).not.toBe(true);
      const evidence = sessionEvidence(session, response.structuredContent);
      expect(evidence).toMatchObject({
        provider: { id: "rea-reconstruction-verifier" },
        normalized_result: { status: "pass", summary: { passed: 1 } },
      });
      expect(evidence.limitations).toContain(
        "Pass means every declared claim passed; it does not establish global implementation equivalence.",
      );
    } finally {
      await close(session, server, client);
    }
  });

  it("cannot omit a session-owned active unknown from reconstruction input", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    expect(
      session.recordUnknown({
        approved: true,
        question: "Was terminal equivalence reproduced independently?",
        severity: "high",
        domain: "reconstruction-verification",
        supporting_evidence_ids: [PROCESS_COMPARISON_EVIDENCE.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [
          {
            operation: "capture_process_scenario",
            rationale: "Repeat both sides under one controlled environment.",
          },
        ],
        relationships: [],
      }).ok,
    ).toBe(true);
    try {
      const response = await client.callTool({
        name: "verify_reconstruction",
        arguments: {
          ...INVESTIGATION_EXAMPLES.verify_reconstruction,
          unknown_registry_approved: true,
        },
      });
      expect(response.isError).not.toBe(true);
      const evidence = sessionEvidence(session, response.structuredContent);
      expect(evidence.normalized_result).toMatchObject({
        status: "unknown",
        summary: { unknown: 1 },
      });
      expect(
        session.listUnknowns({ domain: "reconstruction-verification" }),
      ).toContainEqual(
        expect.objectContaining({
          question: "Does the reconstruction satisfy every declared claim?",
        }),
      );
    } finally {
      await close(session, server, client);
    }
  });
});

const connected = async (
  evidenceFilePolicy?: EvidenceFilePolicy,
  investigationInputRoots: readonly string[] = evidenceFilePolicy?.roots ?? [],
  permissionAuthority?: PermissionAuthority,
) => {
  const session = new BinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    ...(evidenceFilePolicy === undefined
      ? {}
      : {
          evidenceFilePolicy,
          investigationInputRoots,
        }),
    ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
  });
  const client = new Client({ name: "investigation-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { session, server, client };
};

const evidencePolicy = (root: string): EvidenceFilePolicy => ({
  roots: [root],
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
});

const sessionEvidence = (session: BinarySession, value: unknown) => {
  const parsed = z
    .object({ evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u) })
    .parse(value);
  const evidence = session.evidenceById(parsed.evidence_id);
  if (evidence === undefined) throw new TypeError("Missing session Evidence");
  return evidence;
};

const investigationAuthority = async (
  root: string,
  includeWrite: boolean,
): Promise<PermissionAuthority> =>
  permissionAuthorityForRoot(
    root,
    [
      "investigation_workspace_read",
      "investigation_workspace_write",
      "investigation_input",
    ],
    [
      "investigation_workspace_read",
      "investigation_input",
      ...(includeWrite ? (["investigation_workspace_write"] as const) : []),
    ],
  );

const close = async (
  session: BinarySession,
  server: Awaited<ReturnType<typeof createServer>>,
  client: Client,
) => {
  await Promise.allSettled([client.close(), server.close(), session.close()]);
};
