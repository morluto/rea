import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { waitForTestPidFile } from "../../support/process/pidFile.js";
import { processTest } from "../../support/process/processFixture.js";
import { runningTestDeadline } from "../../support/runningTestDeadline.js";

const verifier = fileURLToPath(
  new URL("../../../scripts/verify-deepseek-client.mjs", import.meta.url),
);

const finalLine = '{"type":"final","text":"REA_CLIENT_COMPATIBILITY_OK"}\n';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false;
    throw cause;
  }
};

processTest
  .skipIf(process.platform === "win32")
  .for(["SIGINT", "SIGTERM"] as const)(
  "cleans up the detached DeepSeek command on %s",
  async (signal, { processes }) => {
    const state = await createTestTempDirectory("rea-deepseek-interrupt-");
    const client = join(state, "headless.mjs");
    const pidFile = join(state, "client.pid");
    const stop = join(state, "stop");
    await writeFile(
      client,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("interruption fixture");
} else {
  process.stdout.write(${JSON.stringify(finalLine)}, () => {
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  });
  const guard = setInterval(() => {
    if (existsSync(${JSON.stringify(stop)}) || !existsSync(${JSON.stringify(state)}))
      clearInterval(guard);
  }, 25);
}
`,
      { mode: 0o700 },
    );

    const child = processes.spawn(process.execPath, [verifier, "chat"], {
      env: {
        ...process.env,
        REA_VERIFY_DEEPSEEK_COMMAND: client,
        TMPDIR: state,
      },
    });
    child.stdin.end();
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    let stdout = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const result = new Promise((resolve) => {
      child.once("close", (code, terminationSignal) =>
        resolve({ code, terminationSignal }),
      );
    });
    try {
      const deadline = runningTestDeadline();
      if (deadline === undefined) throw new Error("Expected a test deadline");
      const pid = await Promise.race([
        waitForTestPidFile(pidFile, deadline),
        result.then(() => {
          throw new Error(
            `Verifier exited before the client published its PID\n${stderr}`,
          );
        }),
      ]);
      expect(alive(pid)).toBe(true);
      expect(child.kill(signal)).toBe(true);

      const status = await result;
      expect(alive(pid), "owned client survived verifier interruption").toBe(
        false,
      );
      expect(status).toEqual({ code: 1, terminationSignal: null });
      const receipt = JSON.parse(stdout);
      expect(receipt).toMatchObject({
        passed: false,
        interruption: `Verifier interrupted by ${signal}`,
        lifecycle: ["dry-run", "setup", "idempotent-setup", "doctor"],
        verifier: {
          process_lineage: { status: "verified", descendants: [] },
        },
      });
      expect(existsSync(join(receipt.artifacts, "receipt.json"))).toBe(true);
      expect(
        await readFile(join(receipt.artifacts, "client.stdout"), "utf8"),
      ).toBe(finalLine);
    } finally {
      // Give the fixture an independent way to exit on the broken baseline.
      await writeFile(stop, "");
    }
  },
);
