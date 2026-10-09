import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";

describe.skipIf(process.platform === "win32")(
  "persistent debugger session managers",
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

    it("runs a correlated GDB MI command, reports status, and closes its owned process", async () => {
      directory = await mkdtemp(join(tmpdir(), "rea-gdb-manager-"));
      const provider = join(directory, "fake-gdb.mjs");
      await writeFile(
        provider,
        `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match) process.stdout.write(match[1] + "^done\\n");
  }
});
`,
      );
      await chmod(provider, 0o700);
      const manager = new GdbSessionManager({
        environment: { REA_GDB_COMMAND: provider },
      });
      managers.push(manager);

      const started = await manager.start();
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(manager.status(started.value.session_id)?.state).toBe("ready");

      const result = await manager.execute(
        started.value.session_id,
        "show version",
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result.mi).toMatch(/^\d+\^done/u);

      const closed = await manager.close(started.value.session_id);
      expect(closed.ok).toBe(true);
      expect(manager.status(started.value.session_id)).toBeUndefined();
    });

    it("does not start GDB when it rejects the required auto-load setting", async () => {
      directory = await mkdtemp(join(tmpdir(), "rea-gdb-autoload-"));
      const provider = join(directory, "fake-gdb-reject.mjs");
      await writeFile(
        provider,
        `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (match) process.stdout.write(match[1] + (match[2].includes("-gdb-set auto-load off") ? "^error,msg=\\"rejected\\"\\n" : "^done\\n"));
  }
});
`,
      );
      await chmod(provider, 0o700);
      const manager = new GdbSessionManager({
        environment: { REA_GDB_COMMAND: provider },
      });
      managers.push(manager);

      const started = await manager.start();

      expect(started.ok).toBe(false);
      if (!started.ok)
        expect(JSON.stringify(started.error)).toContain(
          "automatic-loading disable command",
        );
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "persistent Rizin debugger session manager",
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

    it("uses an absolute target path and waits for Rizin's completion marker", async () => {
      directory = await mkdtemp(join(tmpdir(), "rea-rizin-manager-"));
      const provider = join(directory, "fake-rizin.mjs");
      const argsFile = join(directory, "args.json");
      await writeFile(
        provider,
        `#!/usr/bin/env node
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("\\0");
let input = "";
let stalled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    if (line === "dr") process.stdout.write("backend-event\\0rax=0x1234\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\n\\0");
  }
});
`,
      );
      await chmod(provider, 0o700);
      const manager = new RizinDebugSessionManager({
        REA_RIZIN_COMMAND: provider,
      });
      managers.push(manager);

      const started = await manager.start({
        path: "-target.bin",
        backend: "test-backend",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const providerArgs = await import("node:fs/promises").then(
        ({ readFile }) => readFile(argsFile, "utf8"),
      );
      expect(JSON.parse(providerArgs)).toEqual([
        "-N",
        "-0",
        "-d",
        "-D",
        "test-backend",
        resolve("-target.bin"),
      ]);

      const result = await manager.execute(started.value.session_id, "dr");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.result.output).toBe("backend-event\nrax=0x1234");
        expect(result.value.result.output_scope).toBe(
          "command_and_interleaved_session_output",
        );
        expect(result.value.result.backend).toBe("test-backend");
      }
      expect((await manager.close(started.value.session_id)).ok).toBe(true);
      expect(manager.status(started.value.session_id)).toBeUndefined();
    });

    it("stops and invalidates a Rizin session after its completion-marker timeout", async () => {
      directory = await mkdtemp(join(tmpdir(), "rea-rizin-timeout-"));
      const provider = join(directory, "fake-rizin-stall.mjs");
      await writeFile(
        provider,
        `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let stalled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    if (line === "dr") process.stdout.write("rax=0x1234\\0");
    else if (line === "slow") stalled = true;
    else if (line.startsWith("!echo ") && !stalled) process.stdout.write(line.slice(6) + "\\n\\0");
  }
});
`,
      );
      await chmod(provider, 0o700);
      const manager = new RizinDebugSessionManager(
        { REA_RIZIN_COMMAND: provider },
        { frameTimeoutMs: 50 },
      );
      managers.push(manager);

      const started = await manager.start({ path: "/tmp/fixture.bin" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const timedOut = await manager.execute(started.value.session_id, "slow");
      expect(timedOut.ok).toBe(false);
      expect(manager.status(started.value.session_id)?.state).toBe("closed");
      expect((await manager.execute(started.value.session_id, "dr")).ok).toBe(
        false,
      );
      expect((await manager.close(started.value.session_id)).ok).toBe(true);
    });

    it("stops Rizin when empty unsolicited NUL frames exhaust the bounded queue", async () => {
      directory = await mkdtemp(join(tmpdir(), "rea-rizin-empty-frames-"));
      const provider = join(directory, "fake-rizin-empty.mjs");
      await writeFile(
        provider,
        `#!/usr/bin/env node
process.stdout.write("\\0");
setTimeout(() => process.stdout.write("\\0".repeat(5000)), 10);
process.stdin.resume();
`,
      );
      await chmod(provider, 0o700);
      const manager = new RizinDebugSessionManager({
        REA_RIZIN_COMMAND: provider,
      });
      managers.push(manager);

      const started = await manager.start({ path: "/tmp/fixture.bin" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

      expect(manager.status(started.value.session_id)?.state).toBe("closed");
      expect((await manager.close(started.value.session_id)).ok).toBe(true);
    });
  },
);
