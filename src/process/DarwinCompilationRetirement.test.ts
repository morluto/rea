import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { access, writeFile } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";

const fixture = vi.hoisted(() => {
  let start!: () => void;
  let aborted!: () => void;
  let release!: () => void;
  let started: Promise<void>;
  let stopped: Promise<void>;
  let gate: Promise<void>;
  let mode: "failure" | "abort" | "cleanup" | "retained-root";
  let failRemoval = false;
  let failRemovals = 0;
  let calls = 0;
  const compilerFailure = new Error("controlled compiler failure");
  return {
    compilerFailure,
    configure(selected: "failure" | "abort" | "cleanup" | "retained-root") {
      failRemoval = selected === "cleanup";
      failRemovals = selected === "retained-root" ? 2 : 0;
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
      if (failRemovals > 0) {
        failRemovals -= 1;
        throw new Error("controlled cleanup failure");
      }
    },
    allowRemoval() {
      failRemoval = false;
      failRemovals = 0;
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
      if (mode === "retained-root" && calls === 1) throw compilerFailure;
      if (calls === 1) {
        options.signal?.addEventListener("abort", aborted, { once: true });
        start();
        await gate;
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

it.each(["failure", "abort", "cleanup"] as const)(
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
    if (mode === "failure") {
      await expect(second).rejects.toMatchObject({
        cause: fixture.compilerFailure,
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

it("keeps a leftover helper root owned when preparation retries removal", async () => {
  fixture.configure("retained-root");
  const reader = createDarwinProcessRunTokenReader({
    compiler: {
      kind: "swiftc",
      executable: join(tmpdir(), "fixture-swiftc"),
      sdkRoot: tmpdir(),
    },
    environment: {},
  });
  onTestFinished(async () => {
    fixture.allowRemoval();
    await reader.close();
  });

  const first = await reader.prepare().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(first).toBeInstanceOf(DarwinProcessOwnershipInspectionError);
  expect(fixture.calls).toBe(1);

  const second = await reader.prepare().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(second).toBeInstanceOf(DarwinProcessOwnershipInspectionError);
  if (!(second instanceof DarwinProcessOwnershipInspectionError))
    throw new Error("expected cleanup owner");
  expect(second.cleanupFailure).toBeInstanceOf(ProviderCleanupError);
  expect(second.cleanupFailure?.cleanupIncomplete).toBe(true);
  expect(second.cleanupOwner).toBeDefined();
  expect(fixture.calls).toBe(1);
  const [retainedRoot] = second.cleanupFailure?.cleanupResources ?? [];
  if (retainedRoot === undefined)
    throw new Error("expected retained helper root");
  await expect(access(retainedRoot)).resolves.toBeUndefined();

  await second.cleanupOwner?.close();
  expect(second.cleanupFailure?.cleanupIncomplete).toBe(false);
  await expect(access(retainedRoot)).rejects.toMatchObject({ code: "ENOENT" });

  await expect(reader.prepare()).resolves.toMatch(/reader$/);
  expect(fixture.calls).toBe(2);
});
