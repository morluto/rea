import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { matchRegexValues } from "./RegexMatcher.js";

const { workers } = vi.hoisted(() => ({
  workers: { value: [] as unknown[] },
}));

vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    terminated = false;

    constructor() {
      super();
      workers.value.push(this);
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
      // A pattern the fake treats as stuck never replies, like a
      // catastrophic real match occupying the worker until termination.
      if (job.pattern.includes("(a+)+")) return;
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
      queueMicrotask(() =>
        this.emit("message", { status: "matched", indices }),
      );
    }

    ref(): void {}
    unref(): void {}

    terminate(): Promise<number> {
      this.terminated = true;
      queueMicrotask(() => this.emit("exit", 0));
      return Promise.resolve(0);
    }
  },
}));

const constructions = (): number => workers.value.length;
const lastWorker = (): { terminated: boolean } =>
  workers.value.at(-1) as { terminated: boolean };

it("never exceeds four workers when a fifth search queues behind stuck ones", async () => {
  const before = constructions();
  const stuckInputs = [0, 1, 2, 3].map(() => ({
    operation: "search_strings",
    pattern: "^(a+)+$",
    caseSensitive: true,
    values: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b"],
    deadline: { deadlineMs: 60, source: "runtime" as const },
  }));
  const stuck = stuckInputs.map((input) => matchRegexValues(input));
  const fifth = await matchRegexValues({
    operation: "search_strings",
    pattern: "storage",
    caseSensitive: true,
    values: ["storage/read"],
    deadline: { deadlineMs: 25, source: "runtime" },
    heapRequest: { heapMiB: 64, source: "runtime" },
  });
  expect(fifth).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  expect(constructions() - before).toBe(4);
  const settled = await Promise.all(stuck);
  expect(settled.every((result) => !result.ok)).toBe(true);
  expect(constructions() - before).toBe(4);
});

it("shares one worker across clean calls and replaces a deadline-stuck one", async () => {
  const before = constructions();
  const first = await matchRegexValues({
    operation: "search_strings",
    pattern: "storage",
    caseSensitive: true,
    values: ["storage/read", "other"],
  });
  expect(first).toEqual({ ok: true, value: [0] });
  const second = await matchRegexValues({
    operation: "search_strings",
    pattern: "read$",
    caseSensitive: true,
    values: ["storage/read", "other"],
  });
  expect(second).toEqual({ ok: true, value: [0] });
  expect(constructions() - before).toBe(1);

  const stuck = await matchRegexValues({
    operation: "search_strings",
    pattern: "^(a+)+$",
    caseSensitive: true,
    values: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b"],
    deadline: { deadlineMs: 25, source: "runtime" },
  });
  expect(stuck).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  // The stuck worker was terminated before the call returned.
  expect(lastWorker().terminated).toBe(true);

  const after = await matchRegexValues({
    operation: "search_strings",
    pattern: "storage",
    caseSensitive: true,
    values: ["storage/read"],
  });
  expect(after).toEqual({ ok: true, value: [0] });
  expect(constructions() - before).toBe(2);
});
