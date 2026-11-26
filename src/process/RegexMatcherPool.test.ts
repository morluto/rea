import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "../../tests/support/testWait.js";

const { fakeWorkers } = vi.hoisted(() => ({
  fakeWorkers: {
    generation: 0,
    constructed: 0,
    alive: 0,
    maxAlive: 0,
    failNextTerminate: false,
    instances: [] as {
      exited: boolean;
      terminated: boolean;
      terminateCalls: number;
      patterns: string[];
      releaseReply: (() => void) | undefined;
      releaseTerminate: (() => void) | undefined;
    }[],
    reset(): void {
      this.generation += 1;
      this.constructed = 0;
      this.alive = 0;
      this.maxAlive = 0;
      this.failNextTerminate = false;
      this.instances = [];
    },
  },
}));

vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    readonly generation: number;
    exited = false;
    terminated = false;
    terminateCalls = 0;
    readonly patterns: string[] = [];
    releaseReply: (() => void) | undefined;
    releaseTerminate: (() => void) | undefined;

    constructor() {
      super();
      this.generation = fakeWorkers.generation;
      fakeWorkers.constructed += 1;
      fakeWorkers.alive += 1;
      fakeWorkers.maxAlive = Math.max(fakeWorkers.maxAlive, fakeWorkers.alive);
      fakeWorkers.instances.push(this);
    }

    postMessage(job: {
      pattern: string;
      caseSensitive: boolean;
      packed: {
        lengthsBuffer: ArrayBuffer;
        chunks: readonly {
          buffer: ArrayBuffer;
          encoding: "latin1" | "utf16le";
          startIndex: number;
          count: number;
        }[];
      };
    }): void {
      this.patterns.push(job.pattern);
      if (job.pattern.includes("(a+)+")) return;
      const deliver = (): void => {
        const expression = new RegExp(
          job.pattern,
          job.caseSensitive ? "u" : "iu",
        );
        const lengths = new Uint32Array(job.packed.lengthsBuffer);
        const indices: number[] = [];
        for (const chunk of job.packed.chunks) {
          const block = Buffer.from(chunk.buffer).toString(chunk.encoding);
          let offset = 0;
          for (
            let index = chunk.startIndex, end = index + chunk.count;
            index < end;
            index += 1
          ) {
            const len = lengths[index]!;
            if (expression.test(block.slice(offset, offset + len)))
              indices.push(index);
            offset += len;
          }
        }
        this.emit("message", { status: "matched", indices });
      };
      if (job.pattern.startsWith("HOLD")) {
        this.releaseReply = deliver;
        return;
      }
      queueMicrotask(deliver);
    }

    ref(): void {}
    unref(): void {}

    private markExited(code: number): void {
      if (this.exited) return;
      this.exited = true;
      if (this.generation === fakeWorkers.generation) fakeWorkers.alive -= 1;
      this.emit("exit", code);
    }

    terminate(): Promise<number> {
      this.terminated = true;
      this.terminateCalls += 1;
      if (fakeWorkers.failNextTerminate) {
        fakeWorkers.failNextTerminate = false;
        return Promise.reject(new Error("terminate refused"));
      }
      if (this.releaseTerminate !== undefined) {
        return new Promise((resolve) => {
          this.releaseTerminate = () => {
            queueMicrotask(() => {
              this.markExited(1);
              resolve(1);
            });
          };
        });
      }
      return new Promise((resolve) => {
        queueMicrotask(() => {
          this.markExited(0);
          resolve(0);
        });
      });
    }
  },
}));

let matchRegexValues: typeof import("./RegexMatcher.js").matchRegexValues;
let projectAnalysisError: typeof import("../domain/analysisErrorProjection.js").projectAnalysisError;

const deadline = (deadlineMs: number) =>
  ({ deadlineMs, source: "runtime" }) as const;
const heap = (heapMiB: number) => ({ heapMiB, source: "runtime" }) as const;

const search = (
  pattern: string,
  values: readonly string[],
  options: {
    readonly deadlineMs?: number;
    readonly heapMiB?: number;
    readonly signal?: AbortSignal;
  } = {},
) =>
  matchRegexValues({
    operation: "search_strings",
    pattern,
    caseSensitive: true,
    values,
    ...(options.deadlineMs === undefined
      ? {}
      : { deadline: deadline(options.deadlineMs) }),
    ...(options.heapMiB === undefined
      ? {}
      : { heapRequest: heap(options.heapMiB) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

beforeEach(async () => {
  fakeWorkers.reset();
  vi.resetModules();
  ({ matchRegexValues } = await import("./RegexMatcher.js"));
  ({ projectAnalysisError } =
    await import("../domain/analysisErrorProjection.js"));
});

const releaseHeldWorkers = (): void => {
  for (const worker of fakeWorkers.instances) {
    const reply = worker.releaseReply;
    const stop = worker.releaseTerminate;
    worker.releaseReply = undefined;
    worker.releaseTerminate = undefined;
    reply?.();
    stop?.();
  }
};

it("reclaims the incompatible idle worker instead of starting a fifth", async () => {
  const held = [0, 1, 2, 3].map((index) =>
    search(`HOLD-${String(index)}`, [`HOLD-${String(index)}`], {
      heapMiB: 128,
      deadlineMs: 2_000,
    }),
  );
  const queued = search("storage", ["storage"], {
    heapMiB: 64,
    deadlineMs: 2_000,
  });
  try {
    await waitFor(() => {
      expect(fakeWorkers.constructed).toBe(4);
      expect(
        fakeWorkers.instances.every(
          (worker) => worker.releaseReply !== undefined,
        ),
      ).toBe(true);
    });
    await Promise.resolve();
    expect(fakeWorkers.constructed).toBe(4);
    const finished = fakeWorkers.instances[0];
    const release = finished?.releaseReply;
    if (finished === undefined || release === undefined)
      throw new Error("expected the first worker to be holding its reply");
    finished.releaseReply = undefined;
    release();
    expect(await held[0]).toEqual({ ok: true, value: [0] });
    const second = await search("other", ["other"], {
      heapMiB: 64,
      deadlineMs: 500,
    });
    expect(second).toEqual({ ok: true, value: [0] });
    expect(await queued).toEqual({ ok: true, value: [0] });
    const exited = fakeWorkers.instances.filter((worker) => worker.exited);
    const replacements = fakeWorkers.instances.filter((worker) =>
      worker.patterns.includes("storage"),
    );
    // Four original workers plus the one replacement. A second spawn is a fifth live worker.
    expect(fakeWorkers.constructed).toBe(5);
    expect(fakeWorkers.maxAlive).toBeLessThanOrEqual(4);
    expect(exited).toEqual([finished]);
    expect(finished.patterns).toEqual(["HOLD-0"]);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.patterns).toEqual(["storage", "other"]);
  } finally {
    releaseHeldWorkers();
    await Promise.allSettled([...held, queued]);
  }
});

it("reclaims idle workers of another heap before the idle timeout", async () => {
  await Promise.all(
    [0, 1, 2, 3].map(() => search("storage", ["storage"], { heapMiB: 128 })),
  );
  expect(fakeWorkers.constructed).toBe(4);
  expect(fakeWorkers.alive).toBe(4);
  const started = performance.now();
  const changed = await search("storage", ["storage"], {
    heapMiB: 64,
    deadlineMs: 500,
  });
  expect(performance.now() - started).toBeLessThan(500);
  expect(changed).toEqual({ ok: true, value: [0] });
  expect(fakeWorkers.maxAlive).toBeLessThanOrEqual(4);
  expect(fakeWorkers.alive).toBe(4);
  expect(fakeWorkers.constructed).toBe(5);
  expect(fakeWorkers.instances.filter((worker) => worker.exited)).toHaveLength(
    1,
  );
});

it("shares one worker across clean calls and replaces only the timed-out worker", async () => {
  expect(await search("alpha", ["alpha", "beta"])).toEqual({
    ok: true,
    value: [0],
  });
  expect(await search("beta", ["alpha", "beta"])).toEqual({
    ok: true,
    value: [1],
  });
  expect(fakeWorkers.constructed).toBe(1);
  expect(fakeWorkers.instances[0]?.patterns).toEqual(["alpha", "beta"]);

  const held = search("HOLD", ["HOLD"], { deadlineMs: 2_000 });
  try {
    await waitFor(() => {
      expect(fakeWorkers.instances[0]?.patterns).toContain("HOLD");
    });
    const stuck = await search(
      "^(a+)+$",
      ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b"],
      { deadlineMs: 25 },
    );
    if (stuck.ok)
      throw new Error("expected the stuck pattern to miss its deadline");
    expect(projectAnalysisError(stuck.error)).toMatchObject({
      code: "resource_constraint",
      details: {
        operation: "search_strings",
        resource: "cpu",
        reported_limits: {
          matching_deadline_ms: 25,
          matching_deadline_source: "runtime",
        },
      },
    });
    expect(fakeWorkers.instances[0]?.terminated).toBe(false);
    expect(fakeWorkers.instances[1]?.terminated).toBe(true);
    expect(fakeWorkers.instances[1]?.exited).toBe(true);
    expect(fakeWorkers.constructed).toBe(2);
    const release = fakeWorkers.instances[0]?.releaseReply;
    if (release === undefined)
      throw new Error("expected the held worker to stay in use");
    fakeWorkers.instances[0]!.releaseReply = undefined;
    release();
    expect(await held).toEqual({ ok: true, value: [0] });
    expect(fakeWorkers.instances[0]?.terminated).toBe(false);
    expect(fakeWorkers.maxAlive).toBeLessThanOrEqual(2);

    const after = await search("storage", ["storage/read"]);
    expect(after).toEqual({ ok: true, value: [0] });
    expect(fakeWorkers.instances[0]?.patterns).toContain("storage");
    expect(fakeWorkers.instances[1]?.patterns).not.toContain("storage");
    expect(fakeWorkers.constructed).toBe(2);
  } finally {
    releaseHeldWorkers();
    await Promise.allSettled([held]);
  }
});

it("waits for worker exit when the caller aborts during termination", async () => {
  const controller = new AbortController();
  const reason = { request: "stop search" };
  let exitedBeforeReturn = false;
  const pending = search("HOLD", ["HOLD"], {
    deadlineMs: 5_000,
    signal: controller.signal,
  }).then((result) => {
    exitedBeforeReturn = fakeWorkers.instances[0]?.exited === true;
    return result;
  });
  try {
    await waitFor(() => {
      expect(fakeWorkers.instances[0]?.releaseReply).toBeTypeOf("function");
    });
    const worker = fakeWorkers.instances[0];
    if (worker === undefined) throw new Error("expected a worker");
    worker.releaseTerminate = () => undefined;
    controller.abort(reason);
    await waitFor(() => {
      expect(worker.terminated).toBe(true);
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    const release = worker.releaseTerminate;
    if (release === undefined)
      throw new Error("expected termination to be held");
    worker.releaseTerminate = undefined;
    release();
    const result = await pending;
    expect(exitedBeforeReturn).toBe(true);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error.cause).toBe(reason);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cancelled",
      details: {
        operation: "search_strings",
        cleanup: "complete",
      },
    });
    expect(result.error.secondaryFailures).toEqual([]);
  } finally {
    releaseHeldWorkers();
    await pending;
  }
});

it("keeps the deadline when termination fails and retries the owned worker", async () => {
  fakeWorkers.failNextTerminate = true;
  const stuck = await search(
    "^(a+)+$",
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b"],
    { deadlineMs: 25 },
  );
  const worker = fakeWorkers.instances[0];
  if (worker === undefined) throw new Error("expected a worker");
  if (stuck.ok)
    throw new Error("expected the stuck pattern to miss its deadline");
  expect(worker.exited).toBe(false);
  expect(fakeWorkers.alive).toBe(1);
  expect(worker.terminateCalls).toBe(1);
  expect(projectAnalysisError(stuck.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      operation: "search_strings",
      resource: "cpu",
      reported_limits: {
        matching_deadline_ms: 25,
        matching_deadline_source: "runtime",
      },
      secondary_failures: [
        {
          code: "cleanup_incomplete",
          details: {
            operation: "search_strings",
            reason: "Regex worker did not stop after its match ended",
            diagnostics: { worker_heap_mib: 128 },
            cleanup: "incomplete",
            resources: ["regex-worker"],
            cleanup_reason: "Regex worker termination failed",
          },
        },
      ],
    },
  });
  expect(await search("storage", ["storage"], { deadlineMs: 500 })).toEqual({
    ok: true,
    value: [0],
  });
  expect(worker.terminateCalls).toBe(2);
  expect(worker.exited).toBe(true);
  expect(fakeWorkers.constructed).toBe(2);
  expect(fakeWorkers.maxAlive).toBeLessThanOrEqual(4);
});

it("does not post to or terminate an idle worker when the signal aborts after acquisition and before dispatch", async () => {
  const first = await search("alpha", ["alpha", "beta"]);
  expect(first).toEqual({ ok: true, value: [0] });
  const worker = fakeWorkers.instances[0]!;
  expect(worker.patterns).toEqual(["alpha"]);

  const controller = new AbortController();
  const reason = { phase: "after-acquisition" };
  // Acquisition of an idle worker resolves on the next microtask, before dispatch.
  const pending = search("beta", ["alpha", "beta"], {
    signal: controller.signal,
  });
  controller.abort(reason);
  const aborted = await pending;

  if (aborted.ok) throw new Error("expected cancellation");
  expect(aborted.error.cause).toBe(reason);
  expect(projectAnalysisError(aborted.error)).toMatchObject({
    code: "cancelled",
    details: { operation: "search_strings" },
  });
  expect(worker.patterns).toEqual(["alpha"]);
  expect(worker.exited).toBe(false);
  expect(worker.terminateCalls).toBe(0);
  expect(await search("gamma", ["gamma"])).toEqual({ ok: true, value: [0] });
  expect(worker.patterns).toEqual(["alpha", "gamma"]);
  expect(fakeWorkers.constructed).toBe(1);
});
