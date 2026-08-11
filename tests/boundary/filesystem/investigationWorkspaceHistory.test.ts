import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createPackageWithOptions } from "@electron/asar";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { runCrossVersionInvestigation } from "../../../src/application/CrossVersionInvestigation.js";
import {
  readInvestigationWorkspace,
  writeInvestigationWorkspace,
} from "../../../src/application/InvestigationWorkspaceStore.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import type { EvidenceFilePolicy } from "../../../src/domain/evidenceBundle.js";
import {
  createInvestigationWorkspace,
  crossVersionInvestigationInputSchema,
  investigationRunSchema,
} from "../../../src/domain/investigationWorkspace.js";
import { ok } from "../../../src/domain/result.js";

const policy = (root: string): EvidenceFilePolicy => ({
  roots: [root],
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
});

const fixture = async () => {
  const directory = await createTestTempDirectory("rea-workspace-");
  const left = join(directory, "left");
  const right = join(directory, "right");
  await Promise.all([mkdir(left), mkdir(right)]);
  await Promise.all([
    writeFile(join(left, "app.txt"), "version one\n"),
    writeFile(join(right, "app.txt"), "version two\n"),
    writeFile(join(right, "added.txt"), "new behavior candidate\n"),
  ]);
  const path = join(directory, "workspace.json");
  const input = crossVersionInvestigationInputSchema.parse({
    approved: true,
    workspace_path: path,
    workspace_name: "release-diff",
    left_path: left,
    right_path: right,
    options: { page_size: 2, change_limit: 100 },
  });
  return { directory, left, right, path, input };
};

describe("persistent cross-version investigation workspace", () => {
  it("enforces shared JSON depth limits while reading workspaces", async () => {
    const { directory, path, input } = await fixture();
    const completed = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    if (!completed.ok) throw completed.error;

    await expect(
      readInvestigationWorkspace(path, {
        ...policy(directory),
        maxDepth: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "InvestigationWorkspaceError", reason: "too-large" },
    });
  });

  it("resumes from a comparison checkpoint without recomputing its identity", async () => {
    const { directory, input } = await fixture();
    const completed = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    if (!completed.ok) throw completed.error;
    const run = completed.value.workspace.runs[0];
    if (run === undefined || run.comparison_evidence_id === null)
      throw new Error("missing completed run");
    expect(
      investigationRunSchema.safeParse({ ...run, status: "running" }).success,
    ).toBe(false);
    const partialRun = investigationRunSchema.parse({
      ...run,
      status: "running",
      completed_stages: [
        "inventory_left",
        "inventory_right",
        "compare_artifacts",
      ],
      result_evidence_id: null,
    });
    const records = completed.value.workspace.bundle.records.filter(
      ({ evidence_id: id }) => id !== run.result_evidence_id,
    );
    const partial = createInvestigationWorkspace(
      "release-diff",
      createEvidenceBundle(records),
      [partialRun],
    );
    const resumePath = join(directory, "resume.json");
    expect(
      await writeInvestigationWorkspace(
        partial,
        resumePath,
        null,
        policy(directory),
      ),
    ).toMatchObject({ ok: true });

    const replayAuthorization = vi.fn(() => Promise.resolve(ok(null)));
    await expect(
      runCrossVersionInvestigation(
        {
          ...input,
          workspace_path: resumePath,
          replay_run_id: partialRun.run_id,
        },
        policy(directory),
        { inputRoots: [], authorizeInputRead: replayAuthorization },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "InvestigationWorkspaceError",
        reason: "revision-conflict",
      },
    });
    expect(replayAuthorization).not.toHaveBeenCalled();

    const resumed = await runCrossVersionInvestigation(
      { ...input, workspace_path: resumePath },
      policy(directory),
      { inputRoots: [directory] },
    );
    expect(resumed).toMatchObject({
      ok: true,
      value: {
        reused: false,
        evidence: { evidence_id: completed.value.evidence.evidence_id },
        workspace: { revision: 2 },
      },
    });
  });
});

describe("persistent investigation workspace history", () => {
  it("appends a changed-content run without replacing earlier Evidence", async () => {
    const { directory, right, input } = await fixture();
    const first = await runCrossVersionInvestigation(input, policy(directory), {
      inputRoots: [directory],
    });
    if (!first.ok) throw first.error;
    const firstRun = first.value.workspace.runs[0];
    if (firstRun === undefined || firstRun.result_evidence_id === null)
      throw new Error("missing first completed run");

    await writeFile(join(right, "app.txt"), "version three\n");
    const second = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    expect(second).toMatchObject({
      ok: true,
      value: {
        reused: false,
        workspace: {
          revision: 6,
          runs: [{ status: "complete" }, { status: "complete" }],
        },
      },
    });
    if (!second.ok) throw second.error;
    expect(second.value.workspace.runs).toHaveLength(2);
    expect(second.value.workspace.runs.map(({ run_id: id }) => id)).toContain(
      firstRun.run_id,
    );
    expect(
      second.value.workspace.bundle.records.some(
        ({ evidence_id: id }) => id === firstRun.result_evidence_id,
      ),
    ).toBe(true);
  });

  it("checkpoints bounded integrity contradictions and safely reuses them", async () => {
    const directory = await createTestTempDirectory("rea-workspace-integrity-");
    const source = join(directory, "source");
    await mkdir(source);
    await writeFile(join(source, "addon.node"), "verified native addon\n");
    const left = join(directory, "left.asar");
    const right = join(directory, "right.asar");
    await Promise.all([
      createPackageWithOptions(source, left, { unpack: "*.node" }),
      createPackageWithOptions(source, right, { unpack: "*.node" }),
    ]);
    await writeFile(join(`${right}.unpacked`, "addon.node"), "tampered\n");
    const base = {
      approved: true as const,
      workspace_path: join(directory, "strict.json"),
      workspace_name: "integrity-diff",
      left_path: left,
      right_path: right,
      options: { page_size: 500, change_limit: 100 },
    };
    const strict = await runCrossVersionInvestigation(
      crossVersionInvestigationInputSchema.parse(base),
      policy(directory),
      { inputRoots: [directory] },
    );
    expect(strict).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "integrity" },
    });

    const continuedInput = crossVersionInvestigationInputSchema.parse({
      ...base,
      workspace_path: join(directory, "continued.json"),
      integrity_policy: "record-and-continue",
      integrity_continue_approved: true,
      max_integrity_mismatches: 2,
    });
    const continued = await runCrossVersionInvestigation(
      continuedInput,
      policy(directory),
      { inputRoots: [directory], integrityContinueEnabled: true },
    );
    expect(continued).toMatchObject({
      ok: true,
      value: { reused: false, workspace: { revision: 3 } },
    });
    if (!continued.ok) throw continued.error;
    expect(
      continued.value.workspace.bundle.records.some((record) =>
        JSON.stringify(record.normalized_result).includes(
          '"integrity_contradictions":[{',
        ),
      ),
    ).toBe(true);
    expect(
      continued.value.workspace.bundle.records.find(
        ({ operation }) => operation === "compare_artifacts",
      )?.normalized_result,
    ).toMatchObject({ status: "contradiction" });
    await expect(
      runCrossVersionInvestigation(continuedInput, policy(directory), {
        inputRoots: [directory],
        integrityContinueEnabled: true,
      }),
    ).resolves.toMatchObject({ ok: true, value: { reused: true } });

    const strictAfterContinuation = crossVersionInvestigationInputSchema.parse({
      ...base,
      workspace_path: continuedInput.workspace_path,
    });
    await expect(
      runCrossVersionInvestigation(strictAfterContinuation, policy(directory), {
        inputRoots: [directory],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "integrity" },
    });
  });
});
