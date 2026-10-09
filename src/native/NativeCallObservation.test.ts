import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";
import type { NativeCallTrace, NativeCallTracer } from "./LldbCallTracer.js";
import { observeNativeCalls } from "./NativeCallObservation.js";
import { nativeMachoTarget } from "../../tests/fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

class NeverStartedTracer implements NativeCallTracer {
  calls = 0;

  trace(): Promise<Result<NativeCallTrace, AnalysisError>> {
    this.calls += 1;
    throw new Error("tracer must not run after hash cancellation");
  }

  close(): Promise<Result<null, AnalysisError>> {
    return Promise.resolve(ok(null));
  }
}

describe("native call target digest cancellation", () => {
  it("returns tagged cancellation when hashing aborts after a chunk", async () => {
    const directory = await createTestTempDirectory("rea-native-digest-");
    const path = join(directory, "fixture");
    const bytes = "selected executable";
    await writeFile(path, bytes);
    const target = {
      ...nativeMachoTarget(path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const signal = new AbortController();
    const tracer = new NeverStartedTracer();

    const observed = await observeNativeCalls(
      target,
      { breakpoints: [{ kind: "function", name: "main" }] } satisfies Record<
        string,
        JsonValue
      >,
      tracer,
      signal.signal,
      async () => {
        signal.abort();
        throw new DOMException("read aborted", "AbortError");
      },
    );

    expect(!observed.ok && observed.error).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(tracer.calls).toBe(0);
  });
});
