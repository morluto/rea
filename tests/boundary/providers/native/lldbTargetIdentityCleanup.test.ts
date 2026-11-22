import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import { ok } from "../../../../src/domain/result.js";
import type { NativeCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { LldbCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { nativeResolvedToolFixture } from "../../../fixtures/nativeCommands.js";
import { failedInspectionDescriptor } from "../../../fixtures/processInspectionCleanup.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

/** Each identity read rejects with this cause while it is set. */
const rejections = vi.hoisted(() => ({
  startIdentity: undefined as unknown,
  exitIdentity: undefined as unknown,
}));

vi.mock(
  "../../../../src/process/ProcessOwnershipObservation.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../../src/process/ProcessOwnershipObservation.js")
      >();
    return {
      ...original,
      observeProcessStartIdentity: async (
        ...arguments_: Parameters<typeof original.observeProcessStartIdentity>
      ) => {
        if (rejections.startIdentity !== undefined)
          throw rejections.startIdentity;
        return original.observeProcessStartIdentity(...arguments_);
      },
      observeProcessStartIdentityExit: async (
        ...arguments_: Parameters<
          typeof original.observeProcessStartIdentityExit
        >
      ) => {
        if (rejections.exitIdentity !== undefined)
          throw rejections.exitIdentity;
        return original.observeProcessStartIdentityExit(...arguments_);
      },
    };
  },
);

const request: Parameters<NativeCallTracer["trace"]>[0] = {
  executable: "/fixture/target",
  architecture: "arm64",
  expectedSha256: "0".repeat(64),
  input: {
    breakpoints: [{ kind: "function", name: "main" }],
    arguments: [],
    environment: {},
    duration_ms: 5_000,
    max_events: 1,
    argument_registers: 0,
    backtrace_frames: 0,
  },
};

/**
 * A fake LLDB that publishes `FIXTURE_TARGET_PID` (or its own PID) as the
 * target, waits for the host's identity acknowledgement, and then publishes
 * `FIXTURE_RESULT` with empty capture files.
 */
const fakeLldb = async (root: string): Promise<string> => {
  const path = join(root, "fake-lldb");
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const command = process.argv.at(-1);
if (!command?.startsWith("rea_trace ")) process.exit(91);
const config = JSON.parse(fs.readFileSync(command.slice("rea_trace ".length), "utf8"));
for (const file of [config.observation_path, config.stdout_capture_path, config.stderr_capture_path])
  fs.writeFileSync(file, "");
fs.writeFileSync(config.pid_path, process.env.FIXTURE_TARGET_PID ?? String(process.pid));
const wait = () => {
  if (!fs.existsSync(config.identity_ack_path)) return setTimeout(wait, 10);
  fs.writeFileSync(config.result_path, process.env.FIXTURE_RESULT);
};
wait();
`,
    { mode: 0o700 },
  );
  return path;
};

const tracerFor = (
  executable: string,
  environment: Readonly<Record<string, string>>,
): LldbCallTracer => {
  const tracer = new LldbCallTracer(
    { ...process.env, ...environment },
    undefined,
    async () => ok(nativeResolvedToolFixture(executable, "c".repeat(64))),
  );
  return tracer;
};

it.skipIf(process.platform === "win32")(
  "retains the descriptor a failed target start-identity read left open until close releases it",
  async () => {
    const root = await createTestTempDirectory("rea-lldb-identity-fd-");
    const descriptor = await failedInspectionDescriptor(root);
    const tracer = tracerFor(await fakeLldb(root), {
      FIXTURE_RESULT: JSON.stringify({
        status: "target-identity-unavailable",
        error: "host could not establish the launched process identity",
        target_process_created: true,
        target_process_exit_observed: true,
      }),
    });
    rejections.startIdentity = descriptor.failure;
    onTestFinished(() => {
      rejections.startIdentity = undefined;
    });

    const result = await tracer.trace(request);
    rejections.startIdentity = undefined;

    if (result.ok) throw new Error("Expected the identity-unavailable failure");
    expect(
      result.error.cleanupIncomplete,
      "the open descriptor is reported as cleanup",
    ).toBe(true);
    expect(result.error.cleanupResources).toContain(descriptor.path);
    const refused = await tracer.close();
    expect(refused.ok, "close keeps the descriptor while it fails").toBe(false);
    expect(descriptor.closes()).toBeGreaterThan(1);

    descriptor.allow();
    expect(await tracer.close()).toEqual(ok(null));
    expect(
      result.error.cleanupIncomplete,
      "the release is visible on the reported failure",
    ).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "retains the descriptor a failed target exit-identity check left open while terminating the target",
  async () => {
    const root = await createTestTempDirectory("rea-lldb-exit-fd-");
    const target = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    await once(target, "spawn");
    onTestFinished(async () => {
      if (target.exitCode === null && target.signalCode === null) {
        target.kill("SIGKILL");
        await once(target, "exit");
      }
    });
    const descriptor = await failedInspectionDescriptor(root);
    const tracer = tracerFor(await fakeLldb(root), {
      FIXTURE_TARGET_PID: String(target.pid),
      FIXTURE_RESULT: JSON.stringify({
        status: "target-error",
        error: "fixture target failure",
        target_process_created: true,
      }),
    });
    rejections.exitIdentity = descriptor.failure;
    onTestFinished(() => {
      rejections.exitIdentity = undefined;
    });

    const result = await tracer.trace(request);
    rejections.exitIdentity = undefined;

    if (result.ok) throw new Error("Expected the target failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(
      result.error.cleanupResources,
      "the descriptor is reported with the surviving target",
    ).toEqual(
      expect.arrayContaining([
        descriptor.path,
        `native-target:${String(target.pid)}`,
      ]),
    );

    target.kill("SIGKILL");
    await once(target, "exit");
    expect((await tracer.close()).ok, "the descriptor still refuses").toBe(
      false,
    );
    descriptor.allow();
    expect(await tracer.close()).toEqual(ok(null));
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);
