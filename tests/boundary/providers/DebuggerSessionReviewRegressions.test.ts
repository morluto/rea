import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";

let directory: string | undefined;
const managers: Array<{ closeAll(): Promise<void> }> = [];

const expectOwnedProcessExited = async (pidText: string): Promise<void> => {
  const pid = Number(pidText);
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
};

it("keeps persistent GDB and Rizin sessions unavailable on Windows", async () => {
  const gdb = await new GdbSessionManager({
    environment: { REA_GDB_COMMAND: "/missing/gdb" },
    platform: "win32",
  }).start();
  const rizin = await new RizinDebugSessionManager(
    { REA_RIZIN_COMMAND: "/missing/rizin" },
    { platform: "win32" },
  ).start({ path: "/tmp/fixture.bin" });

  expect(gdb.ok).toBe(false);
  if (!gdb.ok) {
    expect(gdb.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(gdb.error.message).toContain("Job Object");
  }
  expect(rizin.ok).toBe(false);
  if (!rizin.ok) {
    expect(rizin.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(rizin.error.message).toContain("Job Object");
  }
});

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

it.skipIf(process.platform === "win32")(
  "returns cancellation when GDB startup is cancelled after spawn",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-start-cancel-"));
    const provider = join(directory, "fake-gdb-start-cancel.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      environment: { REA_GDB_COMMAND: provider },
    });
    managers.push(manager);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = await manager.start(controller.signal);

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
  },
);

it.skipIf(process.platform === "win32")(
  "marks GDB status history truncated when old MI records are discarded",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-history-truncated-"));
    const provider = join(directory, "fake-gdb-history-truncated.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("(gdb)\\n" + Array.from({ length: 300 }, (_, index) =>
  "=thread-group-added,id=\\"i" + index + "\\"\\n").join(""));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
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

    expect(
      manager.status(started.value.session_id)?.recent_mi_records_truncated,
    ).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "returns partial GDB observations with unknown completion on command timeout",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-command-timeout-"));
    const provider = join(directory, "fake-gdb-command-timeout.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(join(directory ?? "", "pid"))}, String(process.pid)));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("auto-load off")) process.stdout.write(match[1] + "^done\\n");
    else if (match) process.stdout.write("~\\"partial output\\n\\"\\n");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      environment: { REA_GDB_COMMAND: provider },
      commandTimeoutMs: 40,
    });
    managers.push(manager);
    const started = await manager.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = await manager.execute(
      started.value.session_id,
      "shell sleep 5",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toMatchObject({
        completion_status: "unknown",
        records: ['~"partial output', '"'],
      });
      expect(result.value.evidence.limitations.join(" ")).toContain("partial");
    }
    await expectOwnedProcessExited(
      await readFile(join(directory, "pid"), "utf8"),
    );
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps queued GDB commands serialized when a waiting request is cancelled",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-queue-cancel-"));
    const provider = join(directory, "fake-gdb-queue-cancel.mjs");
    const overlapPath = join(directory, "overlap");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
let input = "";
let firstActive = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line); if (!match) continue;
    if (line.includes("auto-load off")) process.stdout.write(match[1] + "^done\\n");
    else if (line.includes("first")) {
      firstActive = true;
      setTimeout(() => { firstActive = false; process.stdout.write(match[1] + "^done\\n"); }, 100);
    } else {
      if (line.includes("third") && firstActive) import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(overlapPath)}, "overlap"));
      process.stdout.write(match[1] + "^done\\n");
    }
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
    const first = manager.execute(started.value.session_id, "first");
    const controller = new AbortController();
    const second = manager.execute(
      started.value.session_id,
      "second",
      controller.signal,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    controller.abort();
    const third = manager.execute(started.value.session_id, "third");
    expect((await second).ok).toBe(false);
    expect((await first).ok).toBe(true);
    expect((await third).ok).toBe(true);
    await expect(readFile(overlapPath, "utf8")).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "marks GDB exit-fallback output truncated when MI history was bounded",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-exit-truncated-"));
    const provider = join(directory, "fake-gdb-exit-truncated.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line); if (!match) continue;
    if (line.includes("auto-load off")) process.stdout.write(match[1] + "^done\\n");
    else {
      process.stdout.write(Array.from({ length: 300 }, (_, index) => "=thread-created,id=\\"" + index + "\\"\\n").join(""));
      process.exit(0);
    }
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

    const result = await manager.execute(
      started.value.session_id,
      "info threads",
    );

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.result).toMatchObject({
        process_exit_observed: true,
        output_truncated: true,
        completion_status: "unknown",
      });
  },
);

it.skipIf(process.platform === "win32")(
  "keeps queued Rizin commands serialized when a waiting request is cancelled",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-queue-cancel-"));
    const provider = join(directory, "fake-rizin-queue-cancel.mjs");
    const overlapPath = join(directory, "overlap");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let firstActive = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "first") firstActive = true;
    if (line === "third" && firstActive) import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(overlapPath)}, "overlap"));
    if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (firstActive) setTimeout(() => { firstActive = false; process.stdout.write(marker + "\\0"); }, 100);
      else process.stdout.write(marker + "\\0");
    }
  }
});
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
    const first = manager.execute(started.value.session_id, "first");
    const controller = new AbortController();
    const second = manager.execute(
      started.value.session_id,
      "second",
      controller.signal,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    controller.abort();
    const third = manager.execute(started.value.session_id, "third");
    expect((await second).ok).toBe(false);
    expect((await first).ok).toBe(true);
    expect((await third).ok).toBe(true);
    await expect(readFile(overlapPath, "utf8")).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "preserves a truncated single Rizin frame that exceeds the protocol limit",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-frame-overflow-"));
    const provider = join(directory, "fake-rizin-frame-overflow.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let sent = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (!line.startsWith("!echo ") && !sent) {
      sent = true;
      process.stdout.write("z".repeat(16 * 1024 * 1024 + 32) + "\\0");
    }
  }
});
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

    const result = await manager.execute(started.value.session_id, "px");

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) {
      expect(
        Buffer.byteLength(result.value.result.output, "utf8"),
      ).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.value.result).toMatchObject({
        output_truncated: true,
        completion_status: "unknown",
      });
    }
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "returns bounded partial Rizin output with unknown completion after overflow",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-output-overflow-"));
    const provider = join(directory, "fake-rizin-output-overflow.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (!line.startsWith("!echo ")) process.stdout.write("x".repeat(10 * 1024 * 1024) + "\\0" + "y".repeat(10 * 1024 * 1024) + "\\0");
  }
});
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

    const result = await manager.execute(started.value.session_id, "px");

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) {
      expect(
        Buffer.byteLength(result.value.result.output, "utf8"),
      ).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.value.result).toMatchObject({
        output_truncated: true,
        completion_status: "unknown",
      });
    }
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "waits for the Rizin process to exit when command correlation times out",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-timeout-"));
    const provider = join(directory, "fake-rizin-command-timeout.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(join(directory ?? "", "pid"))}, String(process.pid)));
process.stdout.write("\\0");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => process.stdout.write("retained\\0"));
`,
    );
    await chmod(provider, 0o700);
    const manager = new RizinDebugSessionManager(
      { REA_RIZIN_COMMAND: provider },
      { frameTimeoutMs: 40 },
    );
    managers.push(manager);
    const started = await manager.start({ path: "/tmp/fixture.bin" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = await manager.execute(started.value.session_id, "dr");

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.result).toMatchObject({
        output: "retained",
        output_truncated: true,
        completion_status: "unknown",
      });
    await expectOwnedProcessExited(
      await readFile(join(directory, "pid"), "utf8"),
    );
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "cancels a running GDB command and retains its closed status",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-command-cancel-"));
    const provider = join(directory, "fake-gdb-command-cancel.mjs");
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
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("auto-load off")) process.stdout.write(match[1] + "^done\\n");
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
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await manager.execute(
      started.value.session_id,
      "shell sleep 600",
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "reports bounded GDB stderr retention in session status",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-diagnostic-limit-"));
    const provider = join(directory, "fake-gdb-diagnostic-limit.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stderr.write("x".repeat(100000));
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
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

    expect(
      manager.status(started.value.session_id)?.diagnostics_truncated,
    ).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "converts a GDB stdin pipe failure into a provider session error",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-gdb-stdin-error-"));
    const provider = join(directory, "fake-gdb-stdin-error.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    const match = /^(\\d+)/.exec(line);
    if (match && line.includes("auto-load off")) {
      process.stdout.write(match[1] + "^done\\n");
      setTimeout(() => import("node:fs").then((fs) => fs.closeSync(0)), 50);
    }
  }
});
setInterval(() => {}, 1000);
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    const result = await manager.execute(
      started.value.session_id,
      "info files",
    );

    expect(result.ok).toBe(false);
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "cancels a running Rizin command and retains its closed status",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-cancel-"));
    const provider = join(directory, "fake-rizin-command-cancel.mjs");
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
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "slow") stalled = true;
    else if (line.startsWith("!echo ") && !stalled) process.stdout.write(line.slice(6) + "\\n\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new RizinDebugSessionManager(
      { REA_RIZIN_COMMAND: provider },
      { frameTimeoutMs: 5_000 },
    );
    managers.push(manager);
    const started = await manager.start({ path: "/tmp/fixture.bin" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await manager.execute(
      started.value.session_id,
      "slow",
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "reports bounded Rizin stderr retention in session status",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-diagnostic-limit-"));
    const provider = join(directory, "fake-rizin-diagnostic-limit.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stderr.write("x".repeat(100000));
process.stdout.write("\\0");
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    expect(
      manager.status(started.value.session_id)?.diagnostics_truncated,
    ).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "returns cancellation when Rizin startup is cancelled after spawn",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-start-cancel-"));
    const provider = join(directory, "fake-rizin-start-cancel.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(provider, 0o700);
    const manager = new RizinDebugSessionManager({
      REA_RIZIN_COMMAND: provider,
    });
    managers.push(manager);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = await manager.start(
      { path: "/tmp/fixture.bin" },
      controller.signal,
    );

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
  },
);

it.skipIf(process.platform === "win32")(
  "converts a Rizin stdin pipe failure into a provider session error",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-stdin-error-"));
    const provider = join(directory, "fake-rizin-stdin-error.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
setTimeout(() => import("node:fs").then((fs) => fs.closeSync(0)), 40);
setInterval(() => {}, 1000);
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

    const result = await manager.execute(started.value.session_id, "dr");

    expect(result.ok).toBe(false);
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);
