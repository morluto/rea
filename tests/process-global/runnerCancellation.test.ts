import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

it.runIf(process.platform !== "win32")(
  "escalates cancellation when an owned command ignores SIGTERM",
  async () => {
    const lockName = `runner-cancel-${String(process.pid)}`;
    const lockPath = join(".cache", "rea-command-locks", `${lockName}.lock`);
    const runner = spawn(
      process.execPath,
      [
        "scripts/run-exclusive.mjs",
        lockName,
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const ready = new Promise<void>((resolveReady) => {
      runner.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("ready")) resolveReady();
      });
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveClosed) => {
      runner.once("close", (code, signal) => resolveClosed({ code, signal }));
    });

    try {
      await withTimeout(ready, "runner child did not start");
      runner.kill("SIGTERM");
      const result = await withTimeout(
        closed,
        "runner did not finish cancellation",
      );

      expect(result).toEqual({ code: 143, signal: null });
    } finally {
      if (runner.exitCode === null) runner.kill("SIGKILL");
      await withTimeout(closed, "runner cleanup did not finish");
    }

    expect(output).toContain("ready");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), 5_000);
    }),
  ]).finally(() => clearTimeout(timeout));
}
