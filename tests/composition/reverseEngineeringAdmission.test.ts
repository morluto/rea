import { spawnFailure } from "../support/process/spawnFailure.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";
import {
  ownedFailure,
  ownedOutput,
} from "../support/reverseEngineeringCompositionFixtures.js";

it.each([
  { budget: undefined, capacity: 8 },
  { budget: 40 * 1024 * 1024, capacity: 3 },
])(
  "bounds provider concurrency and aggregate capture admission at budget $budget",
  async ({ budget, capacity }) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-reverse-capacity-"));
    const path = join(directory, "fixture.bin");
    await writeFile(path, "fixture");
    const input = {
      path,
      operation: "file_headers" as const,
      ...(budget === undefined ? {} : { max_output_bytes: budget }),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let mode: "success" | "failure" | "timeout" = "success";
    const service = new TestReverseEngineeringService({
      runOwned: async (spawn) => {
        calls += 1;
        if (mode === "failure") throw spawnFailure("ENOENT", spawn.command);
        if (mode === "timeout") throw ownedFailure("timeout", null);
        await gate;
        return ownedOutput();
      },
    });

    try {
      const active = Array.from({ length: capacity }, () =>
        service.inspectWithObjdump(input),
      );
      const preAborted = new AbortController();
      preAborted.abort();
      await expect(
        service.inspectWithObjdump(input, { signal: preAborted.signal }),
      ).resolves.toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError" },
      });
      await expect(service.inspectWithObjdump(input)).resolves.toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisResourceConstraintError",
          resource: "transport",
          reportedLimits: {
            max_concurrent_operations: 8,
            active_operations: capacity,
            max_active_capture_bytes: 134217728,
          },
        },
      });
      release();
      const results = await Promise.all(active);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(calls).toBe(capacity);

      mode = "failure";
      const failed = await Promise.all(
        Array.from({ length: capacity }, () =>
          service.inspectWithObjdump(input),
        ),
      );
      expect(failed.every((result) => !result.ok)).toBe(true);

      mode = "timeout";
      const timedOut = await Promise.all(
        Array.from({ length: capacity }, () =>
          service.inspectWithObjdump(input),
        ),
      );
      expect(timedOut.every((result) => !result.ok)).toBe(true);

      const aborted = new AbortController();
      aborted.abort();
      const cancelled = await Promise.all(
        Array.from({ length: capacity }, () =>
          service.inspectWithObjdump(input, { signal: aborted.signal }),
        ),
      );
      expect(cancelled.every((result) => !result.ok)).toBe(true);

      mode = "success";
      await expect(service.inspectWithObjdump(input)).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      release();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves the exact caller reason when objdump admission is already aborted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-preabort-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  const reason = Object.freeze({ requested: "stop" });
  const controller = new AbortController();
  controller.abort(reason);
  let runs = 0;
  const service = new TestReverseEngineeringService({
    runOwned: async () => {
      runs += 1;
      return ownedOutput();
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
    runOwned: async () => {
      controller.abort(reason);
      return ownedOutput("symbols");
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
    runOwned: async () => {
      runs += 1;
      return ownedOutput();
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

it("does not report a command ABORT_ERR without the caller's abort as cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-command-abort-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  const failure = Object.assign(new Error("aborted by another signal"), {
    code: "ABORT_ERR",
  });
  const service = new TestReverseEngineeringService({
    runOwned: async () => {
      throw failure;
    },
  });
  try {
    const result = await service.inspectWithObjdump(
      { path, operation: "symbols" },
      { signal: new AbortController().signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).not.toBe("AnalysisCancelledError");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  {
    captured: false,
    code: "EACCES",
    tag: "AnalysisCapabilityUnavailableError",
  },
  {
    captured: true,
    code: "timeout",
    tag: "AnalysisTimeoutError",
  },
  {
    captured: true,
    code: "cancelled",
    tag: "AnalysisCancelledError",
  },
  {
    captured: false,
    code: "timeout",
    tag: "AnalysisTimeoutError",
  },
  {
    captured: false,
    code: "cancelled",
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
    const failure =
      code === "EACCES"
        ? spawnFailure(code, "objdump")
        : ownedFailure(
            code,
            captured
              ? ownedOutput("partial stdout", "partial stderr", {
                  exitCode: null,
                })
              : null,
            code === "cancelled" ? { cancellation: { reason } } : undefined,
          );
    const service = new TestReverseEngineeringService({
      runOwned: async () => {
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
      if (code === "cancelled") expect(result.error.cause).toBe(reason);
      else if (code === "EACCES") expect(result.error.cause).toBe(failure);
      else expect(result.error.cause).toMatchObject({ cause: failure });
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
      if (captured && code === "cancelled") {
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
