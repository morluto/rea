import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";

const fixture = vi.hoisted(() => {
  let start!: () => void;
  let aborted!: () => void;
  let release!: () => void;
  let started: Promise<void>;
  let stopped: Promise<void>;
  let gate: Promise<void>;
  let mode: "failure" | "abort" | "cleanup" | "abort-error";
  let failRemoval = false;
  let calls = 0;
  const compilerFailure = new Error("controlled compiler failure");
  const compilerAbortError = new DOMException(
    "independent compiler failure",
    "AbortError",
  );
  return {
    compilerFailure,
    compilerAbortError,
    configure(selected: "failure" | "abort" | "cleanup" | "abort-error") {
      failRemoval = selected === "cleanup";
      mode = selected;
      calls = 0;
      started = new Promise((resolve) => {
        start = resolve;
      });
      stopped = new Promise((resolve) => {
        aborted = resolve;
      });
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    remove() {
      if (failRemoval) {
        failRemoval = false;
        throw new Error("controlled cleanup failure");
      }
    },
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    release() {
      release();
    },
    get calls() {
      return calls;
    },
    async run(
      path: string,
      args: readonly string[],
      options: { signal?: AbortSignal },
    ) {
      if (basename(path) !== "fixture-swiftc")
        throw new Error("unexpected helper");
      calls++;
      if (calls === 1) {
        options.signal?.addEventListener("abort", aborted, { once: true });
        start();
        await gate;
        if (mode === "abort-error") throw compilerAbortError;
        if (mode !== "failure") throw options.signal?.reason;
        throw compilerFailure;
      }
      const output = args[args.indexOf("-o") + 1];
      if (output === undefined) throw new Error("missing output");
      await writeFile(output, "fixture");
      return { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 };
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).includes("rea-process-token-")) fixture.remove();
      return actual.rm(...args);
    },
  };
});
vi.mock("./ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ExecFileOutput.js")>()),
  execFileOutput: fixture.run,
}));
import {
  createDarwinProcessRunTokenReader,
  DarwinProcessOwnershipInspectionError,
} from "./DarwinProcessRunTokenReader.js";

it.each(["failure", "abort", "cleanup", "abort-error"] as const)(
  "handles a %s outcome for a waiter joining retirement",
  async (mode) => {
    fixture.configure(mode);
    const reader = createDarwinProcessRunTokenReader({
      compiler: {
        kind: "swiftc",
        executable: join(tmpdir(), "fixture-swiftc"),
        sdkRoot: tmpdir(),
      },
      environment: {},
    });
    const controller = new AbortController();
    const first = reader.prepare(controller.signal);
    let second: Promise<string> | undefined;
    onTestFinished(async () => {
      fixture.release();
      await Promise.allSettled([first, second, reader.close()]);
    });
    await fixture.started;
    controller.abort(new Error("first caller left"));
    await fixture.stopped;
    second = reader.prepare();
    fixture.release();
    if (mode === "cleanup")
      await expect(first).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "first caller left" }),
      });
    else await expect(first).rejects.toThrow("first caller left");
    if (mode === "failure" || mode === "abort-error") {
      await expect(second).rejects.toMatchObject({
        cause:
          mode === "failure"
            ? fixture.compilerFailure
            : fixture.compilerAbortError,
      });
      expect(fixture.calls).toBe(1);
    } else if (mode === "cleanup") {
      const failure = await second.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(DarwinProcessOwnershipInspectionError);
      if (!(failure instanceof DarwinProcessOwnershipInspectionError))
        throw new Error("expected cleanup owner");
      expect(failure.cleanupFailure?.cleanupIncomplete).toBe(true);
      expect(fixture.calls).toBe(1);
      await failure.cleanupOwner?.close();
      expect(failure.cleanupFailure?.cleanupIncomplete).toBe(false);
    } else {
      await expect(second).resolves.toMatch(/reader$/);
      expect(fixture.calls).toBe(2);
    }
  },
);
