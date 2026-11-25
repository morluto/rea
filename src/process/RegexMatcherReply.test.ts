import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { matchRegexValues } from "./RegexMatcher.js";

const { reply } = vi.hoisted(() => ({
  reply: { value: undefined as unknown },
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    postMessage(): void {
      queueMicrotask(() => this.emit("message", reply.value));
    }

    ref(): void {}
    unref(): void {}

    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  },
}));

it.each([
  [{ status: "invalid_pattern", reason: 42 }, "reply is malformed"],
  [
    { status: "invalid_pattern", reason: "invalid", extra: true },
    "reply is malformed",
  ],
  [{ status: "matched", wrong: [] }, "reply is malformed"],
  [{ status: "matched", indices: [0], extra: true }, "reply is malformed"],
  [{ status: "matched", indices: [-1] }, "reply is malformed"],
  [{ status: "matched", indices: [0.5] }, "reply is malformed"],
  [{ status: "matched", indices: [2, "0"] }, "reply is malformed"],
  [{ status: "matched", indices: [2] }, "invalid inventory indices"],
  [{ status: "matched", indices: [0, 0] }, "invalid inventory indices"],
  [{ status: "matched", indices: [1, 0] }, "invalid inventory indices"],
] as const)(
  "rejects a worker reply %j at the matching boundary",
  async (message, reason) => {
    reply.value = message;
    await expect(
      matchRegexValues({
        operation: "search_procedures",
        pattern: "main",
        caseSensitive: true,
        values: ["main", "domain"],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        message: expect.stringContaining(reason),
      },
    });
  },
);
