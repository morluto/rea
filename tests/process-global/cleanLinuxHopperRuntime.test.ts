import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { assertCleanLinuxHopperRuntime } from "../../scripts/lib/clean-linux-hopper-runtime.mjs";
import { completeVerifierRun } from "../../scripts/lib/verifier-run.mjs";
import { cleanupOwnedProcessGroup } from "../../src/process/ProcessOwnership.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);

it
  .runIf(process.platform === "linux")
  .each(["demo helper", "alternate launcher"])(
  "rejects a reparented %s without signaling it",
  async (mode) => {
    const runId = randomUUID();
    const childCode =
      "process.title = 'Xvfb'; setInterval(() => {}, 1000); process.send('ready');";
    const directory = await createTestTempDirectory("rea-clean-runtime-test-");
    const launcher = join(directory, "Hopper");
    const alternate = join(directory, "Hopper-alternate");
    const alternateMode = mode === "alternate launcher";
    if (alternateMode) {
      await copyFile("/usr/bin/sleep", launcher);
      await chmod(launcher, 0o700);
      await symlink(launcher, alternate);
    }
    const command = alternateMode ? alternate : process.execPath;
    const arguments_ = alternateMode ? ["30"] : ["-e", childCode];
    const parentCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(arguments_)}, {
        detached: true, stdio: ${JSON.stringify(alternateMode ? "ignore" : ["ignore", "ignore", "ignore", "ipc"])}
      });
      child.once('error', () => process.exit(1));
      child.once(${JSON.stringify(alternateMode ? "spawn" : "message")}, () => {
        process.stdout.write(JSON.stringify({ pid: child.pid, parentPid: process.pid }));
        if (child.connected) child.disconnect();
        child.unref();
      });
    `;
    const parent = execFileAsync(process.execPath, ["-e", parentCode], {
      env: { ...process.env, REA_PROCESS_RUN_ID: runId },
      timeout: 10_000,
    });
    const parentPid = parent.child.pid;
    if (parentPid === undefined)
      throw new Error("Fixture parent did not spawn");
    let orphanPid: number | undefined;
    try {
      const { stdout } = await parent;
      const { pid } = JSON.parse(stdout) as { pid: number };
      orphanPid = pid;
      const { stdout: coordinates } = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "ppid=,pgid=",
      ]);
      const [currentParent, group] = coordinates
        .trim()
        .split(/\s+/u)
        .map(Number);
      expect(currentParent).not.toBe(parentPid);
      expect(group).toBe(pid);

      const lineage = await completeVerifierRun({
        run_id: runId,
        verifier_pid: process.pid,
        parent_pid: process.ppid,
      });
      expect(lineage.process_lineage.status).toBe("verified");
      if (lineage.process_lineage.status === "verified")
        expect(
          lineage.process_lineage.descendants.some((p) => p.pid === pid),
        ).toBe(false);

      if (alternateMode) {
        const commandLine = await readFile(
          `/proc/${String(pid)}/cmdline`,
          "utf8",
        );
        expect(commandLine.split("\0")[0]).toBe(alternate);
        await unlink(alternate);
      }
      await expect(
        assertCleanLinuxHopperRuntime(alternateMode ? [launcher] : []),
      ).rejects.toThrow("Clean Linux runner retained a Hopper demo process");
      // Observation must not terminate the fixture, even though it resembles Xvfb.
      const { stdout: alive } = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "stat=",
      ]);
      expect(alive.trim()).not.toMatch(/^Z/u);
    } finally {
      if (orphanPid !== undefined) {
        const cleanup = await cleanupOwnedProcessGroup({
          runId,
          leaderPid: orphanPid,
          processGroupId: orphanPid,
        });
        expect(cleanup.cleaned, JSON.stringify(cleanup)).toBe(true);
      }
    }
  },
);
