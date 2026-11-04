import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it } from "vitest";

import {
  digestFile,
  POST_RUN_ARTIFACT_UNREADABLE,
} from "../../src/application/reverse/ReverseEngineeringService.js";
import {
  FileWork,
  FileWorkSaturatedError,
} from "../../src/process/FileWork.js";
import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";

it("bounds concurrent reverse-engineering provider calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-capacity-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let mode: "success" | "failure" | "timeout" = "success";
  const service = new TestReverseEngineeringService({
    run: async () => {
      calls += 1;
      if (mode === "failure")
        throw Object.assign(new Error("provider failed"), { code: "ENOENT" });
      if (mode === "timeout")
        throw Object.assign(new Error("provider timed out"), {
          code: "ETIMEDOUT",
        });
      await gate;
      return { stdout: "", stderr: "" };
    },
  });

  try {
    const active = Array.from({ length: 8 }, () =>
      service.inspectWithObjdump({ path, operation: "file_headers" }),
    );
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      service.inspectWithObjdump(
        { path, operation: "file_headers" },
        { signal: preAborted.signal },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    await expect(
      service.inspectWithObjdump({ path, operation: "file_headers" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "transport",
        reportedLimits: {
          max_concurrent_operations: 8,
          active_operations: 8,
        },
      },
    });
    release();
    const results = await Promise.all(active);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls).toBe(8);

    mode = "failure";
    const failed = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.inspectWithObjdump({ path, operation: "file_headers" }),
      ),
    );
    expect(failed.every((result) => !result.ok)).toBe(true);

    mode = "timeout";
    const timedOut = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.inspectWithObjdump({ path, operation: "file_headers" }),
      ),
    );
    expect(timedOut.every((result) => !result.ok)).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.inspectWithObjdump(
          { path, operation: "file_headers" },
          { signal: aborted.signal },
        ),
      ),
    );
    expect(cancelled.every((result) => !result.ok)).toBe(true);

    mode = "success";
    await expect(
      service.inspectWithObjdump({ path, operation: "file_headers" }),
    ).resolves.toMatchObject({ ok: true });
  } finally {
    release();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["stat", "open"] as const)(
  "keeps a call's place while a file %s it gave up on has not returned",
  async (stalls) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-reverse-abandoned-"));
    const paths = Array.from({ length: 8 }, (_, index) =>
      join(directory, `fixture-${String(index)}.bin`),
    );
    await Promise.all(paths.map((path) => writeFile(path, "fixture")));
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    // As an unresponsive mount, the stat or open holds each file until the
    // test answers it.
    const held: Promise<unknown>[] = [];
    const hold = <Value>(work: Promise<Value>): Promise<Value> => {
      held.push(work);
      return work;
    };
    const service = new TestReverseEngineeringService({
      run: async () => ({ stdout: "", stderr: "" }),
      // A budget above the concurrent calls, so the calls' places are the limit.
      fileWork: new FileWork(9),
      stat: (path) =>
        hold(stalls === "stat" ? answered.then(() => stat(path)) : stat(path)),
      digest: (path, bounds) =>
        digestFile(path, {
          ...bounds,
          open: (target) => {
            if (stalls === "stat") return createReadStream(target);
            const stream = new Readable({
              construct(callback) {
                void answered.then(() => callback());
              },
              read() {
                this.push("fixture");
                this.push(null);
              },
            });
            hold(new Promise((resolve) => stream.once("close", resolve)));
            return stream as unknown as ReturnType<typeof createReadStream>;
          },
        }),
    });
    const inspect = (path: string) =>
      service.inspectWithObjdump({
        path,
        operation: "file_headers",
        command_timeout_ms: 50,
      });
    try {
      // A retry waits for the first call's file work instead of starting
      // more, so it leaves nothing behind and gives its place back.
      for (const path of [paths[0]!, ...paths])
        await expect(inspect(path)).resolves.toMatchObject({
          ok: false,
          error: { _tag: "AnalysisTimeoutError" },
        });
      // Each of the eight files still holds the call that started its work.
      await expect(inspect(paths[0]!)).resolves.toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisResourceConstraintError",
          reportedLimits: {
            max_concurrent_operations: 8,
            active_operations: 8,
            operations_awaiting_file_work: 8,
          },
        },
      });
      answer();
      await Promise.allSettled(held);
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        service.inspectWithObjdump({
          path: paths[0]!,
          operation: "file_headers",
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      answer();
      await Promise.allSettled(held);
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("refuses new file work while stalled steps hold the budget, then admits it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-budget-"));
  const paths = ["stalled-a", "stalled-b", "healthy"].map((name) =>
    join(directory, name),
  );
  await Promise.all(paths.map((path) => writeFile(path, "fixture")));
  const [first, second, healthy] = paths as [string, string, string];
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const stats: string[] = [];
  const held: Promise<unknown>[] = [];
  const service = new TestReverseEngineeringService({
    run: async () => ({ stdout: "", stderr: "" }),
    fileWork: new FileWork(2),
    stat: (path) => {
      stats.push(path);
      if (path === healthy) return stat(path);
      const check = answered.then(() => stat(path));
      held.push(check);
      return check;
    },
  });
  const inspect = (path: string, command_timeout_ms?: number) =>
    service.inspectWithObjdump({
      path,
      operation: "file_headers",
      ...(command_timeout_ms === undefined ? {} : { command_timeout_ms }),
    });
  try {
    for (const path of [first, second])
      await expect(inspect(path, 50)).resolves.toMatchObject({
        ok: false,
        error: { _tag: "AnalysisTimeoutError" },
      });
    await expect(inspect(healthy)).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "capacity",
        reportedLimits: { file_steps_held: 2, max_held_file_steps: 2 },
        diagnostics: { phase: "target_preflight", artifact_path: healthy },
      },
    });
    // The refused call started no step, so it holds no thread.
    expect(stats).toEqual([first, second]);
    answer();
    await Promise.allSettled(held);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(inspect(healthy)).resolves.toMatchObject({ ok: true });
  } finally {
    answer();
    await Promise.allSettled(held);
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps command Evidence and says why when the budget refuses the post-run digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-after-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  let digests = 0;
  const service = new TestReverseEngineeringService({
    run: async () => ({ stdout: "headers", stderr: "" }),
    digest: async (target) => {
      digests += 1;
      if (digests === 1) return "0".repeat(64);
      throw new FileWorkSaturatedError(target, 2, 2);
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    if (!result.ok) throw result.error;
    expect(result.value.raw_result).toMatchObject({
      stdout: "headers",
      artifact_sha256_after: null,
    });
    expect(result.value.parameters).toMatchObject({
      artifact_digest_after_refused: {
        file_steps_held: 2,
        max_held_file_steps: 2,
      },
    });
    expect(result.value.limitations).not.toContain(
      POST_RUN_ARTIFACT_UNREADABLE,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("starts no more file steps than the budget when calls stall together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-together-"));
  const paths = ["a", "b", "c", "d"].map((name) => join(directory, name));
  await Promise.all(paths.map((path) => writeFile(path, "fixture")));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const started: string[] = [];
  const held: Promise<unknown>[] = [];
  const service = new TestReverseEngineeringService({
    run: async () => ({ stdout: "", stderr: "" }),
    fileWork: new FileWork(2),
    stat: (path) => {
      started.push(path);
      const check = answered.then(() => stat(path));
      held.push(check);
      return check;
    },
  });
  try {
    const results = await Promise.all(
      paths.map((path) =>
        service.inspectWithObjdump({
          path,
          operation: "file_headers",
          command_timeout_ms: 50,
        }),
      ),
    );
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(started).toHaveLength(2);
  } finally {
    answer();
    await Promise.allSettled(held);
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves the exact caller reason when objdump admission is already aborted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-preabort-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  const reason = Object.freeze({ requested: "stop" });
  const controller = new AbortController();
  controller.abort(reason);
  let runs = 0;
  const service = new TestReverseEngineeringService({
    run: async () => {
      runs += 1;
      return { stdout: "", stderr: "" };
    },
  });
  try {
    const result = await service.inspectWithObjdump(
      { path, operation: "symbols" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(runs).toBe(0);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves the caller reason when cancellation arrives after provider output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-postabort-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  const reason = Object.freeze({ requested: "stop-after-output" });
  const controller = new AbortController();
  const service = new TestReverseEngineeringService({
    run: async () => {
      controller.abort(reason);
      return { stdout: "symbols", stderr: "" };
    },
  });
  try {
    const result = await service.inspectWithObjdump(
      { path, operation: "symbols" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toMatchObject({
      raw_result: { stdout: "symbols" },
    });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a physical digest denial primary when the caller aborts during that failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-digest-deny-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  const reason = Object.freeze({ requested: "stop-during-denial" });
  const controller = new AbortController();
  const denied = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  let runs = 0;
  const service = new TestReverseEngineeringService({
    digest: async () => {
      controller.abort(reason);
      throw denied;
    },
    run: async () => {
      runs += 1;
      return { stdout: "", stderr: "" };
    },
  });
  try {
    const result = await service.inspectWithObjdump(
      { path, operation: "symbols" },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisAccessDeniedError" },
    });
    if (result.ok) return;
    expect(result.error.cause).toBe(denied);
    expect(runs).toBe(0);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps an unrelated digest ABORT_ERR as an adapter failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-digest-abort-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  const denied = Object.assign(new Error("digest aborted elsewhere"), {
    code: "ABORT_ERR",
  });
  const service = new TestReverseEngineeringService({
    digest: async () => {
      throw denied;
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "symbols",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "ProviderAdapterError" },
    });
    if (result.ok) return;
    expect(result.error.cause).toBe(denied);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  {
    captured: true,
    code: "EACCES",
    tag: "AnalysisCapabilityUnavailableError",
  },
  {
    captured: true,
    code: "ETIMEDOUT",
    tag: "AnalysisTimeoutError",
  },
  {
    captured: true,
    code: "ABORT_ERR",
    tag: "AnalysisCancelledError",
  },
  {
    captured: false,
    code: "EACCES",
    tag: "AnalysisCapabilityUnavailableError",
  },
  {
    captured: false,
    code: "ETIMEDOUT",
    tag: "AnalysisTimeoutError",
  },
  {
    captured: false,
    code: "ABORT_ERR",
    tag: "AnalysisCancelledError",
  },
] as const)(
  "classifies a $code command failure with captured output $captured while the caller is aborted",
  async ({ captured, code, tag }) => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-reverse-command-abort-"),
    );
    const path = join(directory, "fixture.bin");
    await writeFile(path, "fixture");
    const reason = Object.freeze({ requested: `stop-${code}` });
    const controller = new AbortController();
    const failure = Object.assign(new Error("provider failure"), {
      code,
      ...(captured
        ? { stdout: "partial stdout", stderr: "partial stderr" }
        : {}),
    });
    const service = new TestReverseEngineeringService({
      run: async () => {
        controller.abort(reason);
        throw failure;
      },
    });
    try {
      const result = await service.inspectWithObjdump(
        { path, operation: "symbols" },
        { signal: controller.signal },
      );
      expect(result).toMatchObject({ ok: false, error: { _tag: tag } });
      if (result.ok) return;
      expect(result.error.cause).toBe(code === "ABORT_ERR" ? reason : failure);
      if (code === "EACCES") {
        expect(result.error).toMatchObject({
          providerId: "objdump.command",
          diagnostics: {
            boundary: "provider-launch",
            command: "objdump",
            system_code: code,
          },
        });
      }
      if (captured && code === "ABORT_ERR") {
        expect(result.error.capturedOutput).toMatchObject({
          stdout: "partial stdout",
          stderr: "partial stderr",
        });
        expect(result.error.partialObservation).toMatchObject({
          raw_result: { stdout: "partial stdout" },
        });
      }
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
