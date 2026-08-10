import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { runCrossVersionInvestigation } from "../../../src/application/CrossVersionInvestigation.js";
import { readInvestigationWorkspace } from "../../../src/application/InvestigationWorkspaceStore.js";
import type { EvidenceFilePolicy } from "../../../src/domain/evidenceBundle.js";
import { crossVersionInvestigationInputSchema } from "../../../src/domain/investigationWorkspace.js";

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
  it("fails closed on locks, CAS conflicts, tampering, and cancellation", async () => {
    const { directory, path, input } = await fixture();
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
    const { directory, input } = await fixture();
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
    const { directory, input, path } = await fixture();
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
