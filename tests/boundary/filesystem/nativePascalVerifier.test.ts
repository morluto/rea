import { spawn } from "node:child_process";
import {
  chmod,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { createCanonicalTemporaryDirectory } from "../../../scripts/lib/canonical-temporary-directory.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("uses the canonical spelling for a verifier directory allocated through a symlink", async () => {
  const root = await createTestTempDirectory("rea-pascal-verifier-path-");
  const alias = join(root, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const allocated = await createCanonicalTemporaryDirectory(
    "rea-pascal-calls-",
    alias,
  );
  try {
    expect(allocated.path).toBe(await realpath(allocated.allocatedPath));
    expect(allocated.path).not.toBe(
      join(alias, basename(allocated.allocatedPath)),
    );
  } finally {
    await rm(allocated.allocatedPath, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")(
  "forwards verifier SIGTERM to the owned compiler group and removes its temporary directory",
  async () => {
    const root = await createTestTempDirectory("rea-pascal-verifier-cancel-");
    const fakeCompiler = join(root, "fake-fpc");
    const pidFile = join(root, "compiler-pids.txt");
    await writeFile(
      fakeCompiler,
      '#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });\nwriteFileSync(process.env.REA_VERIFY_TEST_PID_FILE, `${process.pid} ${child.pid}\\n`);\nawait new Promise(() => undefined);\n',
    );
    await chmod(fakeCompiler, 0o700);
    const verifier = spawn(
      process.execPath,
      ["scripts/verify-native-pascal-calls.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: root,
          REA_VERIFY_FPC_COMMAND: fakeCompiler,
          REA_VERIFY_TEST_PID_FILE: pidFile,
        },
        stdio: "ignore",
      },
    );
    try {
      const deadline = Date.now() + 10_000;
      let pids: number[] | undefined;
      while (Date.now() < deadline) {
        try {
          pids = (await readFile(pidFile, "utf8"))
            .trim()
            .split(/\s+/u)
            .map(Number);
          break;
        } catch (cause: unknown) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(pids, "the fake compiler started").toHaveLength(2);
      verifier.kill("SIGTERM");
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        verifier.once("error", reject);
        verifier.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: 143, signal: null });
      for (const pid of pids ?? [])
        expect(() => process.kill(pid, 0)).toThrow();
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith("rea-pascal-calls-"),
        ),
      ).toEqual([]);
    } finally {
      verifier.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);
