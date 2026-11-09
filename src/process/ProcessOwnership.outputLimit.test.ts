import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { execFileOutputFailure } from "./ExecFileOutput.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
  observeOwnedProcessGroups,
} from "./ProcessOwnershipObservation.js";

const posixIt = it.skipIf(process.platform === "win32");
const OUTPUT_BYTES = 16 * 1024;
const ownRow = `${process.pid} ${process.ppid} ${process.pid} 1000 S fixture\n`;

const processTableHost = async (
  program: string,
  environment: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = "linux",
) => {
  const root = await createTestTempDirectory("rea-process-table-limit-");
  const command = join(root, "ps");
  await writeFile(command, `#!${process.execPath}\n${program}\n`);
  await chmod(command, 0o755);
  return createSystemProcessOwnershipHost(platform, {
    ...environment,
    PATH: root,
  });
};

posixIt(
  "admits a complete process table within the byte allowance",
  async () => {
    const host = await processTableHost(
      `process.stdout.write(${JSON.stringify(ownRow)});`,
    );
    await expect(
      host.prepare?.(AbortSignal.timeout(2_000)),
    ).resolves.toBeUndefined();
    await expect(host.listProcesses()).resolves.toEqual([
      {
        pid: process.pid,
        parentPid: process.ppid,
        processGroupId: process.pid,
        uid: 1000,
        state: "S",
        command: "fixture",
      },
    ]);
  },
);

posixIt.each(["stdout", "stderr"] as const)(
  "refuses a process table with bounded %s overflow before parsing its rows",
  async (stream) => {
    // The complete self row must not admit preparation when the remainder of
    // either output stream was not captured. Multibyte text checks a byte cap.
    const host = await processTableHost(
      `process.stdout.write(${JSON.stringify(ownRow)});\n` +
        `process.${stream}.write("é".repeat(${OUTPUT_BYTES}));`,
      { REA_PROCESS_TABLE_MAX_BYTES: String(OUTPUT_BYTES) },
    );
    const failure: unknown = await host
      .prepare?.(AbortSignal.timeout(2_000))
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
    if (!(failure instanceof LinuxOwnedProcessPrerequisiteError))
      throw new Error("Expected a typed unavailable prerequisite");
    expect(failure).toMatchObject({
      providerId: "process-ownership",
      operation: "prepare_owned_process",
      outputLimitBytes: OUTPUT_BYTES,
      diagnostics: {
        prerequisite: "ps",
        reason: "output_limit",
        max_output_bytes_per_stream: OUTPUT_BYTES,
      },
      capturedOutput: { truncated: true },
    });
    const output = execFileOutputFailure(failure.cause);
    expect(output?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(output?.[`${stream}Bytes`]).toBe(OUTPUT_BYTES);
    expect(output?.stdoutBytes).toBeLessThanOrEqual(OUTPUT_BYTES);
    expect(output?.stderrBytes).toBeLessThanOrEqual(OUTPUT_BYTES);
    expect(failure.reason).toContain("incomplete process table was not used");

    // The same producer also supplies cleanup supervision: overflow must not
    // turn a partial or empty snapshot into proof that an owned group is gone.
    const groups = await observeOwnedProcessGroups(
      "authored-overflow-run",
      [process.pid],
      host,
      AbortSignal.timeout(2_000),
    );
    expect(groups.get(process.pid)).toMatchObject({
      state: "unverifiable",
      reason: expect.stringContaining("maxBuffer length exceeded"),
    });
  },
);

posixIt(
  "admits busy-host tables above the firmware diagnostic budget",
  async () => {
    const rows =
      Array.from(
        { length: 1000 },
        (_, index) =>
          `${100000 + index} 1 ${100000 + index} 1000 S worker --input=${"x".repeat(100)}\n`,
      ).join("") + ownRow;
    expect(Buffer.byteLength(rows)).toBeGreaterThan(64 * 1024);
    const host = await processTableHost(
      `process.stdout.write(${JSON.stringify(rows)});`,
    );
    await expect(
      host.prepare?.(AbortSignal.timeout(2_000)),
    ).resolves.toBeUndefined();
    const observed = await host.listProcesses();
    expect(observed).toHaveLength(1001);
    expect(observed.at(-1)?.pid).toBe(process.pid);
    expect(observed[0]?.command).toBe(`worker --input=${"x".repeat(100)}`);
    const groups = await observeOwnedProcessGroups(
      "absent-run",
      [999999],
      host,
      AbortSignal.timeout(2_000),
    );
    expect(groups.get(999999)?.state).toBe("empty");
  },
);

posixIt(
  "uses the selected table allowance rather than the firmware probe limit",
  async () => {
    const rows = ownRow + `999999 1 999999 1000 S ${"x".repeat(100000)}\n`;
    const host = await processTableHost(
      `process.stdout.write(${JSON.stringify(rows)});`,
      {
        REA_PROCESS_TABLE_MAX_BYTES: String(Buffer.byteLength(rows)),
      },
    );
    await expect(
      host.prepare?.(AbortSignal.timeout(2_000)),
    ).resolves.toBeUndefined();
    expect((await host.listProcesses()).at(-1)?.command).toHaveLength(100000);
  },
);

posixIt.each(["linux", "darwin"] as const)(
  "enforces the exact configured byte boundary on %s",
  async (platform) => {
    const rows = ownRow + `999999 1 999999 1000 S ${"é".repeat(100)}\n`;
    const bytes = Buffer.byteLength(rows);
    const program = `process.stdout.write(${JSON.stringify(rows)});`;
    const complete = await processTableHost(
      program,
      {
        REA_PROCESS_TABLE_MAX_BYTES: String(bytes),
      },
      platform,
    );
    await expect(complete.listProcesses()).resolves.toHaveLength(2);
    const overflow = await processTableHost(
      program,
      {
        REA_PROCESS_TABLE_MAX_BYTES: String(bytes - 1),
      },
      platform,
    );
    await expect(overflow.listProcesses()).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdoutBytes: bytes - 1,
    });
  },
);

posixIt(
  "refuses invalid configuration at inspection rather than host construction",
  async () => {
    const host = await processTableHost('throw new Error("ps must not run");', {
      REA_PROCESS_TABLE_MAX_BYTES: "invalid",
    });
    await expect(host.listProcesses()).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    await expect(host.prepare?.()).rejects.toBeInstanceOf(ConfigurationError);
  },
);

it("keeps Windows process inspection independent of the POSIX table setting", async () => {
  const host = createSystemProcessOwnershipHost("win32", {
    REA_PROCESS_TABLE_MAX_BYTES: "invalid",
    PATH: "/missing-ps",
  });
  await expect(host.listProcesses()).resolves.toEqual([]);
  await expect(host.prepare?.()).resolves.toBeUndefined();
});

it("preserves host spawn exhaustion instead of reporting a missing ps", async () => {
  const failure = Object.assign(new Error("host process limit"), {
    code: "EAGAIN",
  });
  const execute: typeof import("./ExecFileOutput.js").execFileOutput =
    async () => {
      throw failure;
    };
  const host = createSystemProcessOwnershipHost(
    "linux",
    {},
    { execFileOutput: execute },
  );
  await expect(host.prepare?.()).rejects.toBe(failure);
});

it("validates the process table budget before attempting ps", async () => {
  let invoked = false;
  const execute: typeof import("./ExecFileOutput.js").execFileOutput =
    async () => {
      invoked = true;
      throw new Error("unexpected execution");
    };
  const host = createSystemProcessOwnershipHost(
    "linux",
    { REA_PROCESS_TABLE_MAX_BYTES: "invalid" },
    { execFileOutput: execute },
  );
  await expect(host.prepare?.()).rejects.toBeInstanceOf(ConfigurationError);
  expect(invoked).toBe(false);
});
