import { access, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnalysisCancelledError } from "../../../../src/domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../../../src/domain/evidenceErrors.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { nativeCallObservationInputSchema } from "../../../../src/domain/native/nativeCallObservation.js";
import type { NativeCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { LldbCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { ok } from "../../../../src/domain/result.js";

const EVENT = {
  sequence: 0,
  elapsed_ms: 1,
  thread_id: 2,
  breakpoint_index: 0,
  load_address: "0x1000",
  file_address: "0x1000",
  module: "fixture",
  module_path: "/tmp/fixture",
  symbol: "main",
  receiver_class: null,
  selector: null,
  registers: [],
  backtrace: [],
};

const request: Parameters<NativeCallTracer["trace"]>[0] = {
  executable: "/tmp/fixture",
  architecture: "arm64",
  expectedSha256: "a".repeat(64),
  input: nativeCallObservationInputSchema.parse({
    breakpoints: [{ kind: "function", name: "main" }],
    arguments: ["--fixture"],
    environment: { CASE: "retained" },
  }),
};

const fakeTool = { path: "/usr/bin/lldb", sha256: "b".repeat(64) };
const configSchema = z.object({
  result_path: z.string(),
  observation_path: z.string(),
  stdout_capture_path: z.string(),
});

const configFromArguments = async (arguments_: readonly string[]) => {
  const command = arguments_.at(-1);
  const match =
    command === undefined ? null : /^rea_trace (.+)$/u.exec(command);
  if (match?.[1] === undefined)
    throw new Error("fake LLDB launcher did not receive a tracer config path");
  const raw: unknown = JSON.parse(await readFile(match[1], "utf8"));
  return { config: configSchema.parse(raw), configPath: match[1] };
};

const fixtureTracer = (
  outcome: "cancelled" | "integrity-error-cleanup-failure",
) => {
  let configPath: string | undefined;
  const tracer = new LldbCallTracer(
    async (_executable, arguments_) => {
      const resolved = await configFromArguments(arguments_);
      const { config } = resolved;
      configPath = resolved.configPath;
      await writeFile(
        config.observation_path,
        `${JSON.stringify({ kind: "event", event: EVENT })}\n`,
      );
      await writeFile(config.stdout_capture_path, "captured prefix");
      if (outcome === "integrity-error-cleanup-failure")
        await writeFile(
          config.result_path,
          JSON.stringify({
            status: "target-integrity-error",
            error: "launched target digest changed",
          }),
        );
      return outcome === "cancelled"
        ? {
            kind: "cancelled",
            targetIdentity: undefined,
            cleanupFailure: undefined,
          }
        : {
            kind: "exited",
            exitCode: 1,
            output: "bridge reported target integrity failure",
            targetIdentity: undefined,
            cleanupFailure: "LLDB process-group cleanup could not be verified",
          };
    },
    async () => ok(fakeTool),
  );
  return {
    tracer,
    runtimeRoot: async () => {
      if (configPath === undefined)
        throw new Error("fake LLDB launcher was not called");
      const root = dirname(configPath);
      await expect(access(root)).rejects.toThrow();
    },
  };
};

describe("LLDB failure retention through the production tracer", () => {
  it("preserves cancellation and journal/output evidence after runtime cleanup", async () => {
    const fixture = fixtureTracer("cancelled");
    const result = await fixture.tracer.trace(request);
    await fixture.runtimeRoot();
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.partialObservation).toMatchObject({
      coverage: { status: "partial", reason: "cancelled" },
      events: [EVENT],
      process: { stdout: { text: "captured prefix", complete: false } },
      target: {
        arguments: ["--fixture"],
        environment: { CASE: "retained" },
        working_directory: null,
      },
    });
  });

  it("preserves bridge integrity failure type when process-group cleanup also fails", async () => {
    const fixture = fixtureTracer("integrity-error-cleanup-failure");
    const result = await fixture.tracer.trace(request);
    await fixture.runtimeRoot();
    if (result.ok) throw new Error("expected integrity failure");
    expect(result.error).toBeInstanceOf(EvidenceIntegrityError);
    expect(result.error.partialObservation).toMatchObject({
      coverage: { status: "partial", reason: "cleanup-failure" },
      events: [EVENT],
      process: { stdout: { text: "captured prefix", complete: false } },
    });
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { execution_failure: "evidence_integrity_mismatch" },
    });
  });
});
