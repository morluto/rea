import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { runDesktopBuildOwnedCommand } from "../../../src/desktop/DesktopBuildOwnedCommand.js";
import { prepareProcessOwnershipInspection } from "../../../src/process/ProcessOwnershipObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "stops the packing process family before removing its partial archive on timeout",
  { timeout: 15_000 },
  async () => {
    await prepareProcessOwnershipInspection();
    const directory = await createTestTempDirectory("rea-owned-pack-");
    const partial = join(directory, "partial.tar.xz");
    const workspace = join(directory, "work");
    await mkdir(workspace);
    const pidFile = join(directory, "child.pid");
    const child = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'child-work'), 'temporary'); setInterval(() => {}, 1000);`;
    const parent = `const {spawn} = require('node:child_process'); require('node:fs').writeFileSync(process.argv[1], 'partial'); spawn(process.execPath, ['-e', process.argv[3], process.argv[2]], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
    const resources = new ArtifactResourceScope();
    try {
      await expect(
        runDesktopBuildOwnedCommand({
          command: process.execPath,
          arguments: ["-e", parent, partial, pidFile, child],
          environment: {
            ...process.env,
            TMPDIR: workspace,
            TMP: workspace,
            TEMP: workspace,
          },
          timeoutMs: 2000,
          maxOutputBytes: 4096,
          resources,
          partialPath: partial,
          workspace,
        }),
      ).rejects.toMatchObject({ reason: "timeout" });
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(resources.hasPending).toBe(false);
    } finally {
      await resources.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "cancels a running setup process family before removing its partial output",
  { timeout: 15_000 },
  async () => {
    await prepareProcessOwnershipInspection();
    const directory = await createTestTempDirectory("rea-owned-pack-cancel-");
    const partial = join(directory, "partial.tar.xz");
    const pidFile = join(directory, "child.pid");
    const child = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `const {spawn} = require('node:child_process'); require('node:fs').writeFileSync(process.argv[1], 'partial'); spawn(process.execPath, ['-e', process.argv[3], process.argv[2]], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new Error("caller stopped setup");
    const running = runDesktopBuildOwnedCommand({
      command: process.execPath,
      arguments: ["-e", parent, partial, pidFile, child],
      environment: process.env,
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      resources,
      partialPath: partial,
      signal: controller.signal,
    });
    void running.catch(() => undefined);
    try {
      await vi.waitFor(
        async () => {
          expect(Number(await readFile(pidFile, "utf8"))).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      const pid = Number(await readFile(pidFile, "utf8"));
      controller.abort(reason);
      await expect(running).rejects.toMatchObject({
        _tag: "AnalysisCancelledError",
        operation: "setup",
        cause: reason,
        diagnostics: { command_failure: "cancelled" },
      });
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort(reason);
      await running.catch(() => undefined);
      await resources.close();
    }
  },
);
