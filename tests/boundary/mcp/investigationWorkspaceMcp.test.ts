import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { INVESTIGATION_EXAMPLES } from "../../../src/contracts/investigationExamples.js";
import {
  FUNCTION_COMPARISON_EVIDENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_COMPARISON_EVIDENCE,
} from "../../../src/contracts/investigationExamples.js";
import { changedBehaviorResultSchema } from "../../../src/domain/changedBehavior.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { readInvestigationWorkspace } from "../../../src/application/InvestigationWorkspaceStore.js";
import type { EvidenceFilePolicy } from "../../../src/domain/evidenceBundle.js";
import type { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { permissionAuthorityForRoot } from "../../fixtures/permissionAuthority.js";

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
}, 10_000);

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
  const directory = await createTestTempDirectory("rea-investigation-replay-");
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

const connected = async (
  evidenceFilePolicy?: EvidenceFilePolicy,
  investigationInputRoots: readonly string[] = evidenceFilePolicy?.roots ?? [],
  permissionAuthority?: PermissionAuthority,
) => {
  const session = createTestBinarySession(() => ({
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
