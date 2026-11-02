import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";

describe.skipIf(process.platform === "win32")(
  "Rizin inferior environment",
  () => {
    let directory: string | undefined;
    const managers: Array<{ closeAll(): Promise<void> }> = [];

    afterEach(async () => {
      await Promise.all(
        managers
          .splice(0)
          .map((manager) => manager.closeAll().catch(() => undefined)),
      );
      if (directory !== undefined)
        await rm(directory, { recursive: true, force: true });
      directory = undefined;
    });

    it("restores the caller's run ID inside the inferior instead of REA's token", async () => {
      directory = await mkdtemp(join(tmpdir(), "rea-rizin-run-id-"));
      const provider = join(directory, "fake-rizin.mjs");
      const argsFile = join(directory, "args.json");
      await writeFile(
        provider,
        `#!/usr/bin/env node
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("\\0");
process.stdin.setEncoding("utf8");
let inputBuffer = "";
const handleInput = (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split("\\n");
  inputBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line === "dr") process.stdout.write("rax=0x1234\\0");
    else if (line === "olj") process.stdout.write("[]\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\n\\0");
  }
};
process.stdin.on("data", (chunk) => {
  const input = String(chunk);
  for (let offset = 0; offset < input.length; offset += 2)
    handleInput(input.slice(offset, offset + 2));
});
`,
      );
      await chmod(provider, 0o700);
      const manager = createRizinTestManager({
        REA_RIZIN_COMMAND: provider,
        REA_PROCESS_RUN_ID: "caller-run",
      });
      managers.push(manager);

      const started = await manager.start({
        path: "/tmp/fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args).toContain("setenv=REA_PROCESS_RUN_ID=caller-run");
      expect(args).not.toContain("unsetenv=REA_PROCESS_RUN_ID");

      const command = await manager.execute(started.value.session_id, "dr");
      expect(command.ok).toBe(true);
      if (command.ok)
        expect(command.value.result).toMatchObject({
          output: "rax=0x1234",
          completion_status: "complete",
        });
    });

    it.each(["caller\nrun", "caller\rrun", "caller-run "])(
      "rejects a caller run ID with unsafe profile boundaries before spawn: %j",
      async (runId) => {
        directory = await mkdtemp(join(tmpdir(), "rea-rizin-invalid-run-id-"));
        const provider = join(directory, "fake-rizin.mjs");
        const spawnMarker = join(directory, "spawned");
        await writeFile(
          provider,
          `#!/usr/bin/env node
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(spawnMarker)}, "spawned");
process.stdout.write("\\0");
`,
        );
        await chmod(provider, 0o700);
        const manager = createRizinTestManager({
          REA_RIZIN_COMMAND: provider,
          REA_PROCESS_RUN_ID: runId,
        });
        managers.push(manager);

        const started = await manager.start({
          path: "/tmp/fixture.bin",
          inferior_tty: await rizinTestInferiorTty(),
        });
        expect(started.ok).toBe(false);
        await expect(readFile(spawnMarker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  },
);
