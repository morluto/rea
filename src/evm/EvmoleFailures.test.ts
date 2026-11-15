import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { expect, it } from "vitest";
import { evmFailureDialect, evmReplyBudgetFailure } from "./EvmoleFailures.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";

import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_EVM_TIMEOUT_MS,
  selectedEvmProducerLimits,
} from "../domain/evm/evmInterface.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

/** Classify a raw failure the way the provider does, through EVMole's dialect. */
const evmInterfaceFailure = (
  cause: unknown,
  context: Parameters<typeof evmFailureDialect>[0],
) => classifyProviderFailure(cause, evmFailureDialect(context));

const snapshot: ProviderProcessSnapshot = {
  stdout: { text: "selected output", bytes: 15, observedBytes: 15 },
  stderr: { text: "warning", bytes: 7, observedBytes: 7 },
  exitCode: 0,
  signal: null,
};

it("projects a complete EVM reply allowance refusal as a deterministic resource constraint", () => {
  const capturedOutput = {
    stdout: "kept",
    stderr: "warning",
    truncated: false,
  };
  const projected = projectAnalysisError(
    evmReplyBudgetFailure(
      "Complete interface evidence exceeds the 16 MiB reply budget.",
      { capturedOutput },
    ),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      reported_limits: { maximum_reply_bytes: 16777216 },
      captured_output: capturedOutput,
    },
    remediation: {
      action: expect.stringContaining("producer_limits.output_bytes"),
    },
  });
  expect(projected.remediation.action).not.toContain("doctor");
});

it.each([
  undefined,
  null,
  "caller stopped",
  { requested: "stop" },
  new AnalysisCancelledError("foreign", {
    cleanup: { reason: "foreign owner", resources: ["foreign-resource"] },
  }),
])(
  "retains the exact command cancellation reason as opaque data: %j",
  (reason) => {
    const source = new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      snapshot,
      null,
      {
        cancellation: { reason },
      },
    );
    const result = evmInterfaceFailure(source, {
      phase: "worker",
      path: "/selected.hex",
    });
    expect(result).toBeInstanceOf(AnalysisCancelledError);
    expect(result.cause).toBe(reason);
    expect(result.capturedOutput).toEqual({
      stdout: "selected output",
      stderr: "warning",
      stdout_bytes: 15,
      stderr_bytes: 7,
      exit_code: 0,
      signal: null,
      truncated: false,
    });
    expect(result.cleanupIncomplete).toBe(false);
  },
);

it("names timeout_ms, the omitted default, and the caps it does not raise", () => {
  const source = new OwnedCommandFailure(
    "timeout",
    "Command deadline elapsed.",
    snapshot,
    null,
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(source, {
      phase: "worker",
      path: "/selected.hex",
      timeoutMs: 45_000,
    }),
  );
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 45_000 },
  });
  expect(projected.message).toContain("timeout_ms");
  expect(projected.message).toContain(String(DEFAULT_EVM_TIMEOUT_MS));
  expect(projected.remediation.action).toContain("--timeout-ms");
  expect(projected.remediation.action).toContain(
    String(MAX_NODE_TIMER_DELAY_MS),
  );
  expect(projected.remediation.action).toContain("does not raise");
  expect(projected.remediation.action).toContain("no server restart");
});

it("names the selected CPU budget separately from tighter inherited limits", () => {
  const source = new OwnedCommandFailure(
    "process",
    "signaled",
    {
      ...snapshot,
      exitCode: null,
      signal: "SIGXCPU",
    },
    null,
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(source, {
      phase: "worker",
      path: "/selected.hex",
      workerLimits: {
        addressSpaceBytes: 1024,
        cpuSeconds: 30,
        fileSizeBytes: 1024,
      },
    }),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: { resource: "cpu" },
  });
  expect(projected.remediation.action).toContain("producer_limits.cpu_seconds");
  expect(projected.remediation.action).toContain("inherited");
});

it("reports the selected carrier input allowance as a resource constraint", () => {
  const source = new ArtifactReaderFailure(
    "limit",
    "Selected artifact exceeds 4194304 bytes: /selected.bin",
    { boundary: "file-size" },
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(source, {
      phase: "artifact-read",
      path: "/selected.bin",
    }),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    category: "resource_constraint",
    retryable: false,
    details: {
      operation: "inspect_evm_interface",
      resource: "file-size",
      reported_limits: { maximum_input_bytes: 4194304 },
    },
  });
  expect(projected.remediation.action).toContain("producer_limits.input_bytes");
  expect(projected.remediation.action).toContain("4194304");
  expect(projected.recovery).toBeUndefined();
});

it("names a selected carrier that is a directory as invalid input", () => {
  const source = Object.assign(new Error("EISDIR: illegal operation"), {
    code: "EISDIR",
  });
  const projected = projectAnalysisError(
    evmInterfaceFailure(source, {
      phase: "artifact-read",
      path: "/selected",
    }),
  );
  expect(projected).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["path"],
          reason: "invalid_value",
          message:
            "Selected bytecode carrier could not be read (EISDIR): /selected.",
        },
      ],
    },
  });
});

it.each([
  {
    reason: "path" as const,
    message: "Expected a regular file without a symlink: /selected.bin",
  },
  { reason: "format" as const, message: "Unsupported carrier format." },
])("keeps reader $reason refusals as invalid input", ({ reason, message }) => {
  const projected = projectAnalysisError(
    evmInterfaceFailure(new ArtifactReaderFailure(reason, message), {
      phase: "artifact-read",
      path: "/selected.bin",
    }),
  );
  expect(projected).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [{ path: ["path"], reason: "invalid_format", message }],
    },
  });
});

it.each([
  { failure: "process" as const, cleanup: null, tag: "ProviderAdapterError" },
  { failure: "timeout" as const, cleanup: null, tag: "AnalysisTimeoutError" },
  {
    failure: "cancelled" as const,
    cleanup: "close refused",
    tag: "ProviderAdapterError",
  },
])("keeps $tag ahead of recorded cancellation", ({ failure, cleanup, tag }) => {
  const source = new OwnedCommandFailure(
    failure,
    "physical outcome",
    snapshot,
    cleanup,
    {
      cancellation: { reason: "later interruption" },
    },
    ["exact-owner"],
  );
  const result = evmInterfaceFailure(source, {
    phase: "worker",
    path: "/selected.hex",
  });
  expect(result._tag).toBe(tag);
  if (cleanup !== null) {
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.cleanupResources).toEqual(["exact-owner"]);
  }
});

it.skipIf(process.platform === "win32")(
  "maps real selected-path failures before the EVM worker starts",
  async () => {
    const root = await createTestTempDirectory("rea-evm-path-mapping-");
    await symlink("loop", join(root, "loop"));
    for (const [code, path] of [
      ["ELOOP", join(root, "loop", "carrier.bin")],
      ["ENAMETOOLONG", join(root, "x".repeat(256))],
    ] as const) {
      let source: unknown;
      try {
        await readFile(path);
        throw new Error("Expected selected-path read failure");
      } catch (cause) {
        source = cause;
      }
      const failure = evmInterfaceFailure(source, {
        phase: "artifact-read",
        path: path,
      });
      expect(failure.cause).toBe(source);
      expect(projectAnalysisError(failure)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(code),
            },
          ],
        },
      });
      expect(
        evmInterfaceFailure(source, { phase: "worker", path: path })._tag,
      ).toBe("ProviderAdapterError");
    }
  },
);

it("names producer_limits.diagnostic_bytes when worker diagnostics exceed it", () => {
  const projected = projectAnalysisError(
    evmInterfaceFailure(
      new OwnedCommandFailure("output-limit", "Output exceeded.", snapshot),
      {
        phase: "worker",
        path: "/selected.hex",
        producerLimits: {
          ...selectedEvmProducerLimits(undefined),
          diagnostic_bytes: 4096,
        },
      },
    ),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      reported_limits: {
        maximum_diagnostic_bytes: 4096,
        parameter: "producer_limits.diagnostic_bytes",
      },
    },
  });
  expect(projected.remediation.action).toContain(
    "producer_limits.diagnostic_bytes",
  );
});

it("reports the worker's V8 heap exhaustion against its fixed heap", () => {
  const projected = projectAnalysisError(
    evmInterfaceFailure(
      new OwnedCommandFailure("process", "exited", {
        ...snapshot,
        exitCode: 134,
        runtimeExhaustion: {
          runtime: "v8",
          area: "heap",
          stream: "stderr",
          line: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
          lineComplete: true,
          truncated: false,
          invalidUtf8: false,
        },
      }),
      { phase: "worker", path: "/selected.hex" },
    ),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      resource: "memory",
      reported_limits: { worker_heap_mib: 256 },
    },
  });
});

it("does not report a private storage errno as a limiter launch refusal", async () => {
  const denied = await readFile("/nonexistent-evm-root/request.json").then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(
    evmInterfaceFailure(denied, { phase: "worker", path: "/selected.hex" }),
  ).toMatchObject({
    _tag: "ProviderAdapterError",
    diagnostics: { phase: "worker" },
  });
});

it("keeps the recorded exit status when collecting worker output failed", () => {
  const failure = evmInterfaceFailure(
    new OwnedCommandFailure(
      "process",
      "stdout stream failed",
      { ...snapshot, exitCode: 3 },
      null,
      { collectionFailure: true },
    ),
    { phase: "worker", path: "/selected.hex" },
  );
  expect(failure).toMatchObject({
    _tag: "ProviderAdapterError",
    diagnostics: { failure_kind: "protocol", exit_code: 3, signal: null },
  });
});
