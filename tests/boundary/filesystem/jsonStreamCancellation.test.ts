import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readJsonObjectMembersFile } from "../../../src/application/JsonFiles.js";
import { RegularFileOperationCancelled } from "../../../src/filesystem/RegularFile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const observedStream = vi.hoisted(() => ({
  stream: undefined as
    | { on(event: string, listener: () => void): unknown }
    | undefined,
}));
vi.mock("stream-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stream-chain")>();
  return {
    ...actual,
    asStream: (...args: Parameters<typeof actual.asStream>) => {
      const stream = actual.asStream(...args);
      observedStream.stream = stream;
      return stream;
    },
  };
});

const runtimeFailure = vi.hoisted(() => ({
  injection: undefined as
    | { readonly leaf: unknown; aggregate: AggregateError | undefined }
    | undefined,
}));
vi.mock("node:stream/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:stream/promises")>();
  return {
    ...actual,
    pipeline: async (...args: Parameters<typeof actual.pipeline>) => {
      try {
        return await actual.pipeline(...args);
      } catch (cause: unknown) {
        if (runtimeFailure.injection === undefined) throw cause;
        const aggregate = new AggregateError(
          [cause, runtimeFailure.injection.leaf],
          "controlled mixed pipeline failure",
        );
        runtimeFailure.injection.aggregate = aggregate;
        throw aggregate;
      }
    },
  };
});

it.each([
  { phase: "before EOF", consumer: "complete" },
  { phase: "after EOF", consumer: "complete" },
  { phase: "before EOF", consumer: "unrelated failure" },
  { phase: "before EOF", consumer: "foreign cancellation" },
  { phase: "before EOF", consumer: "cyclic aggregate" },
])(
  "preserves streamed JSON facts $phase with $consumer",
  async ({ phase, consumer }) => {
    const root = await createTestTempDirectory("rea-json-member-cancel-");
    const path = join(root, "input.json");
    await writeFile(path, " ".repeat(8 * 1024 * 1024) + '{"items":[1,2]}');
    const controller = new AbortController();
    const reason = { caller: "cancel while accepting a member" };
    const consumerFailure =
      consumer === "foreign cancellation"
        ? new AggregateError(
            [
              new RegularFileOperationCancelled({
                caller: "another operation",
              }),
            ],
            "foreign operation cancellation",
          )
        : consumer === "cyclic aggregate"
          ? new AggregateError([], "unproven consumer aggregate")
          : new Error("independent member consumer failure");
    if (consumerFailure instanceof AggregateError)
      consumerFailure.errors.push(consumerFailure);
    let accepting = () => {};
    const accepted = new Promise<void>((resolve) => {
      accepting = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawEof = () => {};
    let eofObserved = false;
    const ended = new Promise<void>((resolve) => {
      sawEof = resolve;
    });
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read(
        this: FileHandle,
        ...args: [Buffer, number, number, number | null]
      ): Promise<{ readonly bytesRead: number; readonly buffer: Buffer }>;
    };
    await probe.close();
    const read = prototype.read;
    const reading = vi
      .spyOn(prototype, "read")
      .mockImplementation(async function (
        this: FileHandle,
        ...args: [Buffer, number, number, number | null]
      ) {
        const value = await read.call(this, ...args);
        if (value.bytesRead === 0) {
          eofObserved = true;
          sawEof();
        }
        return value;
      });
    const pending = readJsonObjectMembersFile(
      path,
      [
        new Map([
          [
            "items",
            {
              mode: "array" as const,
              begin() {},
              reject(cause: unknown) {
                throw cause;
              },
              async accept() {
                accepting();
                await gate;
                if (consumer !== "complete") throw consumerFailure;
              },
            },
          ],
        ]),
      ],
      controller.signal,
    );
    try {
      await accepted;
      if (phase === "after EOF") {
        await ended;
        // The zero-byte descriptor read resumes its generator before cancellation.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(eofObserved).toBe(phase === "after EOF");
      if (consumer === "complete") controller.abort(reason);
      else {
        // Observe a real consumer error after pipeline's own error listeners,
        // then cancel while that same pipeline is settling the failure.
        if (observedStream.stream === undefined)
          throw new Error("Missing JSON stream");
        observedStream.stream.on("error", () => controller.abort(reason));
      }
      release();
      const result = await pending;
      if (result.ok)
        throw new Error("Expected cancellation or consumer failure");
      if (consumer === "complete") {
        expect(result.error).toMatchObject({ _tag: "AnalysisCancelledError" });
        expect(result.error.cause).toBe(reason);
      } else {
        expect(result.error).toMatchObject({
          _tag: "EvidenceFileError",
          reason: "io",
        });
        if (consumer !== "unrelated failure")
          expect(result.error.cause).toBeInstanceOf(AggregateError);
        const pendingFailures = [result.error.cause];
        const observed = new Set<unknown>();
        while (pendingFailures.length > 0) {
          const failure = pendingFailures.pop();
          if (observed.has(failure)) continue;
          observed.add(failure);
          if (failure instanceof AggregateError)
            for (const nested of failure.errors) pendingFailures.push(nested);
        }
        expect(observed.has(consumerFailure)).toBe(true);
      }
    } finally {
      controller.abort(reason);
      release();
      await pending;
      reading.mockRestore();
    }
  },
);

// These cases retain the real Node rejection and add a controlled independent
// input failure. They do not claim Node preserves a consumer failure that it
// omits after cancellation wins the stream race.
it.each([
  "consumer",
  "foreign cancellation",
  "cyclic",
  "unreadable",
  "undefined",
])("retains controlled mixed pipeline failure with %s leaf", async (kind) => {
  const root = await createTestTempDirectory("rea-json-mixed-cancel-");
  const path = join(root, "input.json");
  await writeFile(path, " ".repeat(8 * 1024 * 1024) + '{"items":[1,2]}');
  const controller = new AbortController();
  const reason = { caller: "stop this read" };
  let leaf: unknown = new Error("independent consumer failure");
  if (kind === "foreign cancellation")
    leaf = new RegularFileOperationCancelled({ caller: "another operation" });
  if (kind === "undefined") leaf = undefined;
  if (kind === "cyclic") {
    const cycle = new AggregateError([], "cyclic consumer failure");
    cycle.errors.push(cycle);
    leaf = cycle;
  }
  if (kind === "unreadable") {
    leaf = new AggregateError([], "unreadable consumer failure");
    Object.defineProperty(leaf, "errors", {
      get() {
        throw new Error("unreadable aggregate contents");
      },
    });
  }
  const injection = {
    leaf,
    aggregate: undefined as AggregateError | undefined,
  };
  runtimeFailure.injection = injection;
  let accepting = () => {};
  const accepted = new Promise<void>((resolve) => {
    accepting = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = readJsonObjectMembersFile(
    path,
    [
      new Map([
        [
          "items",
          {
            mode: "array" as const,
            begin() {},
            reject(cause: unknown) {
              throw cause;
            },
            async accept() {
              accepting();
              await gate;
            },
          },
        ],
      ]),
    ],
    controller.signal,
  );
  try {
    await accepted;
    controller.abort(reason);
    release();
    const result = await pending;
    if (result.ok) throw new Error("Expected the mixed pipeline failure");
    expect(result.error).toMatchObject({
      _tag: "EvidenceFileError",
      reason: "io",
    });
    expect(injection.aggregate).toBeInstanceOf(AggregateError);
    expect(result.error.cause).toBe(injection.aggregate);
    expect(injection.aggregate?.errors[1]).toBe(leaf);
  } finally {
    controller.abort(reason);
    release();
    await pending;
    runtimeFailure.injection = undefined;
  }
});
