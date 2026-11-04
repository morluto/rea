import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { desktopApplicationCaptureSchema } from "../../domain/desktop/desktopCapture.js";
import type { SessionRequest } from "../../desktop/DesktopApplicationSession.js";
import {
  captureDesktopApplication,
  type DesktopCaptureRequest,
} from "./DesktopApplicationCapture.js";

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
  });
});

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

const readFileSyncSafe = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
