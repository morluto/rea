import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import {
  executePortableBatchHelp,
  executePortableCommand,
} from "../../scripts/lib/portable-command.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it.skipIf(process.platform !== "win32")(
  "finds batch help outside the package cwd and preserves literal path markers",
  async () => {
    const cwd = await createTestTempDirectory("rea-portable-batch-");
    const directory = join(cwd, "package %REA_PORTABLE_PROBE% & !NAME! 中文");
    await mkdir(directory);
    await writeFile(
      join(directory, "rea.cmd"),
      "@echo off\r\necho portable-batch-ok\r\ncd\r\n",
      "utf8",
    );
    const result = await executePortableBatchHelp(directory, {
      cwd,
      env: { ...process.env, REA_PORTABLE_PROBE: "expanded", NAME: "expanded" },
      timeout: 5_000,
      maxBuffer: 4096,
    });
    expect(result.stdout.trim().split("\r\n")).toEqual([
      "portable-batch-ok",
      cwd,
    ]);
    expect(result.stderr).toBe("");
  },
);

it.skipIf(process.platform !== "win32")(
  "preserves command output and nonzero status and rejects output overflow",
  async () => {
    const options = {
      cwd: await createTestTempDirectory("rea-portable-output-"),
      env: process.env,
      timeout: 5_000,
      maxBuffer: 4096,
    };
    const source =
      'process.stdout.write("中文");process.stderr.write("diagnostic");';
    await expect(
      executePortableCommand(process.execPath, ["-e", source], options),
    ).resolves.toEqual({ stdout: "中文", stderr: "diagnostic" });
    await expect(
      executePortableCommand(
        process.execPath,
        ["-e", `${source}process.exitCode=17;`],
        options,
      ),
    ).rejects.toMatchObject({ code: 17, stdout: "中文", stderr: "diagnostic" });
    await expect(
      executePortableCommand(
        process.execPath,
        [
          "-e",
          'setInterval(() => process.stdout.write("x".repeat(8192)), 10);',
        ],
        options,
      ),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  },
);

it
  .skipIf(process.platform !== "win32")
  .each(["powershell", "batch", "session"])(
  "%s portable timeout settles only after the launcher's descendant stops writing",
  async (mode) => {
    const root = await createTestTempDirectory("rea-portable-timeout-");
    const activity = join(root, "activity");
    const stop = join(root, "stop");
    await mkdir(join(root, "runtime"));
    await mkdir(join(root, "app/scripts"), { recursive: true });
    await copyFile(process.execPath, join(root, "runtime/node.exe"));
    await copyFile("scripts/lib/portable-launcher.ps1", join(root, "rea.ps1"));
    await writeFile(
      join(root, "rea.cmd"),
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0runtime\\launch.mjs"\r\nexit /b %errorlevel%\r\n',
      "utf8",
    );
    const session = join(root, "session.ps1");
    await writeFile(
      session,
      "param([string]$Launcher)\n& $Launcher\nexit $LASTEXITCODE\n",
      "utf8",
    );
    await copyFile(
      "scripts/lib/portable-node-bootstrap.mjs",
      join(root, "runtime/launch.mjs"),
    );
    await writeFile(
      join(root, "app/scripts/rea.mjs"),
      `import { appendFileSync, existsSync } from 'node:fs';
       setInterval(() => {
         if (existsSync(${JSON.stringify(stop)})) process.exit(0);
         appendFileSync(${JSON.stringify(activity)}, 'active\\n');
       }, 20);`,
      "utf8",
    );
    const powershell = join(
      process.env.SystemRoot!,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const arguments_ = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ];
    const command =
      mode === "batch"
        ? join(process.env.SystemRoot!, "System32/cmd.exe")
        : powershell;
    const args =
      mode === "batch"
        ? ["/d", "/v:on", "/s", "/c", '""rea.cmd""']
        : mode === "session"
          ? [...arguments_, session, join(root, "rea.ps1")]
          : [...arguments_, join(root, "rea.ps1")];
    try {
      await expect(
        executePortableCommand(command, args, {
          cwd: root,
          env: process.env,
          timeout: 10_000,
          maxBuffer: 4096,
          windowsVerbatimArguments: mode === "batch",
        }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });
      // The marker proves the actual bundled launcher started its Node child.
      const atCompletion = await readFile(activity, "utf8");
      expect(atCompletion.length).toBeGreaterThan(0);
      await delay(200);
      expect(await readFile(activity, "utf8")).toBe(atCompletion);
    } finally {
      // Also stops the pre-fix orphan when exercising this regression in red.
      await writeFile(stop, "stop", "utf8");
      await delay(200);
    }
  },
  20_000,
);
