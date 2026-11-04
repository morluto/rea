import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openInferiorTty } from "../../../scripts/verify-inferior-tty.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("closes a terminal helper that times out before reporting a terminal", async () => {
  const directory = await createTestTempDirectory("rea-tty-timeout-");
  const marker = join(directory, "pid");
  try {
    await expect(
      openInferiorTty({
        command: process.execPath,
        arguments: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        timeoutMs: 300,
      }),
    ).rejects.toThrow("did not report a path");
    const pid = Number(await readFile(marker, "utf8"));
    // This is observation only: never signal a cached PID for cleanup.
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects early terminal-helper exit without waiting for its deadline", async () => {
  await expect(
    openInferiorTty({
      command: process.execPath,
      arguments: ["-e", "process.exit(7)"],
      timeoutMs: 300,
    }),
  ).rejects.toThrow(/exited.*7/u);
});
