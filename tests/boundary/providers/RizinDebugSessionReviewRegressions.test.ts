import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";

import {
  assertRizinEmptyInferiorInventory,
  parseRizinPtraceRows,
  RizinDebugSessionManager,
} from "../../../src/rizin/RizinDebugSessionManager.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessHandle,
} from "../../../src/process/ProviderProcess.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";
import type { OwnedDebuggerDetachResult } from "../../../src/process/ownedDebuggerSession.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";

let directory: string | undefined;
const managers: Array<{ closeAll(): Promise<void> }> = [];
const inferiorProcesses: ChildProcess[] = [];
const ownedProviderProcesses: ProviderProcessHandle[] = [];

it("accepts only ended retained identities for an empty Rizin inventory", async () => {
  const identity = { pid: "123", startTime: "100" };

  await expect(
    assertRizinEmptyInferiorInventory([identity], async () => "100"),
  ).rejects.toThrow("still active");
  await expect(
    assertRizinEmptyInferiorInventory([identity], async () => "101"),
  ).resolves.toBeUndefined();
  await expect(
    assertRizinEmptyInferiorInventory([identity], async () => null),
  ).resolves.toBeUndefined();
});

it("does not retain an out-of-range PID from a Rizin ptrace row", () => {
  const parsed = parseRizinPtraceRows(
    JSON.stringify([
      { fd: 12, raised: true, uri: `ptrace://${"9".repeat(5_000)}` },
    ]),
  );
  expect(parsed.rows).toEqual([]);
  expect(parsed.observedPids).toEqual([]);
  expect(parsed.error?.message).toContain("invalid Linux PID");
});

it("rejects an oversized Rizin inferior inventory before retaining rows", () => {
  const rows = Array.from({ length: 1025 }, (_, index) => ({
    fd: index + 12,
    raised: true,
    uri: `ptrace://${index + 1000}`,
  }));
  const parsed = parseRizinPtraceRows(JSON.stringify(rows));

  expect(parsed.overflow).toBe(true);
  expect(parsed.rows).toEqual([]);
  expect(parsed.observedPids).toEqual([]);
  expect(parsed.error?.message).toContain("safe inferior row limit");

  const oversizedText = parseRizinPtraceRows(" ".repeat(256 * 1024 + 1));
  expect(oversizedText.overflow).toBe(true);
  expect(oversizedText.rows).toEqual([]);
  expect(oversizedText.observedPids).toEqual([]);
  expect(oversizedText.error?.message).toContain("safe inventory size limit");
});

const startRizinWithProvider = async (
  provider: string,
): Promise<{
  manager: RizinDebugSessionManager;
  sessionId: string | undefined;
}> => {
  const manager = createRizinTestManager({ REA_RIZIN_COMMAND: provider });
  managers.push(manager);
  const started = await manager.start({
    path: "/tmp/fixture.bin",
    inferior_tty: await rizinTestInferiorTty(),
  });
  expect(started.ok).toBe(true);
  return {
    manager,
    sessionId: started.ok ? started.value.session_id : undefined,
  };
};

const startRizinWithOwnedStop = async (
  provider: string,
  readProcessTracerPid: (pid: string) => Promise<number> = async () => 777,
  onInferiorDetachVerified?: (result: OwnedDebuggerDetachResult) => void,
) => {
  let debuggerProcess: ProviderProcessHandle | undefined;
  const manager = new RizinDebugSessionManager(
    { ...process.env, REA_RIZIN_COMMAND: provider },
    {
      platform: "linux",
      readProcessTracerPid,
      readProcessTaskIds: async () => new Set(["777"]),
      ...(onInferiorDetachVerified === undefined
        ? {}
        : { onInferiorDetachVerified }),
      spawnProcess: async (options) => {
        const launched = await spawnOwnedProviderProcess(options);
        debuggerProcess = launched.process;
        return launched;
      },
    },
  );
  managers.push(manager);
  const started = await manager.start({
    path: "/tmp/fixture.bin",
    inferior_tty: await rizinTestInferiorTty(),
  });
  if (!started.ok) throw started.error;
  return {
    manager,
    sessionId: started.value.session_id,
    exitDebugger: async () => {
      if (debuggerProcess === undefined)
        throw new Error("Provider did not spawn");
      const exited = new Promise<void>((resolve) =>
        debuggerProcess?.once("exit", () => resolve()),
      );
      debuggerProcess.kill("SIGTERM");
      await exited;
    },
  };
};

const expectOwnedProcessExited = async (pidText: string): Promise<void> => {
  const pid = Number(pidText);
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
};

afterEach(async () => {
  for (const inferior of inferiorProcesses.splice(0)) {
    if (inferior.exitCode !== null || inferior.signalCode !== null) continue;
    const exited = new Promise<void>((resolveExit) =>
      inferior.once("exit", () => resolveExit()),
    );
    inferior.kill("SIGTERM");
    await exited;
  }
  await Promise.all(
    managers
      .splice(0)
      .map((manager) => manager.closeAll().catch(() => undefined)),
  );
  for (const provider of ownedProviderProcesses.splice(0)) {
    if (provider.exitCode !== null || provider.signalCode !== null) continue;
    const exited = new Promise<void>((resolveExit) =>
      provider.once("exit", () => resolveExit()),
    );
    provider.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_000)),
    ]);
    if (provider.exitCode === null && provider.signalCode === null) {
      const killed = new Promise<void>((resolveExit) =>
        provider.once("exit", () => resolveExit()),
      );
      provider.kill("SIGKILL");
      await killed;
    }
  }
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const spawnTestInferior = async (): Promise<ChildProcess> => {
  const inferior = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
    },
  );
  inferiorProcesses.push(inferior);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    inferior.once("spawn", resolveSpawn);
    inferior.once("error", rejectSpawn);
  });
  return inferior;
};

const spawnTestInferiorOnTty = async (
  ttyPath: string,
  closeSinksOnUsr1 = false,
  sinksClosedMarker?: string,
): Promise<ChildProcess> => {
  const ttyFd = openSync(ttyPath, "w");
  let inferior: ChildProcess;
  try {
    inferior = spawn(
      process.execPath,
      [
        "-e",
        `${closeSinksOnUsr1 ? `process.on('SIGUSR1', () => { require('node:fs').closeSync(1); require('node:fs').closeSync(2); require('node:fs').writeFileSync(${JSON.stringify(sinksClosedMarker)}, 'closed'); }); ` : ""}setInterval(() => {}, 1000)`,
      ],
      {
        stdio: [ttyFd, ttyFd, ttyFd],
      },
    );
  } finally {
    closeSync(ttyFd);
  }
  inferiorProcesses.push(inferior);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    inferior.once("spawn", resolveSpawn);
    inferior.once("error", rejectSpawn);
  });
  return inferior;
};

const createInferiorInventoryProvider = async (
  rows: readonly { readonly fd: number; readonly pid: number }[],
): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-rizin-owned-inferior-"));
  const provider = join(directory, "fake-rizin-owned-inferior.mjs");
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
    if (line === "olj") process.stdout.write(JSON.stringify(${JSON.stringify(rows.map(({ fd, pid }) => ({ fd, raised: true, uri: `ptrace://${pid}` })))} ) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("true\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createRetryEmptyInventoryProvider = async (
  pid: number,
): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-rizin-empty-retry-"));
  const provider = join(directory, "fake-rizin-empty-retry.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") {
      inventory += 1;
      process.stdout.write((inventory === 1 ? JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }]) : "[]") + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const spawnTestInferiorWithMutableInput = async (
  ttyPath: string,
  statePath: string,
): Promise<ChildProcess> => {
  const ttyFd = openSync(ttyPath, "w");
  let inferior: ChildProcess;
  try {
    inferior = spawn(
      process.execPath,
      [
        "-e",
        `const { closeSync, openSync, writeFileSync } = require("node:fs");
const [ttyPath, statePath] = process.argv.slice(1);
const replaceInput = (path, state) => {
  closeSync(0);
  if (openSync(path, "r") !== 0) throw new Error("stdin was not reopened as fd 0");
  writeFileSync(statePath, state);
};
process.on("SIGUSR1", () => replaceInput("/dev/zero", "unclassified"));
process.on("SIGUSR2", () => replaceInput(ttyPath, "restored"));
setInterval(() => {}, 1000);`,
        ttyPath,
        statePath,
      ],
      { stdio: [ttyFd, ttyFd, ttyFd] },
    );
  } finally {
    closeSync(ttyFd);
  }
  inferiorProcesses.push(inferior);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    inferior.once("spawn", resolveSpawn);
    inferior.once("error", rejectSpawn);
  });
  return inferior;
};

const createPostDetachInputTransitionProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-rizin-detached-sink-"));
  const provider = join(directory, "fake-rizin-detached-sink.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let pendingDetach = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write((detached ? "[]" : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) {
      detached = true;
      pendingDetach = true;
      process.kill(${pid}, "SIGUSR1");
    }
    else if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (pendingDetach) {
        pendingDetach = false;
        setTimeout(() => process.stdout.write(marker + "\\0"), 100);
      } else process.stdout.write(marker + "\\0");
    }
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createMalformedDetachReadbackProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-malformed-detach-readback.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let postDetachReadbacks = 0;
let pendingDetach = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      if (!detached) process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }]) + "\\0");
      else if (postDetachReadbacks++ === 0) process.stdout.write("{malformed\\0");
      else process.stdout.write("[]\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) {
      detached = true;
      pendingDetach = true;
      process.kill(${pid}, "SIGUSR1");
    }
    else if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (pendingDetach) {
        pendingDetach = false;
        setTimeout(() => process.stdout.write(marker + "\\0"), 100);
      } else process.stdout.write(marker + "\\0");
    }
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createRetryableDetachProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-retryable-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detachAttempts = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write(JSON.stringify(detached ? [] : [{ fd: 12, raised: true, uri: "ptrace://${pid}" }]) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") { detachAttempts += 1; if (detachAttempts >= 2) detached = true; }
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createAdditionalActiveAfterDetachProvider = async (
  selectedPid: number,
  additionalPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(
    directory!,
    "fake-rizin-additional-active-after-detach.mjs",
  );
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let postDetachReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      const rows = !detached
        ? [{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }]
        : postDetachReadbacks++ === 0
          ? [{ fd: 13, raised: true, uri: "ptrace://${additionalPid}" }]
          : [];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createStaleSelectedRowWithActiveAdditionalProvider = async (
  selectedPid: number,
  additionalPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(
    directory!,
    "fake-rizin-stale-selected-row-active-additional.mjs",
  );
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let postDetachReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      if (!detached) process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }]) + "\\0");
      else {
        postDetachReadbacks += 1;
        const rows =
          postDetachReadbacks === 1
            ? [{ fd: 13, raised: true, uri: "ptrace://${additionalPid}" }]
            : postDetachReadbacks === 2
              ? [{ fd: 13, raised: true, uri: "ptrace://${selectedPid}" }]
              : [];
        process.stdout.write(JSON.stringify(rows) + "\\0");
      }
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createLateDetachProvider = async (
  pid: number,
  providerDirectory: string,
  completionPath: string,
): Promise<string> => {
  const provider = join(providerDirectory, "fake-rizin-late-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let pendingDetach = false;
let pendingExitPolicyReadback = false;
let exitPolicyReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") process.stdout.write((detached ? "[]" : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") {
      exitPolicyReadbacks += 1;
      pendingExitPolicyReadback = true;
    }
    else if (line.startsWith("o- ")) {
      pendingDetach = true;
      setTimeout(() => { detached = true; }, 700);
    }
    else if (line.startsWith("!echo ")) {
      const marker = line.slice(6);
      if (pendingExitPolicyReadback) {
        pendingExitPolicyReadback = false;
        setTimeout(() => {
          if (exitPolicyReadbacks >= 2)
            writeFileSync(${JSON.stringify(completionPath)}, "done");
          process.stdout.write("false\\0" + marker + "\\0");
        }, 700);
      } else if (pendingDetach) {
        pendingDetach = false;
        setTimeout(() => {
          process.stdout.write(marker + "\\0");
        }, 700);
      } else process.stdout.write(marker + "\\0");
    }
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createReusedPidPtraceProvider = async (
  pid: number,
  providerDirectory: string,
  commandsPath: string,
): Promise<string> => {
  const provider = join(providerDirectory, "fake-rizin-reused-pid.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let exitPolicyReadbacks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write((detached ? "[]" : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${pid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write((exitPolicyReadbacks++ === 0 ? "true" : "false") + "\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createStaleRowAfterDetachProvider = async (
  stalePid: number,
  livePid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-stale-row-after-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventoryReads = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventoryReads += 1;
      const rows = detached || inventoryReads > 2
        ? [{ fd: 12, raised: true, uri: "ptrace://${stalePid}" }]
        : [
            { fd: 12, raised: true, uri: "ptrace://${stalePid}" },
            { fd: 13, raised: true, uri: "ptrace://${livePid}" },
          ];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 13") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createReusedPidAfterDetachProvider = async (
  pid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-reused-pid-after-detach.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let inventoryReads = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventoryReads += 1;
      const row = detached
        ? inventoryReads > 2 ? [] : [{ fd: 13, raised: true, uri: "ptrace://${pid}" }]
        : [{ fd: 12, raised: true, uri: "ptrace://${pid}" }];
      process.stdout.write(JSON.stringify(row) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createOmittedInferiorProvider = async (
  firstPid: number,
  retainedPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-omitted-inferior.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const rows = detached ? [] : inventory === 1
        ? [{ fd: 12, raised: true, uri: "ptrace://${firstPid}" }, { fd: 13, raised: true, uri: "ptrace://${retainedPid}" }]
        : [{ fd: 13, raised: true, uri: "ptrace://${retainedPid}" }];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("o- ")) detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const createNewOmittedInferiorProvider = async (
  firstPid: number,
  newPid: number,
  commandsPath: string,
): Promise<string> => {
  const provider = join(directory!, "fake-rizin-new-omitted-inferior.mjs");
  await writeFile(
    provider,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const rows = inventory === 1
        ? [{ fd: 12, raised: true, uri: "ptrace://${firstPid}" }]
        : inventory === 2
          ? [{ fd: 13, raised: true, uri: "ptrace://${newPid}" }]
          : [];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

it("keeps persistent Rizin sessions unavailable on Windows", async () => {
  const rizin = await createRizinTestManager(
    { REA_RIZIN_COMMAND: "/missing/rizin" },
    { platform: "win32" },
  ).start({
    path: "/tmp/fixture.bin",
    inferior_tty: "unused-before-platform-admission",
  });
  expect(rizin.ok).toBe(false);
  if (!rizin.ok) {
    expect(rizin.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(rizin.error.message).toContain("Linux /proc descriptor readback");
  }
});

it.skipIf(process.platform === "win32")(
  "rejects startup when Rizin exits immediately after its initial frame",
  async () => {
    const injected = createInjectedProcess({
      startup: (control) => {
        control.output(Buffer.from("startup diagnostic\0partial trailing"));
        control.exit();
      },
    });
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess },
    );
    managers.push(manager);

    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(started.error.message).toContain("exited");
      expect(started.error.message).not.toContain("timed out");
      expect(started.error.capturedOutput).toMatchObject({
        stdout: "startup diagnostic\npartial trailing",
        stderr: "",
        truncated: false,
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves partial Rizin stdout when startup times out before its first frame",
  async () => {
    const injected = createInjectedProcess({
      startup: (control) => control.output("partial startup diagnostic"),
    });
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess, startupTimeoutMs: 25 },
    );
    managers.push(manager);

    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error._tag).toBe("AnalysisTimeoutError");
      expect(started.error.capturedOutput).toMatchObject({
        stdout: expect.stringContaining("partial startup diagnostic"),
        stderr: "",
        truncated: false,
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps session UTF-8 status cumulative while command evidence reports only its frames",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-utf8-scope-"));
    const provider = join(directory, "fake-rizin-command-utf8-scope.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write(Buffer.from([0xff, 0]));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "invalid-output") process.stdout.write(Buffer.from([0xfe, 0]));
    else if (!line.startsWith("!echo ")) process.stdout.write("valid output\\0");
    else process.stdout.write(line.slice(6) + "\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;

    expect(manager.status(sessionId)?.output_invalid_utf8).toBe(true);
    const firstValid = await manager.execute(sessionId, "valid-before-invalid");
    expect(firstValid.ok).toBe(true);
    if (firstValid.ok) {
      expect(firstValid.value.result).not.toHaveProperty("output_invalid_utf8");
      expect(firstValid.value.evidence.raw_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(firstValid.value.evidence.normalized_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(firstValid.value.evidence.limitations.join(" ")).not.toContain(
        "Collected command frames contained invalid UTF-8 bytes",
      );
    }

    const invalid = await manager.execute(sessionId, "invalid-output");
    expect(invalid.ok).toBe(true);
    if (invalid.ok) {
      expect(invalid.value.result.output_invalid_utf8).toBe(true);
      expect(invalid.value.evidence.raw_result).toMatchObject({
        output_invalid_utf8: true,
      });
      expect(invalid.value.evidence.normalized_result).toMatchObject({
        output_invalid_utf8: true,
      });
      expect(invalid.value.evidence.limitations.join(" ")).toContain(
        "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
      );
    }

    const laterValid = await manager.execute(sessionId, "valid-after-invalid");
    expect(laterValid.ok).toBe(true);
    if (laterValid.ok) {
      expect(laterValid.value.result).not.toHaveProperty("output_invalid_utf8");
      expect(laterValid.value.evidence.raw_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(laterValid.value.evidence.normalized_result).not.toHaveProperty(
        "output_invalid_utf8",
      );
      expect(laterValid.value.evidence.limitations.join(" ")).not.toContain(
        "Collected command frames contained invalid UTF-8 bytes",
      );
    }
    expect(manager.status(sessionId)?.output_invalid_utf8).toBe(true);
  },
);

it.skipIf(process.platform !== "linux")(
  "reuses a successful Rizin detach that completed after the cleanup timeout",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-late-detach-"));
    const completionPath = join(directory, "complete");
    const provider = await createLateDetachProvider(
      pid,
      directory,
      completionPath,
    );
    let resolveDetachVerified!: (value: boolean) => void;
    const detachVerified = new Promise<boolean>((resolve) => {
      resolveDetachVerified = resolve;
    });
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        onInferiorDetachVerified: (result: { readonly status: string }) =>
          resolveDetachVerified(result.status === "detached"),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const firstClose = await manager.close(started.value.session_id);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok)
      expect(firstClose.error.message).toContain("not verified within 1000 ms");

    const completion = await Promise.race([
      detachVerified,
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 4_000),
      ),
    ]);
    expect(completion).toBe(true);
    expect(await readFile(completionPath, "utf8")).toBe("done");

    const retried = await manager.retryCleanupFailures();
    expect(
      retried,
      JSON.stringify(manager.status(started.value.session_id)),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "reconciles a stale Rizin PID row only when the replacement is not traced by the owned debugger",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-reused-pid-"));
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidPtraceProvider(
      45_678,
      directory,
      commandsPath,
    );
    const identitySequence = ["100", "100"];
    const identityObservations: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const observed = identitySequence.shift() ?? "200";
          identityObservations.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => 0,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });

    expect(identityObservations[0]).toBe("100");
    expect(
      identityObservations.slice(2).every((value) => value === "200"),
    ).toBe(true);
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 12");
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not retain a first-seen Rizin PID row owned by a foreign tracer",
  async () => {
    const stalePid = 45_680;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-foreign-first-row-"));
    const provider = await createRetryEmptyInventoryProvider(stalePid);
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => "200",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const closed = await manager.close(started.value.session_id);

    expect(closed.ok, closed.ok ? "" : closed.error.message).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "reconciles a PID reused between its first absent read and identity confirmation",
  async () => {
    const pid = 45_681;
    const provider = await createRetryEmptyInventoryProvider(pid);
    const startTimes: Array<string | null> = [null, "200", "200", null];
    const tracerReads: string[] = [];
    const outcomes: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (observedPid) => {
          expect(observedPid).toBe(String(pid));
          return startTimes.shift() ?? null;
        },
        readProcessTracerPid: async (observedPid) => {
          tracerReads.push(observedPid);
          return 777;
        },
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            const detached = await session.detachInferior?.();
            outcomes.push(detached?.status ?? "missing-detach");
          } catch (cause) {
            outcomes.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect(tracerReads).toContain(String(pid));
    expect(outcomes[0]).toContain("disappeared or was reused during detach");
  },
);

it.skipIf(process.platform !== "linux")(
  "retains selected detach proof while another active inferior blocks cleanup",
  async () => {
    const tty = await rizinTestInferiorTty();
    const selected = await spawnTestInferiorOnTty(tty);
    const additional = await spawnTestInferiorOnTty(tty);
    const selectedPid = selected.pid;
    const additionalPid = additional.pid;
    expect(selectedPid).toBeDefined();
    expect(additionalPid).toBeDefined();
    if (selectedPid === undefined || additionalPid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-active-row-retry-"));
    const commandsPath = join(directory, "commands");
    const provider = await createAdditionalActiveAfterDetachProvider(
      selectedPid,
      additionalPid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(selected.exitCode).toBeNull();

    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(selected.exitCode).toBeNull();

    const additionalExit = new Promise<void>((resolve) =>
      additional.once("exit", () => resolve()),
    );
    additional.kill("SIGTERM");
    await additionalExit;
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(selected.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "invalidates selected detach proof when a stale selected row hides another active inferior",
  async () => {
    const tty = await rizinTestInferiorTty();
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-stale-proof-retry-"));
    const sinksClosedMarker = join(directory, "selected-sinks-closed");
    const selected = await spawnTestInferiorOnTty(tty, true, sinksClosedMarker);
    const additional = await spawnTestInferiorOnTty(tty);
    const selectedPid = selected.pid;
    const additionalPid = additional.pid;
    expect(selectedPid).toBeDefined();
    expect(additionalPid).toBeDefined();
    if (selectedPid === undefined || additionalPid === undefined) return;
    const commandsPath = join(directory, "commands");
    const provider = await createStaleSelectedRowWithActiveAdditionalProvider(
      selectedPid,
      additionalPid,
      commandsPath,
    );
    const selectedTracerReads = new Map<string, number>();
    const detachResults: OwnedDebuggerDetachResult[] = [];
    const { manager, sessionId } = await startRizinWithOwnedStop(
      provider,
      async (pid) => {
        if (pid === String(additionalPid))
          return additional.exitCode === null ? 777 : 0;
        if (pid !== String(selectedPid)) return 777;
        const reads = selectedTracerReads.get(pid) ?? 0;
        selectedTracerReads.set(pid, reads + 1);
        return reads === 0 ? 777 : 0;
      },
      (result) => detachResults.push(result),
    );

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(selected.exitCode).toBeNull();
    expect(additional.exitCode).toBeNull();

    const additionalExit = new Promise<void>((resolve) =>
      additional.once("exit", () => resolve()),
    );
    additional.kill("SIGTERM");
    await additionalExit;
    selected.kill("SIGUSR1");
    const sinksClosedDeadline = Date.now() + 2_000;
    while (Date.now() < sinksClosedDeadline) {
      try {
        if ((await readFile(sinksClosedMarker, "utf8")) === "closed") break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(await readFile(sinksClosedMarker, "utf8")).toBe("closed");
    await expect(readlink(`/proc/${selectedPid}/fd/1`)).rejects.toThrow();
    await expect(readlink(`/proc/${selectedPid}/fd/2`)).rejects.toThrow();
    const retry = await manager.retryCleanupFailures();
    expect(retry.ok).toBe(false);
    expect(detachResults).toEqual([]);
    expect(selected.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "reconciles a completed detach after its first inventory readback is malformed",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-detach-readback-retry-"),
    );
    const commandsPath = join(directory, "commands");
    const provider = await createMalformedDetachReadbackProvider(
      pid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);
    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(inferior.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "retries detach after a definitive readback still shows the selected inferior",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-retryable-detach-"));
    const commandsPath = join(directory, "commands");
    const provider = await createRetryableDetachProvider(pid, commandsPath);
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sessionId = started.value.session_id;

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(inferior.exitCode).toBeNull();

    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(2);
    expect(inferior.exitCode).toBeNull();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "preserves confirmed detach when an unrelated stale Rizin row survives readback",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const livePid = inferior.pid;
    expect(livePid).toBeDefined();
    if (livePid === undefined) return;
    const stalePid = 45_678;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-stale-row-readback-"));
    const commandsPath = join(directory, "commands");
    const provider = await createStaleRowAfterDetachProvider(
      stalePid,
      livePid,
      commandsPath,
    );
    const staleIdentityReads = ["100", "100", "200", "200"];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid !== String(stalePid)) return "300";
          return staleIdentityReads.shift() ?? "200";
        },
        readProcessTracerPid: async (pid) => {
          if (pid !== String(livePid)) return 0;
          const commands = await readFile(commandsPath, "utf8").catch(() => "");
          return commands.includes("o- 13\n") ? 0 : 777;
        },
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(true);

    const commands = await readFile(commandsPath, "utf8");
    expect(commands.match(/^o- 13$/gm)).toHaveLength(1);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not retain PIDs already reconciled from contradictory detach readbacks",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const selectedPid = inferior.pid;
    expect(selectedPid).toBeDefined();
    if (selectedPid === undefined) return;
    const foreignPid = 45_678;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-disproved-readback-"));
    const commandsPath = join(directory, "commands");
    const provider = join(directory, "fake-rizin-disproved-readback.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let detached = false;
let contradictoryReadbackUsed = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      if (!detached) process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }]) + "\\0");
      else if (!contradictoryReadbackUsed) {
        contradictoryReadbackUsed = true;
        process.stdout.write(JSON.stringify([{ fd: 13, raised: true, uri: "ptrace://${foreignPid}" }]) + "\\0");
      }
      else process.stdout.write("[]\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    let foreignPidReads = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid === String(foreignPid)) {
            foreignPidReads += 1;
            return null;
          }
          return "100";
        },
        readProcessTracerPid: async (pid) =>
          pid === String(selectedPid) &&
          (await readFile(commandsPath, "utf8").catch(() => "")).includes(
            "o- 12\n",
          )
            ? 0
            : 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(true);
    expect(foreignPidReads).toBe(2);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps cleanup unknown after an oversized inferior readback without scanning its PIDs",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const selectedPid = inferior.pid;
    expect(selectedPid).toBeDefined();
    if (selectedPid === undefined) return;
    const oversizedRows = Array.from({ length: 1025 }, (_, index) => ({
      fd: index + 13,
      raised: true,
      uri: `ptrace://${index + 1000}`,
    }));
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-inventory-overflow-"));
    const provider = join(directory, "fake-rizin-inventory-overflow.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
const oversizedRows = ${JSON.stringify(oversizedRows)};
let input = "";
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") process.stdout.write((detached ? JSON.stringify(oversizedRows) : JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${selectedPid}" }])) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    let unrelatedPidReads = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid === String(selectedPid)) return "100";
          unrelatedPidReads += 1;
          return null;
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(true);
    expect(await manager.retryCleanupFailures()).toMatchObject({ ok: false });
    expect(manager.status(started.value.session_id)).toBeDefined();
    expect(unrelatedPidReads).toBe(0);
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains a replacement process when detach readback reuses the selected PID",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-detach-reused-pid-"));
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidAfterDetachProvider(
      pid,
      commandsPath,
    );
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const commands = await readFile(commandsPath, "utf8").catch(() => "");
          return commands.includes("o- 12\n") ? "200" : "100";
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(started.value.session_id)).toBeDefined();
    expect(inferior.exitCode).toBeNull();
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
  },
);

it.skipIf(process.platform !== "linux")(
  "does not ignore a reused PID that appears after a transient identity read failure",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const livePid = inferior.pid;
    expect(livePid).toBeDefined();
    if (livePid === undefined) return;
    const stalePid = 45_679;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-reused-row-readback-"));
    const commandsPath = join(directory, "commands");
    const provider = await createStaleRowAfterDetachProvider(
      stalePid,
      livePid,
      commandsPath,
    );
    const staleIdentityReads: Array<string | null> = [
      "100", // first observed identity
      "100", // stable identity check for the stale first row
      "200", // reused PID during retry inventory
      "200", // replacement identity recheck
      null, // transient disappearance in post-detach inventory
      "300", // a different identity appears at the same PID
      "300", // replacement identity stability check
    ];
    const tracerPids = [0, 777];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid !== String(stalePid)) return "300";
          const next = staleIdentityReads.shift();
          return next === undefined ? "300" : next;
        },
        readProcessTracerPid: async (pid) =>
          pid === String(livePid) ? 777 : (tracerPids.shift() ?? 777),
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);

    const commands = await readFile(commandsPath, "utf8");
    expect(commands.match(/^o- 13$/gm)).toHaveLength(1);
    expect(manager.status(started.value.session_id)).toBeDefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains every mismatched post-detach ptrace row identity across retries",
  async () => {
    const tty = await rizinTestInferiorTty();
    const selected = await spawnTestInferiorOnTty(tty);
    const mismatched = await spawnTestInferiorOnTty(tty);
    expect(selected.pid).toBeDefined();
    expect(mismatched.pid).toBeDefined();
    if (selected.pid === undefined || mismatched.pid === undefined) return;

    directory = await mkdtemp(join(tmpdir(), "rea-rizin-mismatched-row-"));
    const commandsPath = join(directory, "commands");
    const provider = join(directory, "fake-rizin-mismatched-row.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventoryReads = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventoryReads += 1;
      const rows = inventoryReads === 1
        ? [{ fd: 12, raised: true, uri: "ptrace://${selected.pid}" }]
        : inventoryReads === 2
          ? [{ fd: 12, raised: true, uri: "ptrace://${mismatched.pid}" }]
          : [];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") process.kill(${selected.pid}, "SIGTERM");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    const detachOutcomes: string[] = [];
    let failMismatchedIdentityRead = true;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        readProcessStartTime: async (pid) => {
          if (pid === String(selected.pid))
            return selected.exitCode === null && selected.signalCode === null
              ? "100"
              : null;
          if (pid === String(mismatched.pid)) {
            if (failMismatchedIdentityRead) {
              failMismatchedIdentityRead = false;
              throw new Error("injected transient identity read failure");
            }
            return mismatched.exitCode === null &&
              mismatched.signalCode === null
              ? "200"
              : null;
          }
          throw new Error(`unexpected PID ${pid}`);
        },
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          if (session.detachInferior === undefined) {
            detachOutcomes.push("missing-detach");
            return { status: "incomplete", reason: "missing-detach" };
          }
          try {
            detachOutcomes.push(
              (await session.detachInferior())?.status ?? "missing-detach",
            );
          } catch (cause) {
            detachOutcomes.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const selectedExit = new Promise<void>((resolve) =>
      selected.once("exit", () => resolve()),
    );
    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    await selectedExit;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachOutcomes.at(-1)).toContain(
      `omitted unresolved inferior PID ${mismatched.pid}`,
    );
    expect(mismatched.exitCode).toBeNull();
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);

    const mismatchedExit = new Promise<void>((resolve) =>
      mismatched.once("exit", () => resolve()),
    );
    mismatched.kill("SIGTERM");
    await mismatchedExit;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachOutcomes.at(-1)).toBe("no-inferior");
  },
);

it.skipIf(process.platform !== "linux")(
  "reconciles an immediate untraced selected row without repeating detach",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    expect(inferior.pid).toBeDefined();
    if (inferior.pid === undefined) return;

    directory = await mkdtemp(join(tmpdir(), "rea-rizin-immediate-untraced-"));
    const commandsPath = join(directory, "commands");
    const provider = join(directory, "fake-rizin-immediate-untraced.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${inferior.pid}" }]) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let detachResult: string | undefined;
    let identityReads = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => (identityReads++ === 0 ? 777 : 0),
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          if (session.detachInferior === undefined) {
            detachResult = "missing-detach";
            return { status: "incomplete", reason: detachResult };
          }
          try {
            const result = await session.detachInferior();
            detachResult = result?.status ?? "missing-detach";
            return result?.status === "detached"
              ? { status: "stopped" }
              : { status: "incomplete", reason: "detach was not confirmed" };
          } catch (cause) {
            detachResult =
              cause instanceof Error ? cause.message : String(cause);
            return { status: "incomplete", reason: detachResult };
          }
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(await manager.close(started.value.session_id)).toEqual({
      ok: true,
      value: { target_state: "unknown" },
    });
    expect(detachResult).toBe("detached");
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retries descriptor verification after Rizin confirms detach without detaching twice",
  async () => {
    const ttyPath = await rizinTestInferiorTty();
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-detached-sink-test-"));
    const statePath = join(directory, "inferior-input-state");
    const commandsPath = join(directory, "commands");
    const inferior = await spawnTestInferiorWithMutableInput(
      ttyPath,
      statePath,
    );
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createPostDetachInputTransitionProvider(
      pid,
      commandsPath,
    );
    const { manager, sessionId } = await startRizinWithOwnedStop(provider);
    expect(sessionId).toBeDefined();
    if (sessionId === undefined) return;

    const firstClose = await manager.close(sessionId);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(true);
    await expect.poll(() => readFile(statePath, "utf8")).toBe("unclassified");

    inferior.kill("SIGUSR2");
    await expect.poll(() => readFile(statePath, "utf8")).toBe("restored");
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains cleanup when a live detached inferior loses its TTY descriptors",
  async () => {
    const ttyPath = await rizinTestInferiorTty();
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-detached-live-sink-"));
    const statePath = join(directory, "inferior-input-state");
    const commandsPath = join(directory, "commands");
    const inferior = await spawnTestInferiorWithMutableInput(
      ttyPath,
      statePath,
    );
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createPostDetachInputTransitionProvider(
      pid,
      commandsPath,
    );
    let tracerReads = 0;
    const { manager, sessionId } = await startRizinWithOwnedStop(
      provider,
      async () => (tracerReads++ === 0 ? 777 : 0),
    );
    expect(sessionId).toBeDefined();
    if (sessionId === undefined) return;

    const close = await manager.close(sessionId);
    expect(close.ok).toBe(false);
    if (!close.ok) expect(close.error.cleanupIncomplete).toBe(true);
    await expect.poll(() => readFile(statePath, "utf8")).toBe("unclassified");
    expect(tracerReads).toBeGreaterThan(0);
    expect(manager.status(sessionId)?.state).toBe("closed");
    expect(
      (await readFile(commandsPath, "utf8")).match(/^o- 12$/gm),
    ).toHaveLength(1);
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "re-verifies output policy and descriptors for a replacement traced by the owned debugger",
  async () => {
    const inferior = await spawnTestInferiorOnTty(await rizinTestInferiorTty());
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-attached-replacement-"),
    );
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidPtraceProvider(
      pid,
      directory,
      commandsPath,
    );
    const identityObservations: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const observed = identityObservations.length === 0 ? "100" : "200";
          identityObservations.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });

    expect(identityObservations[0]).toBe("100");
    expect(
      identityObservations.slice(1).every((value) => value === "200"),
    ).toBe(true);
    expect(await readFile(commandsPath, "utf8")).toContain("o- 12");
    expect(manager.status(started.value.session_id)).toBeUndefined();
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains cleanup when Rizin cannot determine whether a replacement is still traced",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-unknown-replacement-"));
    const commandsPath = join(directory, "commands");
    const provider = await createReusedPidPtraceProvider(
      45_678,
      directory,
      commandsPath,
    );
    const identityObservations: string[] = [];
    let tracerKnown = false;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async () => {
          const observed = identityObservations.length === 0 ? "100" : "200";
          identityObservations.push(observed);
          return observed;
        },
        readProcessTracerPid: async () => {
          if (!tracerKnown) throw new Error("injected unreadable TracerPid");
          return 0;
        },
        readProcessTaskIds: async () => new Set(),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 12");
    expect(manager.status(started.value.session_id)?.state).toBe("closed");

    tracerKnown = true;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not forget an active inferior after descriptor failure and an empty retry inventory",
  async () => {
    const inferior = await spawnTestInferior();
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createRetryEmptyInventoryProvider(pid);
    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            const detached = await session.detachInferior?.();
            detachResults.push(detached?.status ?? "missing-detach-capability");
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);

    expect(detachResults).toHaveLength(2);
    expect(detachResults[0]).toContain("descriptor 1");
    expect(detachResults[1]).toContain("still active");
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform !== "linux")(
  "retains a newly observed PID when identity lookup fails before an empty retry inventory",
  async () => {
    const inferior = await spawnTestInferior();
    expect(inferior.pid).toBeDefined();
    if (inferior.pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-new-pending-identity-"),
    );
    const provider = join(directory, "fake-rizin-new-pending-identity.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") {
      inventory += 1;
      process.stdout.write((inventory === 1
        ? JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${inferior.pid}" }])
        : "[]") + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let identityReads = 0;
    const outcomes: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          expect(pid).toBe(String(inferior.pid));
          if (identityReads++ === 0)
            throw new Error("transient identity read failure for new PID");
          return inferior.exitCode === null && inferior.signalCode === null
            ? "100"
            : null;
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            outcomes.push(
              (await session.detachInferior?.())?.status ?? "missing-detach",
            );
          } catch (cause) {
            outcomes.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect(outcomes[0]).toContain("transient identity read failure");
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(outcomes[1]).toContain(
      `omitted unresolved inferior PID ${inferior.pid}`,
    );
    expect(outcomes[1]).not.toBe("no-inferior");
    expect(inferior.exitCode).toBeNull();

    const inferiorExit = new Promise<void>((resolve) =>
      inferior.once("exit", () => resolve()),
    );
    inferior.kill("SIGTERM");
    await inferiorExit;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(outcomes[2]).toBe("no-inferior");
  },
);

it.skipIf(process.platform !== "linux").each([
  { name: "untraced replacement", tracerPid: 0, closeSucceeds: true },
  { name: "replacement traced by Rizin", tracerPid: 777, closeSucceeds: false },
])(
  "reconciles an omitted pending PID against a $name",
  async ({ tracerPid, closeSucceeds }) => {
    const inferior = await spawnTestInferior();
    expect(inferior.pid).toBeDefined();
    if (inferior.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-pending-reused-pid-"));
    const provider = join(directory, "fake-rizin-pending-reused-pid.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") {
      inventory += 1;
      process.stdout.write((inventory === 1
        ? JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${inferior.pid}" }])
        : "[]") + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let identityReads = 0;
    let tracerReads = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          expect(pid).toBe(String(inferior.pid));
          if (identityReads++ === 0)
            throw new Error("transient identity read failure before PID reuse");
          return "200";
        },
        readProcessTracerPid: async () => {
          tracerReads += 1;
          return tracerPid;
        },
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    const retried = await manager.retryCleanupFailures();
    expect(retried.ok).toBe(closeSucceeds);
    expect(tracerReads).toBeGreaterThan(0);
    if (closeSucceeds) expect(inferior.exitCode).toBeNull();
    else expect(manager.status(started.value.session_id)).toBeDefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps a partially observed PID unknown until identity or exit is proven",
  async () => {
    const inferior = await spawnTestInferior();
    expect(inferior.pid).toBeDefined();
    if (inferior.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-pending-identity-"));
    const provider = join(directory, "fake-rizin-pending-identity.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") {
      inventory += 1;
      process.stdout.write((inventory === 1
        ? JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${inferior.pid}" }, {}])
        : "[]") + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    let identityReads = 0;
    const outcomes: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          expect(pid).toBe(String(inferior.pid));
          identityReads += 1;
          if (identityReads === 1)
            throw new Error("transient identity read failure");
          return "100";
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            outcomes.push(
              (await session.detachInferior?.())?.status ?? "missing-detach",
            );
          } catch (cause) {
            outcomes.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(outcomes.at(-1)).toContain("identity");
    expect(outcomes.at(-1)).not.toBe("no-inferior");
    expect(inferior.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains a later valid PID while reconciling a pending PID omitted after a partial inventory",
  async () => {
    const earlier = await spawnTestInferior();
    const later = await spawnTestInferior();
    expect(earlier.pid).toBeDefined();
    expect(later.pid).toBeDefined();
    if (earlier.pid === undefined || later.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-pending-pid-order-"));
    const commandsPath = join(directory, "commands");
    const provider = join(directory, "fake-rizin-pending-pid-order.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const output = inventory === 1
        ? JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${earlier.pid}" }, {}])
        : inventory === 2
          ? JSON.stringify([{ fd: 13, raised: true, uri: "ptrace://${later.pid}" }])
          : "[]";
      process.stdout.write(output + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let earlierIdentityReads = 0;
    let earlierIdentityReadFailed = false;
    const outcomes: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid === String(earlier.pid)) {
            if (earlierIdentityReads++ === 0) {
              earlierIdentityReadFailed = true;
              throw new Error(
                "transient identity read failure for earlier PID",
              );
            }
            return earlier.exitCode === null && earlier.signalCode === null
              ? "100"
              : null;
          }
          if (pid === String(later.pid))
            return later.exitCode === null && later.signalCode === null
              ? "200"
              : null;
          throw new Error(`unexpected PID ${pid}`);
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            outcomes.push(
              (await session.detachInferior?.())?.status ?? "missing-detach",
            );
          } catch (cause) {
            outcomes.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(earlierIdentityReadFailed).toBe(true);
    expect(outcomes[0]).toContain("malformed descriptor row");
    expect(outcomes[1]).toContain(
      `omitted unresolved inferior PID ${earlier.pid}`,
    );

    const earlierExit = new Promise<void>((resolve) =>
      earlier.once("exit", () => resolve()),
    );
    earlier.kill("SIGTERM");
    await earlierExit;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(outcomes[2]).toContain(
      `omitted unresolved inferior PID ${later.pid}`,
    );
    expect(outcomes[2]).not.toBe("no-inferior");
    expect(later.exitCode).toBeNull();
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- ");

    const laterExit = new Promise<void>((resolve) =>
      later.once("exit", () => resolve()),
    );
    later.kill("SIGTERM");
    await laterExit;
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(outcomes[3]).toBe("no-inferior");
  },
);

it.skipIf(process.platform !== "linux")(
  "retains valid PIDs after a malformed ptrace row before an empty retry inventory",
  async () => {
    const retained = await spawnTestInferiorOnTty(await rizinTestInferiorTty());
    expect(retained.pid).toBeDefined();
    if (retained.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-malformed-partial-"));
    const commandsPath = join(directory, "commands");
    const provider = join(directory, "fake-rizin-malformed-partial.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const output = inventory === 1
        ? JSON.stringify([{}, { fd: 13, raised: true, uri: "ptrace://${retained.pid}" }])
        : "[]";
      process.stdout.write(output + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            detachResults.push(
              (await session.detachInferior?.())?.status ?? "missing-detach",
            );
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults.at(-1)).toContain(
      `identified PID ${retained.pid} is still active`,
    );
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 13");
    expect(retained.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not stop Rizin while a retained inferior is omitted from a non-empty retry inventory",
  async () => {
    const omitted = await spawnTestInferior();
    const retained = await spawnTestInferiorOnTty(await rizinTestInferiorTty());
    expect(omitted.pid).toBeDefined();
    expect(retained.pid).toBeDefined();
    if (omitted.pid === undefined || retained.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-omitted-inferior-"));
    const commandsPath = join(directory, "commands");
    const provider = await createOmittedInferiorProvider(
      omitted.pid,
      retained.pid,
      commandsPath,
    );
    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            detachResults.push(
              (await session.detachInferior?.())?.status ??
                "missing-detach-capability",
            );
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[0]).toContain(
      "multiple or ambiguous ptrace inferiors",
    );
    expect(detachResults[1]).toContain(
      `omitted retained inferior PID ${omitted.pid} from the ptrace inventory while it is still active`,
    );
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 13");

    omitted.kill("SIGTERM");
    await new Promise<void>((resolve) => omitted.once("exit", () => resolve()));
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[2]).toBe("detached");
    expect(await readFile(commandsPath, "utf8")).toContain("o- 13");
  },
);

it.skipIf(process.platform !== "linux")(
  "retains an omitted PID replacement traced by the owned Rizin debugger",
  async () => {
    const omitted = await spawnTestInferior();
    const retained = await spawnTestInferiorOnTty(await rizinTestInferiorTty());
    expect(omitted.pid).toBeDefined();
    expect(retained.pid).toBeDefined();
    if (omitted.pid === undefined || retained.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-omitted-replacement-"));
    const commandsPath = join(directory, "commands");
    const provider = join(directory, "fake-rizin-omitted-replacement.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
let inventory = 0;
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    appendFileSync(${JSON.stringify(commandsPath)}, line + "\\n");
    if (line === "olj") {
      inventory += 1;
      const rows = detached ? [] : inventory === 1
        ? [
            { fd: 12, raised: true, uri: "ptrace://${omitted.pid}" },
            { fd: 13, raised: true, uri: "ptrace://${retained.pid}" },
          ]
        : [{ fd: 13, raised: true, uri: "ptrace://${retained.pid}" }];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 13") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    const outcomes: string[] = [];
    let omittedIdentityReads = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          if (pid === String(omitted.pid))
            return omittedIdentityReads++ < 2 ? "100" : "200";
          if (pid === String(retained.pid)) return "300";
          throw new Error(`unexpected PID ${pid}`);
        },
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            outcomes.push(
              (await session.detachInferior?.())?.status ?? "missing-detach",
            );
          } catch (cause) {
            outcomes.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(outcomes[0]).toContain("multiple or ambiguous ptrace inferiors");
    expect(outcomes[1]).toContain(
      `omitted retained inferior PID ${omitted.pid} from the ptrace inventory while it is still active`,
    );
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 13");
    expect(omitted.exitCode).toBeNull();
    expect(retained.exitCode).toBeNull();
  },
);

it.skipIf(process.platform !== "linux")(
  "retains newly observed inferiors when a retry omits an earlier active target",
  async () => {
    const omitted = await spawnTestInferior();
    const newlyObserved = await spawnTestInferiorOnTty(
      await rizinTestInferiorTty(),
    );
    expect(omitted.pid).toBeDefined();
    expect(newlyObserved.pid).toBeDefined();
    if (omitted.pid === undefined || newlyObserved.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-new-omitted-"));
    const commandsPath = join(directory, "commands");
    const provider = await createNewOmittedInferiorProvider(
      omitted.pid,
      newlyObserved.pid,
      commandsPath,
    );
    const detachResults: string[] = [];
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          try {
            detachResults.push(
              (await session.detachInferior?.())?.status ??
                "missing-detach-capability",
            );
          } catch (cause) {
            detachResults.push(
              cause instanceof Error ? cause.message : String(cause),
            );
          }
          return { status: "incomplete", reason: "injected retained debugger" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[0]).toContain("descriptor 1");
    expect(detachResults[1]).toContain(
      `omitted retained inferior PID ${omitted.pid}`,
    );

    omitted.kill("SIGTERM");
    await new Promise<void>((resolve) => omitted.once("exit", () => resolve()));
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[2]).toContain(
      `identified PID ${newlyObserved.pid} is still active`,
    );
    expect(await readFile(commandsPath, "utf8")).not.toContain("o- 13");

    newlyObserved.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      newlyObserved.once("exit", () => resolve()),
    );
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(detachResults[3]).toBe("no-inferior");
  },
);

it.skipIf(process.platform !== "linux")(
  "clears retained Rizin cleanup after its identified inferior exits",
  async () => {
    const inferior = await spawnTestInferior();
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createInferiorInventoryProvider([{ fd: 12, pid }]);
    const { manager, sessionId, exitDebugger } =
      await startRizinWithOwnedStop(provider);
    if (sessionId === undefined) return;

    const firstClose = await manager.close(sessionId);

    expect(firstClose.ok, JSON.stringify(firstClose)).toBe(false);
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(true);
    await exitDebugger();
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(manager.status(sessionId)?.state).toBe("closed");

    const inferiorExited = new Promise<void>((resolveExit) =>
      inferior.once("exit", () => resolveExit()),
    );
    inferior.kill("SIGTERM");
    await inferiorExited;
    const retried = await manager.retryCleanupFailures();

    expect(retried).toEqual({ ok: true, value: null });
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(false);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "releases Rizin cleanup after complete rows reject detach and all known inferiors end",
  async () => {
    const tty = await rizinTestInferiorTty();
    const inferior = await spawnTestInferiorOnTty(tty);
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-ended-after-row-reject-"),
    );
    const provider = join(directory, "fake-rizin-ended-after-row-reject.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let detached = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") process.stdout.write(JSON.stringify([{ fd: detached ? 13 : 12, raised: true, uri: "ptrace://${pid}" }]) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") detached = true;
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let debuggerProcess: ProviderProcessHandle | undefined;
    let stopCalls = 0;
    let stateAfterDebuggerExit: boolean | undefined;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          debuggerProcess = launched.process;
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          if (stopCalls++ === 0) {
            await expect(session.detachInferior?.()).rejects.toThrow(
              "did not confirm that the selected inferior FD was detached",
            );
            debuggerProcess!.kill("SIGTERM");
            expect(await session.supervisor.waitForExit(1_000)).toBe(true);
            stateAfterDebuggerExit =
              (await session.verifyInferiorsEndedAfterExit?.()) === true;
            return { status: "incomplete", reason: "inferior remains active" };
          }
          stateAfterDebuggerExit =
            (await session.verifyInferiorsEndedAfterExit?.()) === true;
          return stateAfterDebuggerExit
            ? { status: "stopped" }
            : { status: "incomplete", reason: "inferior remains active" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sessionId = started.value.session_id;

    expect((await manager.close(sessionId)).ok).toBe(false);
    expect(stateAfterDebuggerExit).toBe(false);
    expect(manager.status(sessionId)).toBeDefined();
    expect(inferior.exitCode).toBeNull();

    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(stateAfterDebuggerExit).toBe(false);
    const inferiorExit = new Promise<void>((resolveExit) =>
      inferior.once("exit", () => resolveExit()),
    );
    inferior.kill("SIGTERM");
    await inferiorExit;

    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(stateAfterDebuggerExit).toBe(true);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not release Rizin cleanup after a later inventory leaves a reported PID unresolved",
  async () => {
    const tty = await rizinTestInferiorTty();
    const detached = await spawnTestInferiorOnTty(tty);
    const unresolved = await spawnTestInferiorOnTty(tty);
    expect(detached.pid).toBeDefined();
    expect(unresolved.pid).toBeDefined();
    if (detached.pid === undefined || unresolved.pid === undefined) return;
    directory = await mkdtemp(
      join(tmpdir(), "rea-rizin-pending-after-detach-"),
    );
    const provider = join(directory, "fake-rizin-pending-after-detach.mjs");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
let input = "";
let inventory = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n"); if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "olj") {
      inventory += 1;
      const rows = inventory === 1
        ? [{ fd: 12, raised: true, uri: "ptrace://${detached.pid}" }]
        : [{ fd: 13, raised: true, uri: "ptrace://${unresolved.pid}" }];
      process.stdout.write(JSON.stringify(rows) + "\\0");
    }
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line === "o- 12") process.stdout.write("detached\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let unresolvedReadFailed = false;
    let unresolvedIdentityReadFails = true;
    let inventoryUnknownAfterFailedRead: boolean | undefined;
    let cleanupAfterDebuggerExit: boolean | undefined;
    let cleanupWhileUnresolvedInferiorAlive: boolean | undefined;
    let cleanupAfterUnresolvedInferiorExit: boolean | undefined;
    let cleanupAfterKnownInferiorExit: boolean | undefined;
    let stopCalls = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessTracerPid: async () => 777,
        readProcessTaskIds: async () => new Set(["777"]),
        readProcessStartTime: async (pid) => {
          if (pid === String(unresolved.pid)) {
            unresolvedReadFailed = true;
            if (unresolvedIdentityReadFails)
              throw new Error(
                "injected identity read failure for later inferior",
              );
            return unresolved.exitCode === null &&
              unresolved.signalCode === null
              ? "200"
              : null;
          }
          return detached.exitCode === null && detached.signalCode === null
            ? "100"
            : null;
        },
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          if (stopCalls++ > 0) {
            cleanupAfterUnresolvedInferiorExit =
              (await session.verifyInferiorsEndedAfterExit?.()) === true;
            if (stopCalls > 2)
              cleanupAfterKnownInferiorExit =
                cleanupAfterUnresolvedInferiorExit;
            return cleanupAfterUnresolvedInferiorExit
              ? { status: "stopped" }
              : { status: "incomplete", reason: "unresolved inferior remains" };
          }
          try {
            await session.detachInferior?.();
          } catch {
            // The later valid inventory is deliberately unresolved.
          }
          inventoryUnknownAfterFailedRead =
            session.inferiorStateUnknown?.() ?? true;
          session.launched.process.kill("SIGTERM");
          expect(await session.supervisor.waitForExit(1_000)).toBe(true);
          cleanupAfterDebuggerExit =
            (await session.verifyInferiorsEndedAfterExit?.()) === true;
          unresolvedIdentityReadFails = false;
          cleanupWhileUnresolvedInferiorAlive =
            (await session.verifyInferiorsEndedAfterExit?.()) === true;
          return cleanupWhileUnresolvedInferiorAlive
            ? { status: "stopped" }
            : { status: "incomplete", reason: "unresolved inferior remains" };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: tty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const closed = await manager.close(started.value.session_id);

    expect(unresolvedReadFailed).toBe(true);
    expect(inventoryUnknownAfterFailedRead).toBe(true);
    expect(cleanupAfterDebuggerExit).toBe(false);
    expect(cleanupWhileUnresolvedInferiorAlive).toBe(false);
    expect(closed.ok).toBe(false);
    expect(manager.status(started.value.session_id)).toBeDefined();
    expect(unresolved.exitCode).toBeNull();

    const unresolvedExit = new Promise<void>((resolveExit) =>
      unresolved.once("exit", () => resolveExit()),
    );
    unresolved.kill("SIGTERM");
    await unresolvedExit;
    const unresolvedRetry = await manager.retryCleanupFailures();

    expect(unresolvedRetry.ok).toBe(false);
    expect(cleanupAfterUnresolvedInferiorExit).toBe(false);
    expect(detached.exitCode).toBeNull();
    const knownExit = new Promise<void>((resolveExit) =>
      detached.once("exit", () => resolveExit()),
    );
    detached.kill("SIGTERM");
    await knownExit;
    const retried = await manager.retryCleanupFailures();

    expect(retried).toEqual({ ok: true, value: null });
    expect(cleanupAfterKnownInferiorExit).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "releases Rizin cleanup after an unidentified pending inferior exits",
  async () => {
    const inferior = await spawnTestInferior();
    expect(inferior.pid).toBeDefined();
    if (inferior.pid === undefined) return;
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-unidentified-exit-"));
    const provider = join(directory, "fake-rizin-unidentified-exit.mjs");
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
    if (line === "olj")
      process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://${inferior.pid}" }]) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);

    let identityUnavailable = true;
    let verifyResultAfterDebuggerExit: boolean | undefined;
    let stopCalls = 0;
    const manager = new RizinDebugSessionManager(
      { ...process.env, REA_RIZIN_COMMAND: provider },
      {
        platform: "linux",
        readProcessStartTime: async (pid) => {
          expect(pid).toBe(String(inferior.pid));
          if (identityUnavailable)
            throw new Error("injected identity read failure");
          return inferior.exitCode === null && inferior.signalCode === null
            ? "200"
            : null;
        },
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          ownedProviderProcesses.push(launched.process);
          return launched;
        },
        stopProcess: async (session) => {
          if (stopCalls++ > 0) {
            verifyResultAfterDebuggerExit =
              (await session.verifyInferiorsEndedAfterExit?.()) === true;
            return verifyResultAfterDebuggerExit
              ? { status: "stopped" }
              : {
                  status: "incomplete",
                  reason: "inferior state remains unknown",
                };
          }
          try {
            await session.detachInferior?.();
          } catch {
            // The reported PID cannot be identified in this attempt.
          }
          session.launched.process.kill("SIGTERM");
          expect(await session.supervisor.waitForExit(1_000)).toBe(true);
          expect(await session.verifyInferiorsEndedAfterExit?.()).toBe(false);
          identityUnavailable = false;
          return {
            status: "incomplete",
            reason: "inferior state remains unknown",
          };
        },
      },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    const inferiorExit = new Promise<void>((resolveExit) =>
      inferior.once("exit", () => resolveExit()),
    );
    inferior.kill("SIGTERM");
    await inferiorExit;

    expect(await manager.retryCleanupFailures()).toEqual({
      ok: true,
      value: null,
    });
    expect(verifyResultAfterDebuggerExit).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps Rizin cleanup unknown when an inferior inventory is only partially captured",
  async () => {
    const inferior = await spawnTestInferior();
    const pid = inferior.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const provider = await createInferiorInventoryProvider([
      { fd: 12, pid },
      { fd: 13, pid: 999_999_999 },
    ]);
    const { manager, sessionId, exitDebugger } =
      await startRizinWithOwnedStop(provider);
    if (sessionId === undefined) return;

    expect((await manager.close(sessionId)).ok).toBe(false);
    await exitDebugger();
    const closed = await manager.close(sessionId);

    expect(closed.ok, JSON.stringify(closed)).toBe(false);
    if (!closed.ok)
      expect(closed.error.message).toContain("no owner proof confirms");
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "retains Rizin cleanup when target state is unknown at debugger exit",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-unknown-target-"));
    const provider = join(directory, "fake-rizin-unknown-target.mjs");
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
    if (line === "olj") process.stdout.write("not-json\\0");
    else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId, exitDebugger } =
      await startRizinWithOwnedStop(provider);
    if (sessionId === undefined) return;

    expect((await manager.close(sessionId)).ok).toBe(false);
    await exitDebugger();
    const closed = await manager.close(sessionId);

    expect(closed.ok, JSON.stringify(closed)).toBe(false);
    if (!closed.ok)
      expect(closed.error.message).toContain("no owner proof confirms");
    expect(manager.status(sessionId)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "preserves command parameters in Rizin observation evidence",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-evidence-"));
    const provider = join(directory, "fake-rizin-command-evidence.mjs");
    const inferiorTty = await rizinTestInferiorTty();
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
    if (!line.startsWith("!echo ")) process.stdout.write("command output\\0");
    else process.stdout.write(line.slice(6) + "\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager({ REA_RIZIN_COMMAND: provider });
    managers.push(manager);
    const callerSelectedPath = "./relative/../fixture.bin";
    const resolvedPath = absoluteCallerPath(callerSelectedPath);
    const started = await manager.start({
      path: callerSelectedPath,
      inferior_tty: inferiorTty,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const executed = await manager.execute(started.value.session_id, "dr");

    expect(executed.ok).toBe(true);
    if (executed.ok)
      expect(executed.value.evidence.parameters).toEqual({
        session_id: started.value.session_id,
        command: "dr",
        inferior_tty: inferiorTty,
        launch_provenance: {
          caller_selected_path: callerSelectedPath,
          resolved_path: resolvedPath,
        },
      });
    if (executed.ok)
      expect(executed.value.evidence.limitations).toContain(
        "Launch provenance records the original and resolved startup paths; it does not establish the current target after unrestricted debugger commands.",
      );
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
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;
    const first = manager.execute(sessionId, "first");
    const controller = new AbortController();
    const second = manager.execute(sessionId, "second", controller.signal);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    controller.abort();
    const third = manager.execute(sessionId, "third");
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
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;

    const result = await manager.execute(sessionId, "px");

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (result.ok) {
      expect(
        Buffer.byteLength(result.value.result.output, "utf8"),
      ).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.value.result).toMatchObject({
        output_truncated: true,
        completion_status: "unknown",
      });
      expect(result.value.evidence.parameters).toMatchObject({
        session_id: sessionId,
        command: "px",
        inferior_tty: expect.any(String),
      });
    }
    expect(manager.status(sessionId)).toBeDefined();
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
    if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
    else if (line === "olj") process.stdout.write(JSON.stringify([{ fd: 12, raised: true, uri: "ptrace://" + process.ppid }]) + "\\0");
    else if (line === "px") process.stdout.write("x".repeat(10 * 1024 * 1024) + "\\0" + "y".repeat(10 * 1024 * 1024) + "\\0");
    else process.stdout.write("\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const { manager, sessionId } = await startRizinWithProvider(provider);
    if (sessionId === undefined) return;

    const result = await manager.execute(sessionId, "px");

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
    expect(manager.status(sessionId)).toBeDefined();
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
process.stdin.on("data", () => process.stdout.write(Buffer.from([0xff, 0])));
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      { frameTimeoutMs: 40 },
    );
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = await manager.execute(started.value.session_id, "dr");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toMatchObject({
        output: "�",
        output_truncated: true,
        completion_status: "unknown",
        output_invalid_utf8: true,
      });
      expect(result.value.evidence.limitations).toContain(
        "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
      );
    }
    await expectOwnedProcessExited(
      await readFile(join(directory, "pid"), "utf8"),
    );
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
    if (line === "slow") {
      stalled = true;
      process.stdout.write(Buffer.from([0xff, 0]));
    }
    else if (line.startsWith("!echo ") && !stalled) process.stdout.write(line.slice(6) + "\\n\\0");
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      { frameTimeoutMs: 5_000 },
    );
    managers.push(manager);
    const callerSelectedPath = "./cancelled/../fixture.bin";
    const resolvedPath = absoluteCallerPath(callerSelectedPath);
    const started = await manager.start({
      path: callerSelectedPath,
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const controller = new AbortController();
    const pending = manager.execute(
      started.value.session_id,
      "slow",
      controller.signal,
    );
    await expect
      .poll(() => manager.status(started.value.session_id)?.output_invalid_utf8)
      .toBe(true);
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: { output_invalid_utf8: true },
        limitations: expect.arrayContaining([
          "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
        ]),
        parameters: {
          launch_provenance: {
            caller_selected_path: callerSelectedPath,
            resolved_path: resolvedPath,
          },
        },
      });
    }
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
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
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
    const spawned = createDeferred<void>();
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      {
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          spawned.resolve();
          return launched;
        },
      },
    );
    managers.push(manager);
    const controller = new AbortController();
    const starting = manager.start(
      { path: "/tmp/fixture.bin", inferior_tty: await rizinTestInferiorTty() },
      controller.signal,
    );
    const started = await withVerifierCleanup(async () => {
      await awaitAcknowledgement(spawned.promise, starting, "Rizin spawn");
      controller.abort();
      return await starting;
    }, [
      () => controller.abort(),
      async () => {
        await starting;
      },
      () => manager.closeAll(),
    ]);

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
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    managers.push(manager);
    const started = await manager.start({
      path: "/tmp/fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

    const result = await manager.execute(started.value.session_id, "dr");

    expect(result.ok).toBe(false);
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it.skipIf(process.platform === "win32")(
  "preserves Rizin process-exit reason and partial command output",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-command-exit-"));
    const provider = join(directory, "fake-rizin-command-exit.mjs");
    const writerPidPath = join(directory, "writer.pid");
    await writeFile(
      provider,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const boundary = input.indexOf("\\n");
    if (boundary < 0) break;
    const line = input.slice(0, boundary); input = input.slice(boundary + 1);
    if (line === "exit-now") {
      const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(writerPidPath)}, String(writer.pid));
      process.stdout.write(Buffer.concat([Buffer.from("partial-before-exit\\0second-partial\\0"), Buffer.from([0xff, 0])]), () => process.exit(7));
    }
  }
});
`,
    );
    await chmod(provider, 0o700);
    let writerObserved = false;
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      {
        stopProcess: async () => {
          const writerPid = Number(await readFile(writerPidPath, "utf8"));
          try {
            process.kill(writerPid, 0);
            writerObserved = true;
          } catch {
            writerObserved = false;
          }
          return {
            status: "incomplete",
            reason: "owned output writer is still active",
          };
        },
      },
    );
    managers.push(manager);
    const callerSelectedPath = "./exit/../fixture.bin";
    const resolvedPath = absoluteCallerPath(callerSelectedPath);
    const started = await manager.start({
      path: callerSelectedPath,
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const exited = await manager.execute(started.value.session_id, "exit-now");

    expect(exited.ok).toBe(false);
    expect(writerObserved).toBe(true);
    if (!exited.ok) {
      expect(exited.error.cleanup).toEqual({
        reason: "owned output writer is still active",
        resources: [started.value.session_id],
      });
      expect(exited.error.partialObservation).toMatchObject({
        normalized_result: {
          output: ["partial-before-exit", "second-partial", "�"].join("\n"),
          completion_status: "unknown",
          output_invalid_utf8: true,
        },
        parameters: {
          command: "exit-now",
          session_id: started.value.session_id,
          launch_provenance: {
            caller_selected_path: callerSelectedPath,
            resolved_path: resolvedPath,
          },
        },
      });
      const partialEvidence = evidenceSchema.parse(
        exited.error.partialObservation,
      );
      expect(partialEvidence.limitations.join(" ")).toContain(
        "Rizin exited before the command-completion marker; retained frame output is partial and command completion is unknown.",
      );
    }
    const writerPid = Number(await readFile(writerPidPath, "utf8"));
    process.kill(writerPid, "SIGKILL");
  },
);
