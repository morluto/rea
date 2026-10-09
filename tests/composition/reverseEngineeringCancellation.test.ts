import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { execFileOutput } from "../../src/process/ExecFileOutput.js";

it("uses stoppable process mode for caller-selected provider commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-rizin-stoppable-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  let received: Record<string, unknown> | undefined;
  const service = new ReverseEngineeringService({
    run: async (_command, _args, options) => {
      received = options as Record<string, unknown>;
      return { stdout: "", stderr: "" };
    },
  });

  try {
    await service.executeRizinCommand({ path, command: "iI" });
    expect(received?.stopSignal).toBe("SIGTERM");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "waits for a cancelled Rizin process to exit before returning",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-rizin-cancel-settle-"));
    const path = join(directory, "fixture.bin");
    const marker = join(directory, "started");
    const provider = join(directory, "slow-rizin.mjs");
    await writeFile(path, "before");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(process.env.REA_TEST_STARTED, "started");
process.on("SIGTERM", () => {
  setTimeout(() => {
    appendFileSync(process.env.REA_TEST_ARTIFACT, "-stopped");
    process.exit(0);
  }, 100);
});
setInterval(() => {}, 1000);
`,
    );
    const controller = new AbortController();
    const service = new ReverseEngineeringService({
      environment: {
        REA_RIZIN_COMMAND: provider,
        REA_TEST_ARTIFACT: path,
        REA_TEST_STARTED: marker,
      },
      run: (_command, args, options) =>
        execFileOutput(process.execPath, [provider, ...args], options),
    });

    try {
      const pending = service.executeRizinCommand(
        { path, command: "sleep" },
        { signal: controller.signal },
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await readFile(marker);
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      controller.abort();

      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(await readFile(path, "utf8")).toBe("before-stopped");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
