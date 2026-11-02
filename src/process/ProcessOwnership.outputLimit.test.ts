import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { execFileOutputFailure } from "./ExecFileOutput.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
  observeOwnedProcessGroups,
} from "./ProcessOwnershipObservation.js";

const posixIt = it.skipIf(process.platform === "win32");
const OUTPUT_BYTES = 64 * 1024;
const ownRow = `${process.pid} ${process.ppid} ${process.pid} 1000 S fixture\n`;

const processTableHost = async (program: string) => {
  const root = await createTestTempDirectory("rea-process-table-limit-");
  const command = join(root, "ps");
  await writeFile(command, `#!${process.execPath}\n${program}\n`);
  await chmod(command, 0o755);
  return createSystemProcessOwnershipHost("linux", { PATH: root });
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
