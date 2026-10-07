import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createSystemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { createDarwinProcessRunTokenReader } from "../../../src/process/DarwinProcessRunTokenReader.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";

const execFileAsync = promisify(execFile);
const onDarwin = process.platform === "darwin";

it("reports an actionable missing Swift compiler without installing it", async () => {
  const reader = createDarwinProcessRunTokenReader({
    xcrun: join(tmpdir(), "rea-no-such-xcrun"),
  });
  try {
    await expect(
      reader.read([
        {
          pid: 1,
          parentPid: 0,
          processGroupId: 1,
          state: "S",
          command: "fixture",
        },
      ]),
    ).rejects.toThrow(/requires the Apple Swift compiler via xcrun/u);
  } finally {
    await reader.close();
  }
});

it.skipIf(!onDarwin)(
  "parses exact NUL-delimited token records and rejects truncated argv",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rea-process-token-parser-test-"),
    );
    const executable = join(root, "parser-test");
    const core = fileURLToPath(
      new URL(
        "../../../bridge/process/ProcessRunTokenReader.swift",
        import.meta.url,
      ),
    );
    const fixture = fileURLToPath(
      new URL(
        "../../fixtures/processRunTokenParserProbe.swift",
        import.meta.url,
      ),
    );
    try {
      await execFileOutput(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-module-cache-path",
          join(root, "modules"),
          core,
          fixture,
          "-o",
          executable,
        ],
        { timeout: 60_000 },
      );
      const { stdout } = await execFileAsync(executable, [], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual({
        argvDecoyIgnored: true,
        alternatePaddingRead: true,
        appleVectorTokenFailsClosed: true,
        clearedAppleVectorTokenFailsClosed: true,
        callerPfzBeforeTokenRead: true,
        emptyLaterArgumentRead: true,
        emptyEnvironmentFailsClosed: true,
        emptyArgv0Read: true,
        emptyEnvironmentRecordsBeforeTokenFailClosed: true,
        duplicateTokenFailsClosed: true,
        finalAssignmentArgumentRead: true,
        missingAppleBoundaryFailsClosed: true,
        nonAsciiPathRead: true,
        realTokenRead: true,
        reservedArgumentIgnored: true,
        truncatedArgvFailsClosed: true,
        zeroArgumentsRead: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!onDarwin)(
  "reads only the exact ownership key from live process environments",
  async () => {
    const host = createSystemProcessOwnershipHost("darwin");
    const decoy = await startNodeChild({
      DECOY: "words REA_PROCESS_RUN_ID=synthetic-decoy",
    });
    const owned = await startNodeChild({
      REA_PROCESS_RUN_ID: "synthetic-owned",
    });
    try {
      const processes = await host.listProcesses();
      const entries = [decoy, owned].map(({ pid }) => {
        const entry = processes.find((process) => process.pid === pid);
        if (entry === undefined)
          throw new Error("test child is absent from process table");
        return entry;
      });
      const observations = await host.runTokens?.(entries);
      const identities = await host.processIdentities?.(entries);
      expect(observations?.get(decoy.pid)).toEqual({
        state: "readable",
        runId: undefined,
      });
      expect(observations?.get(owned.pid)).toEqual({
        state: "readable",
        runId: "synthetic-owned",
      });
      expect(identities?.get(decoy.pid)?.state).toBe("readable");
      expect(identities?.get(owned.pid)?.state).toBe("readable");
    } finally {
      await stopNodeChild(decoy.child);
      await stopNodeChild(owned.child);
      await host.close?.();
    }
  },
);

it.skipIf(!onDarwin)(
  "reads owned tokens with empty later arguments across executable path padding",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-process-token-padding-"));
    const host = createSystemProcessOwnershipHost("darwin");
    const children: Awaited<ReturnType<typeof startNodeChild>>[] = [];
    try {
      const executables = [join(root, "n"), join(root, "node")];
      for (const executable of executables)
        await symlink(process.execPath, executable);
      for (let index = 0; index < executables.length; index += 1) {
        const executable = executables[index];
        if (executable === undefined)
          throw new Error("test executable is missing");
        children.push(
          await startNodeChild(
            { REA_PROCESS_RUN_ID: `synthetic-padding-${String(index)}` },
            executable,
            ["-e", "setInterval(() => {}, 1_000)", "", "FOO=bar"],
            index === 0 ? "" : undefined,
          ),
        );
      }
      const processes = await host.listProcesses();
      const entries = children.map(({ pid }) => {
        const entry = processes.find((process) => process.pid === pid);
        if (entry === undefined)
          throw new Error("owned test child is absent from process table");
        return entry;
      });
      const observations = await host.runTokens?.(entries);
      expect(children.map(({ pid }) => observations?.get(pid))).toEqual([
        { state: "readable", runId: "synthetic-padding-0" },
        { state: "readable", runId: "synthetic-padding-1" },
      ]);
    } finally {
      for (const { child } of children) await stopNodeChild(child);
      await host.close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);

const startNodeChild = async (
  environment: NodeJS.ProcessEnv,
  command = process.execPath,
  arguments_: readonly string[] = ["-e", "setInterval(() => {}, 1_000)"],
  argv0?: string,
) => {
  const child = spawn(command, [...arguments_], {
    env: environment,
    stdio: "ignore",
    ...(argv0 === undefined ? {} : { argv0 }),
  });
  if (child.pid === undefined)
    throw new Error("test child did not receive a PID");
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { child, pid: child.pid };
};

const stopNodeChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
};
