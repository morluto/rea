import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { BuildComputerLongRuns } from "./BuildComputerLongRuns.js";
import type { ControlledComputer } from "./BuildComputerController.js";

const response = (value: unknown) => ({
  exit_code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  timed_out: false,
  truncated: false,
});
const options = (signal: AbortSignal) => ({
  work: ".rea-build",
  stdout: ".rea-build/output.json",
  files: {},
  timeoutS: 7080,
  signal,
});

it("waits through several bounded calls for a command with a longer budget", async () => {
  const timeouts: number[] = [];
  const calls: string[] = [];
  let polls = 0;
  let budget: unknown;
  const computer = {
    exec: async (argv: readonly string[], timeout: number) => {
      timeouts.push(timeout);
      const command = argv[4] ?? "";
      calls.push(command);
      const arguments_ = JSON.parse(argv.slice(5).join("")) as Record<
        string,
        unknown
      >;
      if (command === "run-begin") {
        budget = arguments_.timeout_s;
        return response({ started: true });
      }
      if (command === "run-poll")
        return response(
          ++polls < 3
            ? { pending: true }
            : { finished: true, exit_code: 0, stdout_bytes: 17, stderr: "" },
        );
      throw new Error(`unexpected ${command}`);
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  expect(
    await owner.run(
      ["export-desktop-application"],
      options(new AbortController().signal),
    ),
  ).toEqual({ stdoutBytes: 17, exitCode: 0, stderr: "" });
  expect(budget).toBe(7080);
  expect(calls).toEqual(["run-begin", "run-poll", "run-poll", "run-poll"]);
  expect(Math.max(...timeouts)).toBeLessThanOrEqual(3600);
  expect(owner.cleanupResources).toEqual([]);
});

it("retains an interrupted command until a later stop confirms it ended", async () => {
  const controller = new AbortController();
  let stops = 0;
  const computer = {
    exec: async (argv: readonly string[]) => {
      const command = argv[4];
      if (command === "run-begin") return response({ started: true });
      if (command === "run-poll") {
        controller.abort(new Error("cancelled"));
        throw controller.signal.reason;
      }
      if (command === "run-cancel")
        return response(
          ++stops === 1
            ? { pending: true }
            : {
                finished: true,
                exit_code: 130,
                stdout_bytes: 12,
                stderr: "stopped",
              },
        );
      throw new Error(`unexpected ${String(command)}`);
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  const failure = await owner
    .run(["export-desktop-application"], options(controller.signal))
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected retained cleanup");
  expect(failure.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(owner.cleanupResources).toHaveLength(1);
  expect(await owner.release()).toMatchObject({ verified: true });
  expect(failure.diagnostics).toMatchObject({
    completed_command: { stdout_bytes: 12, exit_code: 130 },
  });
  expect(failure.cleanupIncomplete).toBe(false);
});

it("retains cancellation arriving during failed final cleanup alongside the original error", async () => {
  const controller = new AbortController();
  let stops = 0;
  const computer = {
    exec: async (argv: readonly string[]) => {
      if (argv[4] === "run-begin") return response({ started: true });
      if (argv[4] === "run-poll") throw new Error("connection failed");
      if (argv[4] === "run-cancel") {
        if (++stops === 1) {
          controller.abort(new Error("cancelled"));
          return response({ pending: true });
        }
        return response({ finished: true, exit_code: 130, stdout_bytes: 3 });
      }
      throw new Error("unexpected command");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  const failure = await owner
    .run(["export-desktop-application"], options(controller.signal))
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected retained cleanup");
  expect(failure.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(failure.cleanupPrimary?.secondaryFailures[0]?.userMessage).toContain(
    "connection failed",
  );
  expect(await owner.release()).toMatchObject({ verified: true });
});

it("returns a timeout while retaining a command that is still stopping", async () => {
  let stops = 0;
  const computer = {
    exec: async (argv: readonly string[]) => {
      if (argv[4] === "run-begin") return response({ started: true });
      if (argv[4] === "run-poll")
        return response({ pending: true, timed_out: true });
      if (argv[4] === "run-cancel")
        return response(
          ++stops === 1
            ? { pending: true, timed_out: true }
            : {
                finished: true,
                timed_out: true,
                exit_code: 130,
                stdout_bytes: 0,
              },
        );
      throw new Error("unexpected command");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  const failure = await owner
    .run(["export-desktop-application"], options(new AbortController().signal))
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected retained cleanup");
  expect(failure.cleanupPrimary?.userMessage).toContain(
    "exceeded its time budget",
  );
  expect(owner.cleanupResources).toHaveLength(1);
  expect(await owner.release()).toMatchObject({ verified: true });
});

it("enforces its deadline even if the supervisor never publishes a timeout", async () => {
  const commands: string[] = [];
  const computer = {
    exec: async (argv: readonly string[]) => {
      const command = argv[4] ?? "";
      commands.push(command);
      if (command === "run-begin") return response({ started: true });
      if (command === "run-cancel") return response({ pending: true });
      throw new Error("the expired job must not be polled");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  const failure = await owner
    .run(["export-desktop-application"], {
      ...options(new AbortController().signal),
      timeoutS: 0,
    })
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected retained cleanup");
  expect(failure.cleanupPrimary?.userMessage).toContain(
    "exceeded its time budget",
  );
  expect(commands).toEqual(["run-begin", "run-cancel"]);
  expect(owner.cleanupResources).toHaveLength(1);
});

it("claims a not-yet-started job when cancellation interrupts its start", async () => {
  const controller = new AbortController();
  const commands: string[] = [];
  const computer = {
    exec: async (argv: readonly string[]) => {
      const command = argv[4] ?? "";
      commands.push(command);
      if (command === "run-begin") {
        controller.abort(new Error("cancelled"));
        throw controller.signal.reason;
      }
      if (command === "run-cancel") return response({ absent: true });
      throw new Error("unexpected command");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  await expect(
    owner.run(["export-desktop-application"], options(controller.signal)),
  ).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(commands).toEqual(["run-begin", "run-cancel"]);
  expect(owner.cleanupResources).toEqual([]);
});

it("retains a job whose cancellation cannot confirm ownership", async () => {
  const computer = {
    exec: async (argv: readonly string[]) => {
      if (argv[4] === "run-begin") throw new Error("response lost");
      if (argv[4] === "run-cancel")
        return response({
          error: "the command job ownership is not confirmed",
        });
      throw new Error("unexpected command");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  await expect(
    owner.run(
      ["export-desktop-application"],
      options(new AbortController().signal),
    ),
  ).rejects.toBeInstanceOf(ProviderCleanupError);
  expect(await owner.release()).toMatchObject({ verified: false });
  expect(owner.cleanupResources).toHaveLength(1);
});

it("preserves a completed command's receipt if the supervisor reports a later failure", async () => {
  const computer = {
    exec: async (argv: readonly string[]) => {
      if (argv[4] === "run-begin") return response({ started: true });
      if (argv[4] === "run-poll")
        return response({
          finished: true,
          exit_code: 0,
          stdout_bytes: 12,
          error: "stderr close failed",
        });
      throw new Error("unexpected command");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  const failure = await owner
    .run(["export-desktop-application"], options(new AbortController().signal))
    .catch((error: unknown) => error);
  if (!(failure instanceof Error) || !("diagnostics" in failure))
    throw new Error("expected command failure");
  expect(failure.diagnostics).toMatchObject({
    completed_command: {
      stdout_bytes: 12,
      exit_code: 0,
      error: "stderr close failed",
    },
  });
  expect(owner.cleanupResources).toEqual([]);
});

it("preserves a new cancellation while retrying a previous job's cleanup", async () => {
  const first = new AbortController();
  const second = new AbortController();
  let starts = 0;
  let stops = 0;
  const computer = {
    exec: async (argv: readonly string[]) => {
      if (argv[4] === "run-begin") {
        starts += 1;
        return response({ started: true });
      }
      if (argv[4] === "run-poll") {
        first.abort(new Error("first cancelled"));
        throw first.signal.reason;
      }
      if (argv[4] === "run-cancel") {
        stops += 1;
        if (stops === 2) second.abort(new Error("second cancelled"));
        return response(
          stops < 3
            ? { pending: true }
            : { finished: true, exit_code: 130, stdout_bytes: 0 },
        );
      }
      throw new Error("unexpected command");
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  const owner = new BuildComputerLongRuns(computer);
  await expect(
    owner.run(["export-desktop-application"], options(first.signal)),
  ).rejects.toBeInstanceOf(ProviderCleanupError);
  const failure = await owner
    .run(["export-desktop-application"], options(second.signal))
    .catch((error: unknown) => error);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected retained cleanup");
  expect(failure.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(starts).toBe(1);
  expect(await owner.release()).toMatchObject({ verified: true });
});
