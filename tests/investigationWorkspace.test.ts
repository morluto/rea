import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackageWithOptions } from "@electron/asar";
import canonicalize from "canonicalize";

import { runCrossVersionInvestigation } from "../src/application/CrossVersionInvestigation.js";
import {
  readInvestigationWorkspace,
  writeInvestigationWorkspace,
} from "../src/application/InvestigationWorkspaceStore.js";
import { changedBehaviorResultSchema } from "../src/domain/changedBehavior.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import type { EvidenceFilePolicy } from "../src/domain/evidenceBundle.js";
import {
  createInvestigationWorkspace,
  crossVersionInvestigationInputSchema,
  investigationRunSchema,
  parseInvestigationWorkspace,
  serializeInvestigationWorkspace,
} from "../src/domain/investigationWorkspace.js";
import { ok } from "../src/domain/result.js";

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("fixture is not canonical");
  return createHash("sha256").update(encoded).digest("hex");
};

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const policy = (root: string): EvidenceFilePolicy => ({
  roots: [root],
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
});

const fixture = async () => {
  directory = await mkdtemp(join(tmpdir(), "rea-workspace-"));
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
  return { left, right, path, input };
};

describe("persistent cross-version investigation workspace", () => {
  it("migrates legacy v1 runs without losing their revision chain", async () => {
    const { input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    const completed = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    if (!completed.ok) throw completed.error;
    const current = completed.value.workspace;
    const currentRun = current.runs[0];
    if (currentRun === undefined) throw new Error("missing completed run");
    expect(() =>
      investigationRunSchema.parse({
        ...currentRun,
        legacy_request_identity: true,
      }),
    ).toThrow(/migrated strict runs/iu);
    const legacyIdentity = digestCanonical({
      schema: "rea.cross-version-investigation-request/v1",
      left: currentRun.left,
      right: currentRun.right,
      options: currentRun.options,
    });
    expect(() =>
      investigationRunSchema.parse({
        ...currentRun,
        legacy_request_identity: true,
        run_id: `run_${legacyIdentity}`,
        request_sha256: legacyIdentity,
        max_integrity_mismatches: 100,
      }),
    ).toThrow(/migrated strict runs/iu);
    const legacyRuns = current.runs.map((run) => {
      const requestSha256 = digestCanonical({
        schema: "rea.cross-version-investigation-request/v1",
        left: run.left,
        right: run.right,
        options: run.options,
      });
      const {
        integrity_policy: _integrityPolicy,
        integrity_continue_approved: _integrityApproved,
        max_integrity_mismatches: _integrityLimit,
        ...legacy
      } = run;
      return {
        ...legacy,
        run_id: `run_${requestSha256}`,
        request_sha256: requestSha256,
      };
    });
    const legacySemantic = {
      workspace_version: 1 as const,
      workspace_id: current.workspace_id,
      name: current.name,
      revision: current.revision,
      previous_revision_digest: current.previous_revision_digest,
      bundle: current.bundle,
      runs: legacyRuns,
    };
    const legacyDigest = `wrev_${digestCanonical(legacySemantic)}`;
    expect(() =>
      parseInvestigationWorkspace({
        ...legacySemantic,
        runs: legacyRuns.map((run) => ({
          ...run,
          max_integrity_mismatches: 100,
        })),
        revision_digest: legacyDigest,
      }),
    ).toThrow(/unrecognized key/iu);
    const migrated = parseInvestigationWorkspace({
      ...legacySemantic,
      revision_digest: legacyDigest,
    });

    expect(migrated).toMatchObject({
      revision: current.revision,
      previous_revision_digest: current.previous_revision_digest,
      runs: [
        {
          legacy_request_identity: true,
          integrity_policy: "fail",
          integrity_continue_approved: false,
          max_integrity_mismatches: 10,
        },
      ],
    });
    const encodedLegacy = canonicalize({
      ...legacySemantic,
      revision_digest: legacyDigest,
    });
    if (encodedLegacy === undefined)
      throw new TypeError("legacy fixture is not canonical");
    await writeFile(input.workspace_path, encodedLegacy, { mode: 0o600 });
    await expect(
      runCrossVersionInvestigation(
        { ...input, expected_workspace_revision: current.revision },
        policy(directory),
        { inputRoots: [directory] },
      ),
    ).resolves.toMatchObject({ ok: true, value: { reused: true } });
    await expect(
      runCrossVersionInvestigation(
        { ...input, integrity_continue_approved: true },
        policy(directory),
        { inputRoots: [directory] },
      ),
    ).resolves.toMatchObject({ ok: true, value: { reused: false } });
  });

  it("checkpoints, validates, and reuses a completed deterministic run", async () => {
    const { path, input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    const first = await runCrossVersionInvestigation(input, policy(directory), {
      inputRoots: [directory],
    });
    expect(first).toMatchObject({
      ok: true,
      value: { reused: false, workspace: { revision: 3 } },
    });
    if (!first.ok) throw first.error;
    const result = changedBehaviorResultSchema.parse(
      first.value.evidence.normalized_result,
    );
    expect(result).toMatchObject({
      behavior_status: "unknown",
      summary: { static_candidates: 3 },
      investigation_run: {
        workspace_id: first.value.workspace.workspace_id,
        run_id: first.value.workspace.runs[0]?.run_id,
      },
    });
    expect(result.limitations).toContain(
      "No process comparison Evidence was supplied.",
    );
    expect(first.value.workspace.bundle.records).toHaveLength(5);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe(
      serializeInvestigationWorkspace(first.value.workspace),
    );

    const second = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    expect(second).toMatchObject({
      ok: true,
      value: {
        reused: true,
        evidence: { evidence_id: first.value.evidence.evidence_id },
        workspace: { revision: 3 },
      },
    });
    expect(await readInvestigationWorkspace(path, policy(directory))).toEqual({
      ok: true,
      value: first.value.workspace,
    });
  });

  it("replays only an explicitly selected and fully verified complete run", async () => {
    const { left, right, input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    const completed = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    if (!completed.ok) throw completed.error;
    const run = completed.value.workspace.runs[0];
    if (run === undefined || run.comparison_evidence_id === null)
      throw new Error("missing completed run");

    const defaultAuthorization = vi.fn(() => Promise.resolve(ok(null)));
    await expect(
      runCrossVersionInvestigation(input, policy(directory), {
        inputRoots: [directory],
        authorizeInputRead: defaultAuthorization,
      }),
    ).resolves.toMatchObject({ ok: true, value: { reused: true } });
    expect(defaultAuthorization).toHaveBeenCalledOnce();

    const inconsistentRun = investigationRunSchema.parse({
      ...run,
      result_evidence_id: run.comparison_evidence_id,
    });
    const inconsistent = createInvestigationWorkspace(
      input.workspace_name,
      completed.value.workspace.bundle,
      [inconsistentRun],
    );
    const inconsistentPath = join(directory, "inconsistent.json");
    expect(
      await writeInvestigationWorkspace(
        inconsistent,
        inconsistentPath,
        null,
        policy(directory),
      ),
    ).toMatchObject({ ok: true });
    await expect(
      runCrossVersionInvestigation(
        {
          ...input,
          workspace_path: inconsistentPath,
          replay_run_id: run.run_id,
        },
        policy(directory),
        { inputRoots: [] },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });

    await Promise.all([
      rm(left, { recursive: true, force: true }),
      rm(right, { recursive: true, force: true }),
    ]);
    const replayAuthorization = vi.fn(() => Promise.resolve(ok(null)));
    await expect(
      runCrossVersionInvestigation(
        {
          ...input,
          expected_workspace_revision: completed.value.workspace.revision,
          replay_run_id: run.run_id,
        },
        policy(directory),
        { inputRoots: [], authorizeInputRead: replayAuthorization },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        reused: true,
        evidence: { evidence_id: completed.value.evidence.evidence_id },
        workspace: { revision: completed.value.workspace.revision },
      },
    });
    expect(replayAuthorization).not.toHaveBeenCalled();

    for (const replayInput of [
      { ...input, replay_run_id: `run_${"f".repeat(64)}` },
      { ...input, right_path: `${right}-other`, replay_run_id: run.run_id },
      {
        ...input,
        options: { ...input.options, change_limit: 99 },
        replay_run_id: run.run_id,
      },
    ])
      await expect(
        runCrossVersionInvestigation(replayInput, policy(directory), {
          inputRoots: [],
          authorizeInputRead: replayAuthorization,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          _tag: "InvestigationWorkspaceError",
          reason: "revision-conflict",
        },
      });
    expect(replayAuthorization).not.toHaveBeenCalled();
  });

  it("enforces shared JSON depth limits while reading workspaces", async () => {
    const { path, input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
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
    const { input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    const completed = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    if (!completed.ok) throw completed.error;
    const run = completed.value.workspace.runs[0];
    if (run === undefined || run.comparison_evidence_id === null)
      throw new Error("missing completed run");
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

  it("appends a changed-content run without replacing earlier Evidence", async () => {
    const { right, input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
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
    directory = await mkdtemp(join(tmpdir(), "rea-workspace-integrity-"));
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

  it("fails closed on locks, CAS conflicts, tampering, and cancellation", async () => {
    const { path, input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    await writeFile(`${path}.lock`, `${String(process.pid)}\n`, {
      mode: 0o600,
    });
    expect(
      await runCrossVersionInvestigation(input, policy(directory), {
        inputRoots: [directory],
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "InvestigationWorkspaceError", reason: "locked" },
    });
    await rm(`${path}.lock`);
    await writeFile(`${path}.lock`, "occupied\n", { mode: 0o600 });
    expect(
      await runCrossVersionInvestigation(input, policy(directory), {
        inputRoots: [directory],
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "InvestigationWorkspaceError", reason: "locked" },
    });
    await rm(`${path}.lock`);
    await writeFile(`${path}.lock`, "2147483647\n", { mode: 0o600 });
    const completed = await runCrossVersionInvestigation(
      input,
      policy(directory),
      { inputRoots: [directory] },
    );
    if (!completed.ok) throw completed.error;
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await runCrossVersionInvestigation(
        { ...input, expected_workspace_revision: 2 },
        policy(directory),
        { inputRoots: [directory] },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "InvestigationWorkspaceError",
        reason: "revision-conflict",
      },
    });

    const decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null)
      throw new Error("invalid workspace fixture");
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ ...decoded, revision: 99 }));
    expect(
      await readInvestigationWorkspace(path, policy(directory)),
    ).toMatchObject({
      ok: false,
      error: { _tag: "InvestigationWorkspaceError", reason: "integrity" },
    });

    const cancelledPath = join(directory, "cancelled.json");
    const controller = new AbortController();
    controller.abort();
    expect(
      await runCrossVersionInvestigation(
        { ...input, workspace_path: cancelledPath },
        policy(directory),
        { inputRoots: [directory], signal: controller.signal },
      ),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  });

  it("rejects workspace paths and symlinks outside approved roots", async () => {
    const { input } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    const approved = join(directory, "approved");
    await mkdir(approved);
    expect(
      await runCrossVersionInvestigation(input, policy(approved), {
        inputRoots: [directory],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "InvestigationWorkspaceError",
        reason: "outside-root",
      },
    });

    const outside = join(directory, "outside.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    const escaped = join(approved, "escaped.json");
    await symlink(outside, escaped);
    expect(
      await runCrossVersionInvestigation(
        { ...input, workspace_path: escaped },
        policy(approved),
        { inputRoots: [directory] },
      ),
    ).toMatchObject({
      ok: false,
      error: { _tag: "InvestigationWorkspaceError", reason: "not-file" },
    });
  });

  it("rejects artifact inputs outside independently approved roots", async () => {
    const { input, path } = await fixture();
    if (directory === undefined) throw new Error("missing fixture root");
    const approvedInputs = join(directory, "approved-inputs");
    await mkdir(approvedInputs);
    expect(
      await runCrossVersionInvestigation(input, policy(directory), {
        inputRoots: [approvedInputs],
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
