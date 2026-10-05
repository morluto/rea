import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { XcrunCommandRunner } from "../../../../src/native/CommandRunner.js";
import { ok } from "../../../../src/domain/result.js";

it.skipIf(process.platform === "win32")(
  "does not accept signal termination as an allowed nonzero exit",
  async () => {
    const sha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const runner = new XcrunCommandRunner(async () =>
      ok({ path: process.execPath, sha256 }),
    );
    const exited = await runner.run("file", ["-e", "process.exit(1)"], {
      acceptNonZero: true,
    });
    expect(exited.ok).toBe(true);
    if (exited.ok) expect(exited.value.exitCode).toBe(1);
    const killed = await runner.run(
      "file",
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { acceptNonZero: true },
    );
    expect(killed.ok).toBe(false);
    if (!killed.ok) expect(killed.error.reason).toBe("nonzero-exit");
  },
);
