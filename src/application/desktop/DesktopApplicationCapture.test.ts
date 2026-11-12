import {
  samplingInspectionFailures,
  settleSamplingReads,
  SamplingReadBatchFailure,
} from "../../process/capture/ProcessSamplingObservation.js";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../../domain/analysisErrorBase.js";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import {
  SessionObservations,
  trackProcess,
} from "../../desktop/DesktopSessionObservations.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { inspectAptRepositories } from "../../desktop/AptRepositoryInventory.js";
import { VENDOR_A } from "../../domain/desktop/aptKeys.fixture.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import * as captureFailures from "./DesktopCaptureFailure.js";
import * as providerProcess from "../../process/ProviderProcess.js";
import { systemProcessOwnershipHost } from "../../process/ProcessOwnershipObservation.js";
import { ProcessOwnershipInspectionCancelled } from "../../process/ProcessInspectionCancellation.js";
import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import {
  desktopApplicationCaptureSchema,
  desktopCaptureEventSchema,
} from "../../domain/desktop/desktopCapture.js";
import type { SessionRequest } from "../../desktop/DesktopApplicationSession.js";
import * as desktopSession from "../../desktop/DesktopApplicationSession.js";
import * as linuxInventory from "../../desktop/LinuxApplicationInventory.js";
import { X11WindowObserver } from "../../desktop/X11WindowObserver.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { CaptureFile } from "./DesktopCaptureOutput.js";
import {
  captureDesktopApplication,
  type DesktopCaptureRequest,
} from "./DesktopApplicationCapture.js";
import { capture as captureFixture } from "./desktopCapture.fixture.js";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const request = (output: string): DesktopCaptureRequest => ({
  desktopEntry: undefined,
  executable: "fakeapp",
  arguments: [],
  output,
  statePaths: [],
  excludes: [],
  maxDurationSeconds: 60,
  maxEntries: 10_000,
  maxFileBytes: 1024 * 1024,
  maxContentBytes: 8 * 1024 * 1024,
  packageFile: undefined,
});

const executable = async (path: string, text: string) => {
  await writeFile(path, text);
  await chmod(path, 0o755);
};

/** A fake application and an `xprop` stub that reports its window while it runs. */
const fixture = async () => {
  const root = await createTestTempDirectory("desktop-capture-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const windowFile = join(root, "window-open");
  await mkdir(join(home, ".config/fakeapp"), { recursive: true });
  await writeFile(join(home, ".config/fakeapp/state.ini"), "count=0\n");
  await mkdir(bin);
  await executable(
    join(bin, "fakeapp"),
    [
      "#!/bin/sh",
      `trap 'rm -f "${windowFile}"; exit 0' TERM`,
      `touch "${windowFile}"`,
      'printf "count=1\\n" > "$HOME/.config/fakeapp/state.ini"',
      "while :; do sleep 0.1; done",
    ].join("\n"),
  );
  await executable(
    join(bin, "xprop"),
    [
      "#!/bin/sh",
      `if [ -f "${join(root, "display-broken")}" ]; then exit 1; fi`,
      `if [ "$1" = "-root" ] && [ -f "${join(root, "no-client-list")}" ]; then echo "_NET_CLIENT_LIST:  not found."; exit 0; fi`,
      'if [ "$1" = "-root" ]; then',
      `  if [ -f "${windowFile}" ]; then echo "_NET_CLIENT_LIST: window id # 0x100001"; else echo "_NET_CLIENT_LIST: window id # "; fi`,
      "else",
      '  echo \'WM_CLASS = "fakeapp", "FakeApp"\'',
      "  echo '_NET_WM_NAME = \"Fake\"'",
      "  echo '_NET_WM_PID:  not found.'",
      "  echo '_NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_NORMAL'",
      "fi",
    ].join("\n"),
  );
  return {
    root,
    home,
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      DISPLAY: ":99",
    },
  };
};

/**
 * Replace the fake application with one that also starts a child in its
 * process group and a child in a new session; each records SIGTERM.
 */
const installProcessFamily = async (root: string, path: string) => {
  const windowFile = join(root, "window-open");
  const loop = "while :; do sleep 0.1; done";
  await executable(
    join(path.split(":")[0] ?? "", "fakeapp"),
    [
      "#!/bin/sh",
      `trap 'rm -f "${windowFile}"; exit 0' TERM`,
      `touch "${windowFile}"`,
      `( trap 'touch "${join(root, "group-term")}"; exit 0' TERM; ${loop} ) &`,
      `setsid sh -c 'trap "touch ${join(root, "setsid-term")}; exit 0" TERM; ${loop}' &`,
      'printf "count=1\\n" > "$HOME/.config/fakeapp/state.ini"',
      loop,
    ].join("\n"),
  );
};

const host = (
  environment: NodeJS.ProcessEnv,
  nextRequest: () => SessionRequest | undefined = () => undefined,
  platform: NodeJS.Platform = "linux",
) => ({
  platform,
  environment,
  callerDirectory: environment.HOME ?? "/",
  nextRequest,
  report: async () => {},
});

describe("captureDesktopApplication refusals", () => {
  it("refuses hosts other than Linux and sessions without a display", async () => {
    const { root, environment } = await fixture();
    const output = join(root, "out");
    expect(
      await captureDesktopApplication(
        request(output),
        host(environment, undefined, "darwin"),
      ),
    ).toMatchObject({
      error: "Desktop capture failed",
      details: { reason: "unsupported_host" },
    });
    expect(
      await captureDesktopApplication(
        request(output),
        host({ ...environment, DISPLAY: "" }),
      ),
    ).toMatchObject({ details: { reason: "display_unavailable" } });
  });

  it("refuses a missing xprop, an ambiguous application and a used output directory", async () => {
    const { root, environment } = await fixture();
    const output = join(root, "out");
    expect(
      await captureDesktopApplication(
        request(output),
        host({ ...environment, REA_XPROP_COMMAND: "/missing/xprop" }),
      ),
    ).toMatchObject({ details: { reason: "executable_missing" } });
    expect(
      await captureDesktopApplication(
        { ...request(output), desktopEntry: "org.example.app" },
        host(environment),
      ),
    ).toMatchObject({ error: "Desktop capture failed" });
    await mkdir(output);
    await writeFile(join(output, "keep"), "");
    expect(
      JSON.stringify(
        await captureDesktopApplication(request(output), host(environment)),
      ),
    ).toContain("is not empty");
    const file = join(root, "existing-file");
    await writeFile(file, "keep");
    expect(
      await captureDesktopApplication(request(file), host(environment)),
    ).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["output"], reason: "invalid_value" }] },
    });
    expect(await readFile(file, "utf8")).toBe("keep");
  });

  it("refuses a window manager that does not publish its client list", async () => {
    const { root, environment } = await fixture();
    await writeFile(join(root, "no-client-list"), "");
    const output = join(root, "out");

    const refused = await captureDesktopApplication(
      request(output),
      host(environment),
    );

    expect(refused).toMatchObject({
      details: { reason: "window_manager_unsupported" },
    });
    expect(JSON.stringify(refused)).toContain("_NET_CLIENT_LIST");
    await expect(readdir(output)).rejects.toThrow();
  });

  it("removes the content it retained when it fails before writing the capture", async () => {
    const { root, environment } = await fixture();
    const output = join(root, "out");

    const failed = await captureDesktopApplication(request(output), {
      ...host(environment),
      report: async (message) => {
        if (message.startsWith("Launching")) throw new Error("report failed");
      },
    });

    expect(JSON.stringify(failed)).toContain("report failed");
    expect(await readdir(output)).toEqual([]);
  });

  it("removes what it wrote when cancelled before writing the capture", async () => {
    const { root, environment } = await fixture();
    const output = join(root, "out");
    const controller = new AbortController();

    const cancelled = await captureDesktopApplication(
      request(output),
      {
        ...host(environment),
        report: async (message) => {
          if (message.startsWith("Recording the starting state"))
            controller.abort(new Error("caller cancelled"));
        },
      },
      controller.signal,
    );

    expect(cancelled).toMatchObject({ code: "cancelled" });
    expect(await readdir(output)).toEqual([]);
  });
});

it.each([false, true])(
  "preserves unresolved session ownership when publication fails (unreleased: %s)",
  async (unreleased) => {
    const { root, home, environment } = await fixture();
    const output = join(root, "out");
    const captured = captureFixture();
    const lease = new AnalysisCleanupLease(async () => {}, ["run-pending"]);
    vi.spyOn(linuxInventory, "inspectLinuxApplication").mockResolvedValue({
      ok: true,
      value: {
        inventory: { ...captured.application, state_directories: [] },
        limitations: [],
        signingKeys: new Map(),
      },
    });
    vi.spyOn(X11WindowObserver.prototype, "sample").mockResolvedValue({
      state: "listed",
      windows: [],
    });
    vi.spyOn(desktopSession, "runDesktopSession").mockResolvedValue({
      session: {
        ...captured.session,
        cleanup: { verified: !unreleased, reason: unreleased ? "busy" : null },
      },
      unreleased: unreleased ? { reason: "busy", leases: [lease] } : undefined,
      unreadableWindowSamples: 0,
    });
    vi.spyOn(CaptureFile.prototype, "publish").mockRejectedValue(
      new Error("publication denied"),
    );
    try {
      const result = await captureDesktopApplication(request(output), {
        ...host(environment),
        callerDirectory: home,
      });
      expect(result).toMatchObject({
        code: unreleased ? "cleanup_incomplete" : "execution_failure",
        message: expect.stringContaining("publication denied"),
        ...(unreleased
          ? { details: { cleanup: "incomplete", resources: ["run-pending"] } }
          : {}),
      });
      expect(await readdir(output)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await lease.release();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "returns the published evidence when cancellation arrives during publication",
  async () => {
    const { root, home, environment } = await fixture();
    const output = join(root, "out");
    const statePath = join(home, ".config/fakeapp/state.ini");
    const controller = new AbortController();
    const publish = CaptureFile.prototype.publish;
    const spy = vi
      .spyOn(CaptureFile.prototype, "publish")
      .mockImplementation(async function (this: CaptureFile, evidence) {
        const path = await publish.call(this, evidence);
        controller.abort("cancelled after publication");
        return path;
      });
    try {
      const result = await captureDesktopApplication(
        request(output),
        host(environment, () =>
          readFileSyncSafe(statePath) === "count=1\n"
            ? { kind: "stop" }
            : undefined,
        ),
        controller.signal,
      );
      if (!("error" in result)) throw new Error("Expected cancellation");
      const published = JSON.parse(
        await readFile(join(output, "capture.json"), "utf8"),
      );
      expect(result.code).toBe("cancelled");
      expect(result.details?.partial_observation).toEqual(published);
    } finally {
      spy.mockRestore();
    }
  },
  30_000,
);

describe.skipIf(process.platform !== "linux")(
  "captureDesktopApplication on Linux",
  () => {
    it("records the window, a requested checkpoint and the state change with its content", async () => {
      const { root, home, environment } = await fixture();
      const output = join(root, "out");
      const statePath = join(home, ".config/fakeapp/state.ini");
      let checkpointAt: number | undefined;
      const nextRequest = (): SessionRequest | undefined => {
        if (checkpointAt === undefined) {
          if (readFileSyncSafe(statePath) !== "count=1\n") return undefined;
          checkpointAt = performance.now();
          return { kind: "checkpoint", name: "written" };
        }
        // Leave time for window samples before stopping.
        return performance.now() - checkpointAt > 1500
          ? { kind: "stop" }
          : undefined;
      };

      const evidence = await captureDesktopApplication(
        request(output),
        host(environment, nextRequest),
      );

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      expect(evidence.operation).toBe("capture_desktop_application");
      const capture = desktopApplicationCaptureSchema.parse(
        evidence.normalized_result,
      );
      expect(capture.session).toMatchObject({
        end_reason: "stop_requested",
        window_match: { class: "FakeApp", instance: "fakeapp" },
      });
      expect(capture.session.first_window_ms).not.toBeNull();
      expect(capture.host).toMatchObject({
        hostname: hostname(),
        user: userInfo().username,
      });
      expect(
        capture.state.checkpoints.map((checkpoint) => checkpoint.name),
      ).toEqual(["baseline", "written", "stop", "exit"]);
      expect(capture.state.checkpoints[0]?.retained).toEqual([
        { path: statePath, sha256: sha256("count=0\n"), size: 8 },
      ]);
      const change = capture.state.checkpoints[1]?.changes.find(
        (candidate) => candidate.path === statePath,
      );
      expect(change).toMatchObject({
        kind: "modified",
        before: { sha256: sha256("count=0\n") },
        after: { sha256: sha256("count=1\n") },
        in_state_directory: true,
      });
      expect(
        await readFile(join(output, "content", sha256("count=1\n")), "utf8"),
      ).toBe("count=1\n");
      expect(
        JSON.parse(await readFile(join(output, "capture.json"), "utf8")),
      ).toEqual(JSON.parse(JSON.stringify(evidence)));
    }, 30_000);

    it("keeps a baseline-only capture when cancelled before any checkpoint", async () => {
      const { root, home, environment } = await fixture();
      const output = join(root, "out");
      const statePath = join(home, ".config/fakeapp/state.ini");
      const controller = new AbortController();
      const nextRequest = (): SessionRequest | undefined => {
        if (readFileSyncSafe(statePath) === "count=1\n") controller.abort();
        return undefined;
      };

      const evidence = await captureDesktopApplication(
        request(output),
        host(environment, nextRequest),
        controller.signal,
      );

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      const capture = desktopApplicationCaptureSchema.parse(
        evidence.normalized_result,
      );
      expect(capture.session.end_reason).toBe("cancelled");
      expect(
        capture.state.checkpoints.map((checkpoint) => checkpoint.name),
      ).toEqual(["baseline"]);
    });

    it("keeps the checkpoints taken before a cancellation and closes the application", async () => {
      const { root, home, environment } = await fixture();
      const output = join(root, "out");
      const statePath = join(home, ".config/fakeapp/state.ini");
      const controller = new AbortController();
      let checkpointed = false;
      const nextRequest = (): SessionRequest | undefined => {
        if (checkpointed) {
          controller.abort();
          return undefined;
        }
        if (readFileSyncSafe(statePath) !== "count=1\n") return undefined;
        checkpointed = true;
        return { kind: "checkpoint", name: "written" };
      };

      const evidence = await captureDesktopApplication(
        request(output),
        host(environment, nextRequest),
        controller.signal,
      );

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      const capture = desktopApplicationCaptureSchema.parse(
        evidence.normalized_result,
      );
      expect(capture.session.end_reason).toBe("cancelled");
      expect(capture.session.cleanup).toEqual({ verified: true, reason: null });
      expect(
        capture.state.checkpoints.map((checkpoint) => checkpoint.name),
      ).toEqual(["baseline", "written"]);
      expect(await readdir(output)).toContain("capture.json");
      await expect(readFile(join(root, "window-open"))).rejects.toThrow();
    });

    it("ends when the application exits and records what it wrote on the way out", async () => {
      const { root, home, environment } = await fixture();
      const bin = environment.PATH.split(":")[0] ?? "";
      await executable(
        join(bin, "fakeapp"),
        [
          "#!/bin/sh",
          "sleep 1",
          'printf "count=2\\n" > "$HOME/.config/fakeapp/state.ini"',
          "exit 3",
        ].join("\n"),
      );
      const output = join(root, "out");

      const evidence = await captureDesktopApplication(
        request(output),
        host(environment),
      );

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      const capture = desktopApplicationCaptureSchema.parse(
        evidence.normalized_result,
      );
      expect(capture.session).toMatchObject({
        end_reason: "application_exited",
        exit: { code: 3, signal: null },
        first_window_ms: null,
      });
      expect(capture.limitations).toContain("No application window was seen.");
      const [baseline, exit] = capture.state.checkpoints;
      expect([baseline?.name, exit?.name]).toEqual(["baseline", "exit"]);
      expect(exit?.changes).toEqual([
        expect.objectContaining({
          path: join(home, ".config/fakeapp/state.ini"),
          kind: "modified",
          after: expect.objectContaining({ sha256: sha256("count=2\n") }),
        }),
      ]);
    }, 30_000);
  },
);

describe.skipIf(process.platform !== "linux")(
  "captureDesktopApplication acknowledgements on Linux",
  () => {
    it("acknowledges each checkpoint once it is taken, with its counts, and a refused name", async () => {
      const { root, home, environment } = await fixture();
      const output = join(root, "out");
      const statePath = join(home, ".config/fakeapp/state.ini");
      const requests: SessionRequest[] = [
        { kind: "checkpoint", name: "seed" },
        { kind: "checkpoint", name: "seed" },
        { kind: "stop" },
      ];
      const events: unknown[] = [];
      const windowOpen = () =>
        events.some(
          (event) =>
            desktopCaptureEventSchema.parse(event).kind === "window_open",
        );
      const nextRequest = (): SessionRequest | undefined =>
        readFileSyncSafe(statePath) === "count=1\n" && windowOpen()
          ? requests.shift()
          : undefined;

      const evidence = await captureDesktopApplication(request(output), {
        ...host(environment, nextRequest),
        report: async (_message, event) => {
          if (event !== undefined) events.push(event);
        },
      });

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      const parsed = events.map((event) =>
        desktopCaptureEventSchema.parse(event),
      );
      expect(parsed.map((event) => event.kind)).toEqual([
        "checkpoint",
        "window_open",
        "checkpoint",
        "checkpoint_refused",
        "checkpoint",
        "checkpoint",
      ]);
      const capture = desktopApplicationCaptureSchema.parse(
        evidence.normalized_result,
      );
      const seed = capture.state.checkpoints[1];
      // The acknowledgement comes after the checkpoint is taken and carries its counts and the file the app wrote.
      expect(parsed[2]).toEqual({
        kind: "checkpoint",
        name: "seed",
        trigger: "request",
        at_ms: seed?.at_ms,
        entries: seed?.entries,
        changes: seed?.changes.length,
        retained_files: 1,
        retained_bytes: 8,
        changed_files: [".config/fakeapp/state.ini"],
        more_changed_files: 0,
      });
      expect(parsed[3]).toEqual({
        kind: "checkpoint_refused",
        name: "seed",
        reason: "A checkpoint named seed was already recorded.",
      });
      expect(parsed.slice(4)).toMatchObject([
        { name: "stop", trigger: "stop" },
        { name: "exit", trigger: "exit" },
      ]);
    }, 30_000);
  },
);

describe.skipIf(process.platform !== "linux")(
  "captureDesktopApplication retained-file cleanup on Linux",
  () => {
    it.each([1, 2])(
      "publishes the capture when a retained file's close fails %i time(s), reporting a handle still owned",
      async (closeFailures) => {
        const { root, home, environment } = await fixture();
        const output = join(root, "out");
        const statePath = join(home, ".config/fakeapp/state.ini");
        let failed: FileHandle | undefined;
        // The first close after the baseline starts is the retained file's.
        const failBaselineClose = () =>
          vi
            .spyOn(OwnedFileHandle.prototype, "close")
            .mockImplementationOnce(function (this: OwnedFileHandle) {
              failed = this.handle;
              const close = vi.spyOn(this.handle, "close");
              for (let failure = 0; failure < closeFailures; failure += 1)
                close.mockRejectedValueOnce(new Error("close denied"));
              return this.close();
            });

        let result: Awaited<ReturnType<typeof captureDesktopApplication>>;
        try {
          result = await captureDesktopApplication(request(output), {
            ...host(environment, () =>
              readFileSyncSafe(statePath) === "count=1\n"
                ? { kind: "stop" }
                : undefined,
            ),
            report: async (message) => {
              if (message === "Recording the starting state.")
                failBaselineClose();
            },
          });
        } finally {
          vi.restoreAllMocks();
          await failed?.close();
        }

        expect(failed).toBeDefined();
        expect(await readdir(output)).toContain("capture.json");
        if (closeFailures === 1) {
          expect(result).not.toHaveProperty("error");
          return;
        }
        expect(result).toMatchObject({
          code: "cleanup_incomplete",
          details: { cleanup: "incomplete", resources: [statePath] },
        });
      },
      30_000,
    );
  },
);

describe.skipIf(process.platform !== "linux")(
  "captureDesktopApplication process release on Linux",
  () => {
    it("asks the process group and token carriers outside it to exit before killing them", async () => {
      const { root, home, environment } = await fixture();
      await installProcessFamily(root, environment.PATH);
      const statePath = join(home, ".config/fakeapp/state.ini");
      let writtenAt: number | undefined;
      const nextRequest = (): SessionRequest | undefined => {
        if (readFileSyncSafe(statePath) !== "count=1\n") return undefined;
        writtenAt ??= performance.now();
        return performance.now() - writtenAt > 1500
          ? { kind: "stop" }
          : undefined;
      };

      const evidence = await captureDesktopApplication(
        request(join(root, "out")),
        host(environment, nextRequest),
      );

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      expect(
        desktopApplicationCaptureSchema.parse(evidence.normalized_result)
          .session.cleanup,
      ).toEqual({ verified: true, reason: null });
      expect(await readdir(root)).toEqual(
        expect.arrayContaining(["group-term", "setsid-term"]),
      );
    }, 30_000);

    it("stops the application gracefully and removes retained content when the session fails", async () => {
      const { root, home, environment } = await fixture();
      await installProcessFamily(root, environment.PATH);
      const statePath = join(home, ".config/fakeapp/state.ini");
      const output = join(root, "out");
      const nextRequest = (): SessionRequest | undefined =>
        readFileSyncSafe(statePath) === "count=1\n"
          ? { kind: "checkpoint", name: "written" }
          : undefined;

      const failed = await captureDesktopApplication(request(output), {
        ...host(environment, nextRequest),
        report: async (message) => {
          if (message.startsWith("Recording checkpoint"))
            throw new Error("checkpoint report failed");
        },
      });

      expect(JSON.stringify(failed)).toContain("checkpoint report failed");
      expect(await readdir(output)).toEqual([]);
      expect(await readdir(root)).toEqual(
        expect.arrayContaining(["group-term", "setsid-term"]),
      );
    }, 30_000);
  },
);

describe.skipIf(process.platform !== "linux")(
  "captureDesktopApplication refusals on Linux",
  () => {
    it("refuses to start beside an instance that already has a window", async () => {
      const { root, environment } = await fixture();
      await writeFile(join(root, "window-open"), "");
      const output = join(root, "out");

      const refused = await captureDesktopApplication(
        request(output),
        host(environment),
      );

      expect(JSON.stringify(refused)).toContain("already open");
      await expect(readdir(output)).rejects.toThrow();
    });

    it("refuses when the window list cannot be read", async () => {
      const { root, environment } = await fixture();
      await writeFile(join(root, "display-broken"), "");
      const output = join(root, "out");

      const refused = await captureDesktopApplication(
        request(output),
        host(environment),
      );

      expect(refused).toMatchObject({
        details: { reason: "display_unreadable" },
      });
      await expect(readdir(output)).rejects.toThrow();
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "captureDesktopApplication window reads on Linux",
  () => {
    it("keeps watching through window samples it could not read and names them", async () => {
      const { root, environment } = await fixture();
      const broken = join(root, "display-broken");
      await executable(
        join(environment.PATH.split(":")[0] ?? "", "fakeapp"),
        ["#!/bin/sh", `touch "${broken}"`, "exit 0"].join("\n"),
      );
      // The display recovers after the fourth sample that finds it broken.
      let unread = 0;
      const nextRequest = (): SessionRequest | undefined => {
        if (readFileSyncSafe(broken) !== undefined && (unread += 1) >= 4)
          rmSync(broken);
        return undefined;
      };

      const evidence = await captureDesktopApplication(
        request(join(root, "out")),
        host(environment, nextRequest),
      );

      if ("error" in evidence) throw new Error(JSON.stringify(evidence));
      const capture = desktopApplicationCaptureSchema.parse(
        evidence.normalized_result,
      );
      expect(capture.session.end_reason).toBe("application_exited");
      expect(unread).toBe(4);
      expect(capture.limitations).toContainEqual(
        expect.stringMatching(/^The window list could not be read in [34] /u),
      );
    }, 30_000);
  },
);

const readFileSyncSafe = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

it.skipIf(process.platform === "win32" || process.getuid?.() === 0).for([
  { denied: false, lateCancellation: false },
  { denied: true, lateCancellation: false },
  { denied: true, lateCancellation: true },
])(
  "capture baseline persistence and final cleanup cancellation (denied: $denied, late cancellation: $lateCancellation)",
  async ({ denied, lateCancellation }, context) => {
    const root = await createTestTempDirectory("capture-content-permission-");
    const home = join(root, "home");
    const state = join(home, ".config/notes");
    const output = join(root, "capture");
    const content = join(output, "content");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "state.ini"), "count=0\n");
    const controller = new AbortController();
    const reason = new Error("cancel after actual failed capture cleanup");
    const captured = captureFixture();
    let physicalFailure: unknown;
    let projectedFailure: AnalysisError | undefined;
    let baselineStarted = false;
    let stored = false;
    let discarded = false;
    let closed = false;
    const session = vi
      .spyOn(desktopSession, "runDesktopSession")
      .mockResolvedValue({
        session: captured.session,
        unreleased: undefined,
        unreadableWindowSamples: 0,
      });
    vi.spyOn(linuxInventory, "inspectLinuxApplication").mockResolvedValue({
      ok: true,
      value: {
        inventory: {
          ...captured.application,
          argv: [process.execPath],
          working_directory: home,
          state_directories: [{ path: state, exists_at_start: true }],
        },
        limitations: [],
        signingKeys: new Map(),
      },
    });
    vi.spyOn(X11WindowObserver.prototype, "sample").mockResolvedValue({
      state: "listed",
      windows: [],
    });
    const retain = DesktopContentStore.prototype.retainBytes;
    vi.spyOn(DesktopContentStore.prototype, "retainBytes").mockImplementation(
      async function (this: DesktopContentStore, bytes) {
        try {
          return await retain.call(this, bytes);
        } catch (cause: unknown) {
          physicalFailure = cause;
          throw cause;
        }
      },
    );
    const discard = DesktopContentStore.prototype.discard;
    vi.spyOn(DesktopContentStore.prototype, "discard").mockImplementation(
      async function (this: DesktopContentStore) {
        await discard.call(this);
        discarded = true;
      },
    );
    const close = DesktopContentStore.prototype.close;
    vi.spyOn(DesktopContentStore.prototype, "close").mockImplementation(
      async function (this: DesktopContentStore) {
        await close.call(this);
        closed = true;
        if (lateCancellation) {
          expect(discarded).toBe(true);
          expect(controller.signal.aborted).toBe(false);
          controller.abort(reason);
        }
      },
    );
    const project = captureFailures.projectFailure;
    vi.spyOn(captureFailures, "projectFailure").mockImplementation(
      (...args) => {
        projectedFailure = project(...args);
        return projectedFailure;
      },
    );
    try {
      const result = await captureDesktopApplication(
        {
          ...request(output),
          executable: process.execPath,
          statePaths: [state],
        },
        {
          ...host({
            HOME: home,
            DISPLAY: ":controlled",
            REA_XPROP_COMMAND: process.execPath,
          }),
          report: async (message) => {
            if (message.startsWith("Recording the starting state")) {
              baselineStarted = true;
              if (denied) await chmod(content, 0o500);
            }
          },
        },
        controller.signal,
      );
      expect(baselineStarted, JSON.stringify(result)).toBe(true);
      if (!denied) {
        expect(physicalFailure).toBeUndefined();
        expect(session).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          operation: "capture_desktop_application",
          normalized_result: { state: { content_files: 1 } },
        });
        expect(await readFile(join(content, sha256("count=0\n")), "utf8")).toBe(
          "count=0\n",
        );
        expect(closed).toBe(true);
        return;
      }
      if (physicalFailure === undefined) {
        expect(stored).toBe(true);
        context.skip(
          "Host allowed writes to the denied owner-only content directory; EACCES boundary unavailable.",
        );
      }
      expect(physicalFailure).toMatchObject({ code: "EACCES" });
      expect(session).not.toHaveBeenCalled();
      expect(discarded).toBe(true);
      expect(closed).toBe(true);
      expect(await readdir(output)).toEqual([]);
      expect(result).toMatchObject({
        error: "Desktop capture failed",
        code: "execution_failure",
      });
      expect(projectedFailure).toBeInstanceOf(ProviderAdapterError);
      expect(projectedFailure?.cause).toBe(physicalFailure);
      if (lateCancellation) {
        expect(projectedFailure?.secondaryFailures).toContainEqual(
          expect.objectContaining({
            _tag: "AnalysisCancelledError",
            cause: reason,
          }),
        );
        const cancellation = projectedFailure?.secondaryFailures.find(
          (failure) => failure instanceof AnalysisCancelledError,
        );
        expect(cancellation?.cause).toBe(reason);
      } else expect(projectedFailure?.secondaryFailures).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await chmod(content, 0o700).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves actual prelaunch inspection cancellation before native preparation or child creation",
  async () => {
    const { root, home, environment } = await fixture();
    const output = join(root, "capture-prelaunch");
    const controller = new AbortController();
    const reason = { stop: "before desktop launch" };
    const captured = captureFixture();
    let sourceFailure: unknown;
    let projectedFailure: AnalysisError | undefined;
    let baselineStored = false;
    vi.spyOn(linuxInventory, "inspectLinuxApplication").mockResolvedValue({
      ok: true,
      value: {
        inventory: {
          ...captured.application,
          argv: [process.execPath],
          working_directory: home,
          state_directories: [],
        },
        limitations: [],
        signingKeys: new Map(),
      },
    });
    vi.spyOn(X11WindowObserver.prototype, "sample").mockResolvedValue({
      state: "listed",
      windows: [],
    });
    const prepare = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockRejectedValue(new Error("native preparation must not run"));
    if (systemProcessOwnershipHost.captureBaseline === undefined)
      throw new Error(
        "existing process baseline port is required for this fixture",
      );
    const baseline = vi
      .spyOn(systemProcessOwnershipHost, "captureBaseline")
      .mockRejectedValue(new Error("native baseline inspection must not run"));
    const spawn = providerProcess.spawnOwnedProviderProcess;
    const launch = vi
      .spyOn(providerProcess, "spawnOwnedProviderProcess")
      .mockImplementation(async (options) => {
        expect(options.signal?.aborted).toBe(true);
        try {
          return await spawn(options);
        } catch (cause: unknown) {
          sourceFailure = cause;
          throw cause;
        }
      });
    const project = captureFailures.projectFailure;
    vi.spyOn(captureFailures, "projectFailure").mockImplementation(
      (...args) => {
        projectedFailure = project(...args);
        return projectedFailure;
      },
    );
    try {
      const result = await captureDesktopApplication(
        {
          ...request(output),
          executable: process.execPath,
          statePaths: [join(home, ".config/fakeapp")],
        },
        {
          ...host(environment),
          report: async (message) => {
            if (message.startsWith("Launching")) {
              expect(
                await readFile(
                  join(output, "content", sha256("count=0\n")),
                  "utf8",
                ),
              ).toBe("count=0\n");
              baselineStored = true;
              controller.abort(reason);
            }
          },
        },
        controller.signal,
      );
      expect(baselineStored).toBe(true);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(baseline).not.toHaveBeenCalled();
      expect(sourceFailure).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
      if (!(sourceFailure instanceof ProcessOwnershipInspectionCancelled))
        throw new Error("expected actual prelaunch checkpoint cancellation");
      expect(sourceFailure.reason).toBe(reason);
      expect(await readdir(output)).toEqual([]);
      expect(result).toMatchObject({
        error: "Desktop capture failed",
        code: "cancelled",
      });
      expect(projectedFailure).toBeInstanceOf(AnalysisCancelledError);
      expect(projectedFailure?.cause).toBe(reason);
    } finally {
      vi.restoreAllMocks();
    }
  },
);

const sessionInspectionFailure = async (
  cause: unknown,
  resources: readonly string[],
) => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: null,
    stderr: null,
    exitCode: 0,
    signalCode: null,
    kill: () => {
      throw new Error("Closed recording child must not be signalled");
    },
  });
  const supervisor = new providerProcess.ProviderProcessSupervisor({
    process: child,
    ownership: {
      runId: "recording-session",
      leaderPid: 42,
      processGroupId: 42,
      expectedParentPid: 1,
    },
    ownsProcessLifetime: true,
    cleanup: async () => ({ cleaned: true, signaled: false }),
  });
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  for (const inspection of samplingInspectionFailures(cause))
    supervisor.retainInspectionFailure(inspection);
  const stopped = await supervisor.stop();
  if (
    stopped.status !== "incomplete" ||
    stopped.inspectionCleanup === undefined
  )
    throw new Error("Expected actual supervisor-held inspection cleanup");
  return new desktopSession.DesktopSessionCleanupError(cause, {
    reason: stopped.reason,
    inspectionCleanup: stopped.inspectionCleanup,
    leases: [
      new AnalysisCleanupLease(async () => {
        const retried = await supervisor.stop();
        if (retried.status === "incomplete") throw new Error(retried.reason);
      }, resources),
    ],
  });
};

it.for([
  { retrySucceeds: true, sessionOwns: false, neutralBatch: false },
  { retrySucceeds: false, sessionOwns: false, neutralBatch: false },
  { retrySucceeds: false, sessionOwns: true, neutralBatch: false },
  { retrySucceeds: false, sessionOwns: true, neutralBatch: true },
])(
  "retains an actual optional inspection descriptor through capture cleanup (retry succeeds: $retrySucceeds, session owns: $sessionOwns, settled batch: $neutralBatch)",
  async ({ retrySucceeds, sessionOwns, neutralBatch }) => {
    const { root, home, environment } = await fixture();
    const output = join(root, "capture-inspection-close");
    const descriptor = await failedInspectionDescriptor();
    const descriptors = [
      descriptor,
      ...(neutralBatch ? [await failedInspectionDescriptor()] : []),
    ];
    const completed = { value: "caller-selected completed sampling peer" };
    let sourceFailure: unknown = descriptor.failure;
    const captured = captureFixture();
    let sessionFailure: desktopSession.DesktopSessionCleanupError | undefined;
    const retainedStores = new Set<DesktopContentStore>();
    let projectedFailure: AnalysisError | undefined;
    vi.spyOn(linuxInventory, "inspectLinuxApplication").mockResolvedValue({
      ok: true,
      value: {
        inventory: {
          ...captured.application,
          argv: [process.execPath],
          working_directory: home,
          state_directories: [],
        },
        limitations: [],
        signingKeys: new Map(),
      },
    });
    vi.spyOn(X11WindowObserver.prototype, "sample").mockResolvedValue({
      state: "listed",
      windows: [],
    });
    const environmentRead = vi
      .spyOn(systemProcessOwnershipHost, "environment")
      .mockRejectedValue(descriptor.failure);
    const session = vi
      .spyOn(desktopSession, "runDesktopSession")
      .mockImplementation(async () => {
        if (neutralBatch) {
          sourceFailure = await settleSamplingReads([
            Promise.reject(descriptor.failure),
            Promise.resolve(completed),
            Promise.reject(descriptors[1]!.failure),
          ]).catch((cause: unknown) => cause);
          sessionFailure = await sessionInspectionFailure(
            sourceFailure,
            descriptors.map((entry) => entry.path),
          );
          throw sessionFailure;
        }
        const observations = new SessionObservations(
          performance.now(),
          { runId: "recording-session", launchPid: process.pid },
          { names: new Set(), byPid: false },
        );
        try {
          await trackProcess(
            observations,
            process.pid,
            new AbortController().signal,
          );
        } catch (cause: unknown) {
          if (!sessionOwns) throw cause;
          sessionFailure = await sessionInspectionFailure(
            cause,
            descriptors.map((entry) => entry.path),
          );
          throw sessionFailure;
        }
        throw new Error("The actual inspection cleanup failure was swallowed");
      });
    const close = DesktopContentStore.prototype.close;
    vi.spyOn(DesktopContentStore.prototype, "close").mockImplementation(
      async function (this: DesktopContentStore) {
        retainedStores.add(this);
        if (retrySucceeds) descriptor.allow();
        await close.call(this);
      },
    );
    const project = captureFailures.projectFailure;
    vi.spyOn(captureFailures, "projectFailure").mockImplementation(
      (...args) => {
        projectedFailure = project(...args);
        return projectedFailure;
      },
    );
    try {
      const result = await captureDesktopApplication(
        { ...request(output), executable: process.execPath },
        host(environment),
      );
      expect(session).toHaveBeenCalledTimes(1);
      expect(environmentRead).toHaveBeenCalledTimes(neutralBatch ? 0 : 1);
      expect(primaryAnalysisError(projectedFailure!).cause).toBe(sourceFailure);
      expect(descriptor.closes()).toBeGreaterThan(1);
      expect(await readdir(output)).toEqual([]);
      expect(result).toMatchObject({
        code: retrySucceeds ? "execution_failure" : "cleanup_incomplete",
      });
      expect(descriptor.handle.fd === -1).toBe(retrySucceeds);
      expect(projectedFailure?.cleanupIncomplete).toBe(!retrySucceeds);
      const [retainedStore] = retainedStores;
      expect(retainedStore).toBeDefined();
      if (sessionOwns) {
        expect(retainedStore?.resourceScope.cleanupResources).toEqual([]);
        expect(sessionFailure?.cleanup.inspectionCleanup?.causes[0]).toBe(
          neutralBatch ? descriptors[0]!.failure : sourceFailure,
        );
        for (const entry of descriptors) entry.allow();
        await sessionFailure!.cleanup.leases[0]!.release();
        expect(descriptor.handle.fd).toBe(-1);
        expect(projectedFailure?.cleanupIncomplete).toBe(false);
        if (neutralBatch) {
          expect(sourceFailure).toBeInstanceOf(SamplingReadBatchFailure);
          expect(sourceFailure).toMatchObject({
            outcomes: [
              { status: "rejected" },
              { status: "fulfilled", value: completed },
              { status: "rejected" },
            ],
          });
          expect(descriptors[1]!.handle.fd).toBe(-1);
        }
      } else if (!retrySucceeds) {
        expect(retainedStore?.resourceScope.cleanupResources).toEqual([
          descriptor.path,
        ]);
        await expect(retainedStore!.close()).rejects.toBeDefined();
        descriptor.allow();
        await retainedStore!.close();
        expect(descriptor.handle.fd).toBe(-1);
        expect(retainedStore?.resourceScope.cleanupResources).toEqual([]);
        expect(projectedFailure?.cleanupIncomplete).toBe(false);
      }
    } finally {
      for (const entry of descriptors) entry.allow();
      await Promise.all([...retainedStores].map((store) => store.close()));
      await sessionFailure?.cleanup.leases[0]?.release();
      await Promise.all(
        descriptors.map((entry) => entry.failure.owner.close()),
      );
      vi.restoreAllMocks();
    }
  },
);

it.for([
  { completion: "completed", cancel: false, typedReason: false },
  { completion: "completed", cancel: true, typedReason: false },
  { completion: "completed", cancel: true, typedReason: true },
  { completion: "failed", cancel: true, typedReason: false },
] as const)(
  "preserves capture admission after actual keyring cleanup ($completion, cancel: $cancel, typed reason: $typedReason)",
  async ({ completion, cancel, typedReason }) => {
    const { root, home, environment } = await fixture();
    const source = "https://vendor.example/repo stable/main amd64 Packages";
    const sources = join(root, "vendor.list");
    const key = join(root, "vendor.gpg");
    await writeFile(key, VENDOR_A.key);
    await writeFile(
      sources,
      `deb [signed-by=${key}] https://vendor.example/repo stable main\n`,
    );
    await writeFile(
      join(root, "vendor.example_repo_InRelease"),
      "inert release bytes",
    );
    const targets = [
      `Description: ${source}`,
      `Sourcesentry: ${sources}:1`,
      "Repo-URI: https://vendor.example/repo/",
      "Release: stable",
      "Component: main",
      "Base-URI: https://vendor.example/repo/",
      `Filename: ${join(root, "Packages")}`,
    ].join("\n");
    const output = join(root, "capture-keyring");
    const controller = new AbortController();
    const reason = typedReason
      ? new AnalysisInputError("caller", { userMessage: "stop" })
      : { stop: "keyring cleanup" };
    const physical = Object.assign(
      new Error("recording verification query failed"),
      { code: "EIO" },
    );
    const captured = captureFixture();
    let keyringWritten = false;
    let keyringRemoved = false;
    let privateRoot: PrivateRuntimeRoot | undefined;
    let projectedFailure: AnalysisError | undefined;
    const create = PrivateRuntimeRoot.create.bind(PrivateRuntimeRoot);
    vi.spyOn(PrivateRuntimeRoot, "create").mockImplementationOnce(
      async (options) => {
        const owned = await create(options);
        privateRoot = owned;
        const close = owned.close.bind(owned);
        vi.spyOn(owned, "close").mockImplementationOnce(async () => {
          expect(controller.signal.aborted).toBe(false);
          expect(keyringWritten).toBe(true);
          await close();
          await expect(readdir(owned.path)).rejects.toMatchObject({
            code: "ENOENT",
          });
          keyringRemoved = true;
          if (cancel) controller.abort(reason);
        });
        return owned;
      },
    );
    const queries: string[] = [];
    vi.spyOn(linuxInventory, "inspectLinuxApplication").mockImplementation(
      async (_request, signal) => {
        const apt = await inspectAptRepositories(
          { sources: [source], origins: ["Vendor"] },
          {
            apt: { lists: root, trusted: key, trustedParts: root },
            runQuery: async (command, argv) => {
              queries.push(command);
              if (command === "apt-get")
                return { stdout: targets, exitCode: 0 };
              if (command !== "gpgv")
                throw new Error(`Unexpected command ${command}`);
              const keyring = argv[argv.indexOf("--keyring") + 1];
              expect((await readFile(keyring!)).equals(VENDOR_A.key)).toBe(
                true,
              );
              keyringWritten = true;
              if (completion === "failed") throw physical;
              return { stdout: "[GNUPG:] NEWSIG\n", exitCode: 2 };
            },
          },
          signal,
        );
        return {
          ok: true,
          value: {
            inventory: {
              ...captured.application,
              argv: [process.execPath],
              working_directory: home,
              state_directories: [],
            },
            limitations: apt.limitations,
            signingKeys: apt.keys,
          },
        };
      },
    );
    vi.spyOn(X11WindowObserver.prototype, "sample").mockResolvedValue({
      state: "listed",
      windows: [],
    });
    const session = vi
      .spyOn(desktopSession, "runDesktopSession")
      .mockResolvedValue({
        session: captured.session,
        unreleased: undefined,
        unreadableWindowSamples: 0,
      });
    const project = captureFailures.projectFailure;
    vi.spyOn(captureFailures, "projectFailure").mockImplementation(
      (...args) => {
        projectedFailure = project(...args);
        return projectedFailure;
      },
    );
    try {
      const result = await captureDesktopApplication(
        { ...request(output), executable: process.execPath },
        host(environment),
        controller.signal,
      );
      expect(queries).toEqual(["apt-get", "gpgv"]);
      expect(keyringWritten).toBe(true);
      expect(keyringRemoved).toBe(true);
      if (!cancel) {
        expect(session).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          operation: "capture_desktop_application",
        });
        return;
      }
      expect(controller.signal.reason).toBe(reason);
      expect(session).not.toHaveBeenCalled();
      if (completion === "failed") {
        expect(result).toMatchObject({ code: "execution_failure" });
        expect(projectedFailure?.cause).toBe(physical);
        expect(projectedFailure?.secondaryFailures).toContainEqual(
          expect.objectContaining({
            _tag: "AnalysisCancelledError",
            cause: reason,
          }),
        );
      } else {
        expect(result).toMatchObject({ code: "cancelled" });
        expect(projectedFailure).toBeInstanceOf(AnalysisCancelledError);
        expect(projectedFailure?.cause).toBe(reason);
      }
    } finally {
      await privateRoot?.close();
      vi.restoreAllMocks();
    }
  },
);
