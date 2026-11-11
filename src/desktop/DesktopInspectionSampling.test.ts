import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readdir: async (...args: Parameters<typeof actual.readdir>) =>
      String(args[0]) === "/proc/42/task"
        ? ["42", "43"]
        : actual.readdir(...args),
  };
});
vi.mock("../process/ProviderProcess.js", async (original) => ({
  ...(await original<typeof import("../process/ProviderProcess.js")>()),
  spawnOwnedProviderProcess: vi.fn(),
}));

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { samplingInspectionFailures } from "../process/capture/ProcessSamplingObservation.js";
import { ExecFileOutputCancelledError } from "../process/ExecFileOutput.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import {
  createSystemProcessOwnershipHost,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../process/ProcessInspectionCancellation.js";
import {
  DesktopSessionCleanupError,
  runDesktopSession,
} from "./DesktopApplicationSession.js";
import { X11WindowObserver } from "./X11WindowObserver.js";

type Route =
  | "runId"
  | "tokenCarriers"
  | "stat"
  | "children"
  | "cancelledListing"
  | "cancelledStat";

/** Actual procfs reader and file owner; only the selected path and native command port are recorded. */
const samplingFiles = async (route: Route, cancel: () => void) => {
  const root = await createTestTempDirectory("desktop-sampling-owner-");
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[1] = "1";
  fields[2] = fields[3] = "42";
  fields[19] = "100";
  const contents = new Map([
    ["/proc/42/environ", "REA_PROCESS_RUN_ID=recording-run\0"],
    ["/proc/43/environ", "REA_PROCESS_RUN_ID=recording-run\0"],
    ...(["stat", "children", "cancelledStat"].includes(route)
      ? [["/proc/42/stat", `42 (recording-child) ${fields.join(" ")}`]]
      : []),
    ["/proc/42/task/42/children", ""],
    ["/proc/42/task/43/children", ""],
  ] as [string, string][]);
  const paths = new Map<string, string>();
  for (const [source, contents_] of contents) {
    const path = join(root, String(paths.size));
    await writeFile(path, contents_);
    paths.set(source, path);
  }
  const handles = new Map<number, OwnedFileHandle>();
  const allowed = new Set<number>();
  const selected = new Set<number>();
  let deny = false;
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(files.open).mockImplementation(async (...args) => {
    const path = String(args[0]);
    const selectedPath = paths.get(path);
    if (selectedPath === undefined) return actual.open(...args);
    const handle = await actual.open(selectedPath, "r");
    if (
      deny ||
      ((route === "stat" || route === "cancelledStat") &&
        path.endsWith("/stat")) ||
      (route === "children" && path.endsWith("/children"))
    )
      selected.add(handle.fd);
    return handle;
  });
  const close = OwnedFileHandle.prototype.close;
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(
    async function (this: OwnedFileHandle) {
      if (selected.has(this.handle.fd)) {
        handles.set(this.handle.fd, this);
        if (route === "cancelledStat") cancel();
        else if (!allowed.has(this.handle.fd))
          throw new Error("controlled sampling descriptor close failure");
      }
      await close.call(this);
    },
  );
  onTestFinished(async () => {
    for (const [fd, owner] of handles) {
      allowed.add(fd);
      await owner.close();
    }
    vi.mocked(files.open).mockImplementation(actual.open);
    vi.restoreAllMocks();
    vi.mocked(spawnOwnedProviderProcess).mockReset();
  });
  return {
    deny: () => {
      deny = true;
    },
    handles,
    allow: (fd: number) => allowed.add(fd),
    pending: () =>
      [...handles.values()].filter((owner) => owner.handle.fd >= 0),
  };
};

const recordingChild = () => {
  const finish = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: null,
    stderr: null,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn((_signal?: NodeJS.Signals | number) => {
      finish();
      return true;
    }),
  });
  return { child, finish };
};

const commandOutput = (stdout: string) => ({
  stdout,
  stderr: "",
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: 0,
});

const tokenCarrierBatch = (
  reads: readonly PromiseSettledResult<unknown>[],
  cancelled: unknown,
) => {
  const failures = reads.map((read, index) => {
    if (
      read.status !== "rejected" ||
      !(read.reason instanceof RegularFileCleanupFailure)
    )
      throw new Error("Expected actual admitted sampling descriptor failures");
    return { pid: 42 + index, requestIndex: index, cause: read.reason };
  });
  if (!(cancelled instanceof ProcessOwnershipInspectionCancelled))
    throw new Error("Expected actual native listing cancellation");
  return new ProcessOwnershipIdentityBatchFailure(
    [...failures, { pid: 44, requestIndex: 2, cause: cancelled }],
    new Map([
      [45, { state: "unavailable", reason: "authored retained observation" }],
    ]),
  );
};

const samplingSession = async (route: Route) => {
  const controller = new AbortController();
  const reason = { stop: "recording native inspection" };
  const retained = await samplingFiles(route, () => controller.abort(reason));
  const { child, finish } = recordingChild();
  const cleanup = vi.fn(async () => {
    if (retained.pending().length > 0)
      throw new Error("cleanup inspected before sampling descriptors released");
    return { cleaned: true as const, signaled: false };
  });
  vi.mocked(spawnOwnedProviderProcess).mockResolvedValue({
    process: child,
    cleanup,
    ownership: {
      runId: "recording-run",
      leaderPid: 42,
      processGroupId: 42,
      expectedParentPid: 1,
    },
  });
  let sourceFailure: unknown;
  let sourceSettled = false;
  let freshBeforeRetry = 0;
  let nativeCancellations = 0;
  let sampling = true;
  const native = createSystemProcessOwnershipHost(
    "linux",
    {},
    {
      execFileOutput: async () => {
        if (
          (sourceSettled || route === "stat" || route === "children") &&
          retained.pending().length > 0
        ) {
          freshBeforeRetry += 1;
          throw new Error("fresh lookup before sampling owner retry");
        }
        if (sampling && route !== "runId") {
          if (route === "cancelledListing" || retained.pending().length > 0) {
            nativeCancellations += 1;
            if (route === "cancelledListing") sampling = false;
            controller.abort(reason);
            throw new ExecFileOutputCancelledError(reason);
          }
          return commandOutput(
            "42 1 42 1000 S recording-child\n43 1 42 1000 S recording-peer\n",
          );
        }
        return commandOutput("");
      },
    },
  );
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockRejectedValue(
    new Error("Unexpected native helper preparation"),
  );
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("Unexpected native signal");
  });
  vi.spyOn(systemProcessOwnershipHost, "signalGroup").mockImplementation(() => {
    throw new Error("Unexpected native group signal");
  });
  vi.spyOn(systemProcessOwnershipHost, "listProcesses").mockImplementation(
    async (signal) => {
      try {
        return await native.listProcesses(signal);
      } catch (cause: unknown) {
        if (route === "cancelledListing") sourceFailure = cause;
        throw cause;
      }
    },
  );
  vi.spyOn(systemProcessOwnershipHost, "environment").mockImplementation(
    async (pid, signal) => {
      if (route === "runId") retained.deny();
      try {
        return await native.environment(pid, signal);
      } catch (cause: unknown) {
        sourceFailure = cause;
        sourceSettled = true;
        sampling = false;
        throw cause;
      }
    },
  );
  vi.spyOn(systemProcessOwnershipHost, "runTokens").mockImplementation(
    async (_rows, signal) => {
      retained.deny();
      const reads = await Promise.allSettled([
        native.environment(42, signal),
        native.environment(43, signal),
      ]);
      const cancelled = await native
        .listProcesses(signal)
        .catch((cause: unknown) => cause);
      const batch = tokenCarrierBatch(reads, cancelled);
      sourceFailure = batch;
      sourceSettled = true;
      sampling = false;
      throw batch;
    },
  );
  const windows = new X11WindowObserver("unused-recording-command", {});
  vi.spyOn(windows, "sample").mockImplementation(async () => {
    if (route !== "runId") finish();
    return { state: "listed", windows: [] };
  });
  const run = () =>
    runDesktopSession({
      argv: ["recording-child"],
      workingDirectory: process.cwd(),
      environment: {},
      windows,
      windowMatching: { names: new Set(), byPid: true },
      roots: [],
      maxDurationMs: 10_000,
      pollIntervalMs: 1,
      nextRequest: () => (route === "runId" ? { kind: "stop" } : undefined),
      checkpoint: async () => {},
      report: async () => {},
      signal: controller.signal,
    });
  return {
    retained,
    run,
    child,
    cleanup,
    reason,
    sourceFailure: () => sourceFailure,
    freshBeforeRetry: () => freshBeforeRetry,
    nativeCancellations: () => nativeCancellations,
  };
};

it.each(["runId", "tokenCarriers", "stat", "children"] as const)(
  "retains actual %s sampling descriptors before any fresh cleanup inspection and supports partial retry",
  async (route) => {
    const fixture = await samplingSession(route);
    const failure: unknown = await fixture
      .run()
      .catch((cause: unknown) => cause);
    const normalized = route === "stat" || route === "children";
    const source =
      normalized && failure instanceof DesktopSessionCleanupError
        ? failure.primary
        : fixture.sourceFailure();
    if (route === "runId")
      expect(source).toBeInstanceOf(RegularFileCleanupFailure);
    else if (!normalized) {
      expect(source).toBeInstanceOf(ProcessOwnershipIdentityBatchFailure);
      if (!(source instanceof ProcessOwnershipIdentityBatchFailure))
        throw new Error("Expected mixed batch");
      expect(source.origin).toBe("physical");
      expect(source.cancellations[0]?.cancellation.reason).toBe(fixture.reason);
    }
    expect(fixture.retained.pending()).toHaveLength(
      route === "runId" || route === "stat" ? 1 : 2,
    );
    expect(fixture.freshBeforeRetry()).toBe(0);
    expect(failure).toBeInstanceOf(DesktopSessionCleanupError);
    if (!(failure instanceof DesktopSessionCleanupError))
      throw new Error("Expected session-owned sampling cleanup");
    expect(failure.primary).toBe(source);
    const inspections = samplingInspectionFailures(source);
    if (normalized) {
      expect(inspections).toHaveLength(route === "stat" ? 1 : 2);
      expect(
        inspections.every((inspection) => inspection.cleanupIncomplete),
      ).toBe(true);
    }
    expect(failure.cleanup.inspectionCleanup?.causes).toContain(source);
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.child.kill.mock.calls).toEqual(
      route !== "tokenCarriers" ? [["SIGTERM"]] : [],
    );
    const leases = failure.cleanup.leases;
    if (route === "tokenCarriers" || route === "children") {
      const first = [...fixture.retained.handles.keys()][0]!;
      fixture.retained.allow(first);
      await expect(leases[0]!.release()).rejects.toBeDefined();
      expect(fixture.retained.pending()).toHaveLength(1);
      expect(fixture.freshBeforeRetry()).toBe(0);
      expect(fixture.cleanup).not.toHaveBeenCalled();
    }
    for (const fd of fixture.retained.handles.keys())
      fixture.retained.allow(fd);
    await leases[0]!.release();
    expect(fixture.retained.pending()).toEqual([]);
    expect(
      inspections.every((inspection) => !inspection.cleanupIncomplete),
    ).toBe(true);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.freshBeforeRetry()).toBe(0);
    expect(fixture.child.kill.mock.calls).toEqual(
      route !== "tokenCarriers" ? [["SIGTERM"]] : [],
    );
  },
);

it("keeps actual native listing cancellation as a cancelled session with an opaque reason", async () => {
  const fixture = await samplingSession("cancelledListing");
  const result = await fixture.run();
  expect(fixture.nativeCancellations()).toBe(1);
  const cause = fixture.sourceFailure();
  expect(cause).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
  if (!(cause instanceof ProcessOwnershipInspectionCancelled))
    throw new Error("Expected native cancellation fact");
  expect(cause.reason).toBe(fixture.reason);
  expect(cause.cause).toBeInstanceOf(ExecFileOutputCancelledError);
  expect(result.session.end_reason).toBe("cancelled");
  expect(result.session.cleanup.verified).toBe(true);
  expect(result.unreleased).toBeUndefined();
});

it("keeps normalized stat finalization cancellation as a cancelled session", async () => {
  const fixture = await samplingSession("cancelledStat");
  const result = await fixture.run();
  expect(fixture.retained.handles.size).toBe(1);
  expect(fixture.retained.pending()).toEqual([]);
  expect(result.session.end_reason).toBe("cancelled");
  expect(result.session.cleanup.verified).toBe(true);
  expect(result.unreleased).toBeUndefined();
  expect(fixture.cleanup).toHaveBeenCalledOnce();
});
