import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { pwntoolsHostSupported } from "./PwntoolsDecoder.js";
import { pwntoolsFailureDialect } from "./PwntoolsFailures.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import {
  PWNTOOLS_LIMITS,
  resolvePwntoolsLimits,
} from "../../domain/native/pwntoolsResourceLimits.js";
import { DEFAULT_PWNTOOLS_TIMEOUT_MS } from "../../domain/native/nativeDeadlines.js";

// The bridge's omitted file-size cap follows its omitted output allowance.
const DEFAULT_FILE_BYTES = PWNTOOLS_LIMITS.output_bytes;

const pwntoolsDecoderFailure = (
  cause: unknown,
  ...phase: Parameters<typeof pwntoolsFailureDialect>
) => classifyProviderFailure(cause, pwntoolsFailureDialect(...phase));

it.each([undefined, null, false, 0, "stop", { stop: true }, new Error("stop")])(
  "preserves opaque cancellation from command and artifact owners: %s",
  (reason) => {
    for (const failure of [
      new OwnedCommandFailure("cancelled", "cancelled", null, null, {
        cause: new Error("transport wrapper"),
        cancellation: { reason },
      }),
      new ArtifactReaderFailure("cancelled", "cancelled", {
        cause: new Error("file wrapper"),
        cancellation: { reason },
      }),
    ]) {
      const result = pwntoolsDecoderFailure(failure, "decoder", "/selected");
      expect(result._tag).toBe("AnalysisCancelledError");
      expect(result.cause).toBe(reason);
      expect(Object.hasOwn(result, "cause")).toBe(true);
    }
  },
);

it("keeps the caller-selected pwntools input-limit source", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new ArtifactReaderFailure(
        "limit",
        "artifact exceeds the input allowance",
        { boundary: "file-size" },
      ),
      "artifact-read",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        producerLimits: resolvePwntoolsLimits(undefined, 4096),
        inputBytesSource: "request",
        omittedInputBytes: 67_108_864,
      },
    ),
  );
  // The per-call parameter stopped the read, so the limit names it and the
  // ceiling that applies when it is omitted, not the registered setting.
  expect(projected.details?.limit).toStrictEqual({
    control_kind: "parameter",
    parameter: "producer_limits.input_bytes",
    effective_value: 4096,
    unit: "bytes",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default_value: 67_108_864,
    applies_at: "next_call",
  });
  expect(projected.recovery).toStrictEqual({
    kind: "inspect_input_contract",
    operation: "inspect_binary_layout",
  });
});

it("keeps the setting limit when omitting the per-call ceiling would fail configuration", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new ArtifactReaderFailure(
        "limit",
        "artifact exceeds the input allowance",
        { boundary: "file-size" },
      ),
      "artifact-read",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        producerLimits: resolvePwntoolsLimits(undefined, 4096),
        inputBytesSource: "request",
        omittedInputBytes: undefined,
      },
    ),
  );
  // No usable default exists, so no parameter limit with an invented
  // default_value is reported.
  expect(projected.details?.limit).not.toHaveProperty("control_kind");
  expect(projected.details?.limit).toMatchObject({
    setting: "pwntools.max_input_bytes",
    effective_value: 4096,
    source: "request",
  });
});

it("names a runtime pwntools ceiling instead of the built-in default", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new ArtifactReaderFailure(
        "limit",
        "artifact exceeds the input allowance",
        { boundary: "file-size" },
      ),
      "artifact-read",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        producerLimits: resolvePwntoolsLimits(undefined, 67_108_864),
        inputBytesSource: "runtime",
      },
    ),
  );
  expect(projected.details?.limit).toMatchObject({
    setting: "pwntools.max_input_bytes",
    effective_value: 67_108_864,
    source: "runtime",
    unit: "bytes",
    update_mode: "runtime",
    parameter: "producer_limits.input_bytes",
  });
  // The operation that changes a runtime setting is part of the recovery.
  expect(projected.remediation.action).toContain("update_analysis_settings");
});

it("distinguishes the wall deadline from caller-selected producer resource budgets", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure("timeout", "deadline expired"),
      "decoder",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        timeoutMs: 4_500,
      },
    ),
  );
  expect(projected).toMatchObject({
    code: "provider_timeout",
    recovery: { kind: "inspect_timeout_state", timeout_ms: 4_500 },
    details: {
      timeout_ms: 4_500,
      limit: {
        control_kind: "parameter",
        parameter: "pwntools_timeout_ms",
        effective_value: 4_500,
        default_value: DEFAULT_PWNTOOLS_TIMEOUT_MS,
        applies_at: "next_call",
      },
    },
  });
  // The independent producer budgets have no structured field on a deadline
  // failure, so the recovery states their selected values.
  expect(projected.remediation.action).toContain(
    `cpu_seconds=${String(PWNTOOLS_LIMITS.cpu_seconds)}`,
  );
  expect(projected.remediation.action).toContain(
    `output_bytes=${String(PWNTOOLS_LIMITS.output_bytes)}`,
  );
});

it("names the reported file-size allowance instead of address space", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure("process", "sigxfsz", {
        stdout: { text: "", bytes: 0, observedBytes: 0 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
        exitCode: null,
        signal: "SIGXFSZ",
      }),
      "decoder",
      "/selected",
      "/python",
      {
        limits: {
          limits: {
            address_space_bytes: 1_111,
            cpu_seconds: 2,
            file_size_bytes: 4_096,
          },
          failure: null,
        },
      },
    ),
  );
  // The file-size resource and its cap identify the exhausted allowance; the
  // reported address-space value stays a reported fact, not the control.
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "file-size",
      reported_limits: {
        address_space_bytes: 1_111,
        cpu_seconds: 2,
        file_size_bytes: 4_096,
      },
      limit: {
        control_kind: "parameter",
        parameter: "producer_limits.file_bytes",
        effective_value: DEFAULT_FILE_BYTES,
        default_value: DEFAULT_FILE_BYTES,
      },
    },
  });
});

it("reports the selected output allowance as the omitted file-size default", () => {
  const outputBytes = 128 * 1024 * 1024;
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure("process", "sigxfsz", {
        stdout: { text: "", bytes: 0, observedBytes: 0 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
        exitCode: null,
        signal: "SIGXFSZ",
      }),
      "decoder",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        producerLimits: resolvePwntoolsLimits({ output_bytes: outputBytes }),
      },
    ),
  );
  expect(projected.details?.limit).toMatchObject({
    parameter: "producer_limits.file_bytes",
    effective_value: outputBytes,
    default_value: outputBytes,
  });
});

it("binds diagnostic_bytes as the only control of the command output budget", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure(
        "output-limit",
        "Command diagnostic output exceeded its complete-output budget.",
        {
          stdout: { text: "x".repeat(64), bytes: 64, observedBytes: 65 },
          stderr: { text: "", bytes: 0, observedBytes: 0 },
          exitCode: 0,
          signal: null,
          outputIncomplete: true,
        },
      ),
      "decoder",
      "/selected",
      "/python",
      {},
      {
        operation: "inspect_binary_layout",
        providerId: "pwntools",
        producerLimits: resolvePwntoolsLimits({ diagnostic_bytes: 64 }),
      },
    ),
  );
  // output_bytes bounds the reply file, not this budget.
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      reported_limits: { diagnostic_bytes: 64 },
      limit: {
        control_kind: "parameter",
        parameter: "producer_limits.diagnostic_bytes",
        effective_value: 64,
        default_value: PWNTOOLS_LIMITS.diagnostic_bytes,
        applies_at: "next_call",
      },
    },
  });
});

it("names the file-size cap when SIGXFSZ has no reported limit", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure("process", "efbig", {
        stdout: { text: "", bytes: 0, observedBytes: 0 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
        exitCode: 76,
        signal: null,
      }),
      "decoder",
      "/selected",
      "/python",
      { marker: { resource: "file-size", failure: null } },
    ),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "file-size",
      reported_limits: null,
      limit: {
        parameter: "producer_limits.file_bytes",
        effective_value: DEFAULT_FILE_BYTES,
      },
    },
  });
});

it("names memory in the marker recovery for an allocation failure", () => {
  const projected = projectAnalysisError(
    pwntoolsDecoderFailure(
      new OwnedCommandFailure("process", "allocation", {
        stdout: { text: "", bytes: 0, observedBytes: 0 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
        exitCode: 75,
        signal: null,
      }),
      "decoder",
      "/selected",
      "/python",
      { marker: { resource: "memory", failure: null } },
    ),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: { resource: "memory", reported_limits: null },
  });
  // No structured limit names the memory budget, so the recovery states it.
  expect(projected.remediation.action).toContain(
    `address_space_bytes=${String(PWNTOOLS_LIMITS.address_space_bytes)}`,
  );
});

it("retains legacy owner causes without guessing cancellation from error text", () => {
  const reason = { stop: "legacy" };
  const result = pwntoolsDecoderFailure(
    new OwnedCommandFailure("cancelled", "cancelled", null, null, {
      cause: reason,
    }),
    "decoder",
    "/selected",
  );
  // The shared outcome owner keeps the unannotated failure itself as the
  // reason, so the owner's cause stays one step down.
  expect(result.cause).toBeInstanceOf(OwnedCommandFailure);
  expect((result.cause as OwnedCommandFailure).cause).toBe(reason);
  const physical = Object.assign(new Error("physical failure"), {
    name: "AbortError",
  });
  expect(pwntoolsDecoderFailure(physical, "decoder", "/selected")._tag).toBe(
    "ProviderAdapterError",
  );
});

it.each(["ENOEXEC", "EACCES"])(
  "reports a launcher's %s refusal as the selected Python being unavailable",
  (code) => {
    // Node throws ENOEXEC with a bare `spawn` syscall; the launcher names it.
    const refusal = Object.assign(new Error(`spawn ${code}`), {
      code,
      syscall: "spawn /python",
      path: "/python",
    });
    const projected = projectAnalysisError(
      pwntoolsDecoderFailure(refusal, "decoder", "/selected", "/python"),
    );
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      details: {
        rejections: [
          {
            diagnostics: { executable_path: "/python", system_code: code },
          },
        ],
      },
    });
  },
);

it("keeps the launch owner's cause and facts on an unavailable selected Python", () => {
  const launch = Object.assign(new Error("spawn /python EIO"), {
    code: "EIO",
    syscall: "spawn /python",
    path: "/python",
  });
  const failure = pwntoolsDecoderFailure(
    launch,
    "decoder",
    "/selected",
    "/python",
  );
  expect(failure.cause).toBe(launch);
  expect(failure.diagnostics).toMatchObject({
    boundary: "provider-launch",
    system_code: "EIO",
    syscall: "spawn /python",
    command: "/python",
  });
  expect(projectAnalysisError(failure)).toMatchObject({
    code: "provider_unavailable",
    details: {
      diagnostics: { system_code: "EIO", syscall: "spawn /python" },
      rejections: [{ diagnostics: { system_code: "EIO" } }],
    },
  });
});

it("does not read an errno from another syscall as a launch refusal", () => {
  const unrelated = Object.assign(new Error("open EACCES"), {
    code: "EACCES",
    syscall: "open",
  });
  expect(
    pwntoolsDecoderFailure(unrelated, "decoder", "/selected", "/python")._tag,
  ).toBe("ProviderAdapterError");
});

it("keeps the reader's partial observation on a cancelled selected-object read", () => {
  const reason = { stop: "caller" };
  const observation = {
    kind: "retained-evidence",
    evidence_id: "evidence-1",
  } as const;
  const failure = pwntoolsDecoderFailure(
    new ArtifactReaderFailure("cancelled", "cancelled", {
      cancellation: { reason },
      partialObservation: observation,
    }),
    "artifact-read",
    "/selected",
  );
  expect(failure._tag).toBe("AnalysisCancelledError");
  expect(failure.cause).toBe(reason);
  expect(failure.partialObservation).toEqual(observation);
});

it("restricts the verified host profile to Linux x64", () => {
  expect(pwntoolsHostSupported("linux", "x64")).toBe(true);
  expect(pwntoolsHostSupported("linux", "arm64")).toBe(false);
  expect(pwntoolsHostSupported("darwin", "x64")).toBe(false);
});
