import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { processWorkerCleanup } from "../../process/OwnedWorkerRuntime.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { readerViewsOfBytes } from "./DesktopTaskReaders.js";
import { desktopOperationFailure } from "./DesktopCaptureRefusals.js";

it("retains a reader process and its files after cleanup fails and retries before another reader", async () => {
  const reason = new Error("caller cancelled");
  const stop = vi
    .fn()
    .mockResolvedValueOnce({ status: "incomplete", reason: "still running" })
    .mockResolvedValueOnce({ status: "stopped" });
  const dispose = vi.fn();
  const owner = { stop, dispose } as unknown as ProviderProcessSupervisor;
  const commandFailure = new OwnedCommandFailure(
    "cancelled",
    "cancelled",
    null,
    "still running",
    { cancellation: { reason } },
    ["reader-run"],
    owner,
  );
  const readers = [
    {
      id: "first",
      file: "first.txt",
      argv: ["reader", "{file}"],
      output: "json" as const,
    },
    {
      id: "second",
      file: "second.txt",
      argv: ["reader", "{file}"],
      output: "json" as const,
    },
  ];
  let folder = "";
  const run = vi.fn(async (argv: readonly string[]) => {
    const args = JSON.parse(argv.slice(4).join("")) as {
      id: string;
      work: string;
    };
    if (args.id === "second") {
      folder = args.work;
      throw commandFailure;
    }
    return {
      exit_code: 0,
      stdout: JSON.stringify({ view: { format: "json", view: { value: 42 } } }),
      stderr: "",
      timed_out: false,
    };
  });
  const read = () =>
    readerViewsOfBytes(
      readers,
      async () => ({ kind: "bytes", bytes: Buffer.from("input") }),
      run,
    );
  const failure: unknown = await read().catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  const error = failure as ProviderCleanupError;
  try {
    expect(error.cleanupPrimary?.cause).toBe(reason);
    const cancelled = new AbortController();
    cancelled.abort(reason);
    expect(
      desktopOperationFailure(
        error,
        cancelled.signal,
        "export_desktop_application",
        "Desktop export",
      ),
    ).toBe(error);
    expect(existsSync(folder)).toBe(true);
    expect(projectAnalysisError(error)).toMatchObject({
      details: {
        resources: ["reader-run", folder],
        diagnostics: {
          completed_reader_views: {
            first: { format: "json", view: { value: 42 } },
          },
        },
      },
    });
    await expect(read()).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(2);
    expect(existsSync(folder)).toBe(true);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(folder, 0o500);
      try {
        await expect(processWorkerCleanup.retry()).rejects.toBe(error);
        expect(error.cleanupResources).toEqual([folder]);
        expect(error.cleanupIncomplete).toBe(true);
      } finally {
        await chmod(folder, 0o700);
      }
    }
    await Promise.all([
      processWorkerCleanup.retry(),
      processWorkerCleanup.retry(),
    ]);
    expect(existsSync(folder)).toBe(false);
    expect(error.cleanupIncomplete).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    await processWorkerCleanup.retry();
  }
});

it.each([
  [
    { view: { format: "json", view: { value: 7 } } },
    {
      completed_reader_views: { item: { format: "json", view: { value: 7 } } },
    },
  ],
  [{ absent: true }, { completed_reader_absent: ["item"] }],
])(
  "preserves the final reader answer if cancellation arrives during cleanup",
  async (answer, diagnostics) => {
    const output = JSON.stringify(answer);
    const snapshot = {
      exitCode: 0,
      stdout: {
        text: output,
        bytes: Buffer.byteLength(output),
        observedBytes: Buffer.byteLength(output),
      },
      stderr: { text: "", bytes: 0, observedBytes: 0 },
      signal: null,
    };
    const reason = new Error("late cancellation");
    const failure = await readerViewsOfBytes(
      [
        {
          id: "item",
          file: "item.txt",
          argv: ["reader", "{file}"],
          output: "json",
        },
      ],
      async () => ({ kind: "bytes", bytes: Buffer.from("input") }),
      async () => {
        throw new OwnedCommandFailure(
          "cancelled",
          "cancelled",
          snapshot,
          null,
          { cancellation: { reason } },
        );
      },
    ).catch((cause: unknown) => cause);
    expect(
      projectAnalysisError(
        failure as import("../../domain/analysisErrorBase.js").AnalysisError,
      ),
    ).toMatchObject({ code: "cancelled", details: { diagnostics } });
    expect((failure as Error).cause).toBe(reason);
  },
);

it("preserves completed views and source absences when a later source read fails", async () => {
  const sourceFailure = new Error("cannot read the third retained file");
  const failure = await readerViewsOfBytes(
    ["first", "absent", "third"].map((id) => ({
      id,
      file: `${id}.txt`,
      argv: ["reader", "{file}"],
      output: "json" as const,
    })),
    async ({ id }) => {
      if (id === "third") throw sourceFailure;
      return id === "absent"
        ? { kind: "absent" }
        : { kind: "bytes", bytes: Buffer.from("input") };
    },
    async () => ({
      exit_code: 0,
      stdout: JSON.stringify({ view: { format: "json", view: { value: 7 } } }),
      stderr: "",
      timed_out: false,
    }),
  ).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    cause: sourceFailure,
    diagnostics: {
      completed_reader_views: { first: { format: "json", view: { value: 7 } } },
      completed_reader_absent: ["absent"],
    },
  });
});
