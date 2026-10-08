import { describe, expect, it } from "vitest";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import { ArtifactOperationError } from "./artifactOperationError.js";
import { BinaryTargetError } from "./configurationErrors.js";
import { BrowserObservationError } from "./browserObservationError.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import {
  HopperProcessError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
} from "./hopperErrors.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { UnknownRegistryError } from "./unknownRegistryError.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { ProviderSelectionError } from "./providerSelectionError.js";
import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import { nativeCallPartialObservationSchema } from "./native/nativeCallPartialObservation.js";

const nativeCallPartialObservation = nativeCallPartialObservationSchema.parse({
  kind: "native-call-observation",
  target: {
    path: "/tmp/selected-app",
    sha256: "a".repeat(64),
    architecture: "arm64",
    arguments: [],
    environment: {},
    working_directory: null,
  },
  process: {
    pid: 4242,
    stdout: {
      text: "partial stdout",
      bytes: 13,
      truncated: false,
      complete: false,
    },
    stderr: null,
    other_stops: [],
  },
  debugger: { version: null },
  events: [],
  coverage: { status: "partial", reason: "cancelled" },
  limitations: ["Observation ended before the requested window completed."],
});

const retainedOutput = {
  stdout: "selected output\u0000",
  stderr: "upstream warning",
  truncated: true,
};

it("distinguishes unsupported target formats from unavailable provider capabilities", () => {
  const projected = projectAnalysisError(
    new AnalysisUnsupportedTargetError(
      "inspect_evm_interface",
      "/selected/runtime.hex",
      "EOF-style EF00 container is unsupported.",
      { capturedOutput: retainedOutput },
    ),
  );
  expect(projected).toMatchObject({
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
    details: {
      operation: "inspect_evm_interface",
      path: "/selected/runtime.hex",
      reason: "EOF-style EF00 container is unsupported.",
      captured_output: retainedOutput,
    },
  });
  expect(projected.message).toContain("EF00");
  expect(projected.remediation.action).toContain("target format");
  expect(projected.remediation.action).not.toContain("doctor");
  expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(true);
});

it.each([
  ["memory", null],
  ["memory", { address_space_bytes: 67108864 }],
  ["cpu", null],
  ["cpu", { cpu_seconds: 1 }],
  ["file-size", null],
  ["file-size", { file_size_bytes: 1024 }],
  ["transport", { result_budget_bytes: 10485760 }],
] as const)(
  "projects reported %s constraints with observed or unknown limits: %j",
  (resource, limits) => {
    const projected = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_binary_layout",
        resource,
        resource === "memory"
          ? "Memory allocation failed; exact cause unknown."
          : "Observed SIGXCPU; exact signal cause unknown.",
        limits,
        { capturedOutput: retainedOutput },
      ),
    );
    expect(projected).toMatchObject({
      code: "resource_constraint",
      category: "resource_constraint",
      retryable: false,
      details: {
        resource,
        reported_limits: limits,
        captured_output: retainedOutput,
      },
    });
    expect(projected.remediation.action).toContain(
      resource === "cpu"
        ? "CPU"
        : resource === "transport"
          ? "Evidence reference"
          : resource === "file-size"
            ? "file-size"
            : "memory",
    );
    expect(projected.remediation.action).not.toContain("doctor");
    expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
      true,
    );
  },
);
it.each([
  new AnalysisInputError("inspect", { capturedOutput: retainedOutput }),
  new AnalysisOutputError("inspect", "invalid reply", {
    capturedOutput: retainedOutput,
  }),
  new AnalysisCapabilityUnavailableError(
    "provider",
    "inspect",
    "unsupported profile",
    { capturedOutput: retainedOutput },
  ),
  new AnalysisCancelledError("inspect", { capturedOutput: retainedOutput }),
  new AnalysisTimeoutError("inspect", 30, { capturedOutput: retainedOutput }),
  new ProviderSelectionError({
    operation: "inspect",
    reason: "provider_unavailable",
    requestedProviderId: "provider",
    candidateIds: [],
    capturedOutput: retainedOutput,
  }),
])(
  "retains captured output without changing the typed primary failure: $._tag",
  (failure) => {
    expect(projectAnalysisError(failure).details?.captured_output).toEqual(
      retainedOutput,
    );
  },
);

it.each([
  new AnalysisCancelledError("observe_native_calls", {
    cleanup: {
      reason: "target process termination could not be verified",
      resources: ["native-target:4242"],
    },
  }),
  new AnalysisTimeoutError("observe_native_calls", 65_000, {
    cleanup: {
      reason: "target process identity was unavailable",
      resources: ["native-target:4242"],
    },
  }),
])("retains incomplete cleanup for lifecycle failures: $._tag", (failure) => {
  expect(projectAnalysisError(failure)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      cleanup: "incomplete",
      cleanup_reason: expect.any(String),
      resources: ["native-target:4242"],
    },
  });
});

it("retains the original failure tag and code when cleanup is incomplete", () => {
  const error = new EvidenceIntegrityError(
    "The launched native target did not match its selected digest",
    {
      cleanup: {
        reason: "target survivor identity could not be verified",
        resources: ["native-target:4242"],
      },
    },
  );
  expect(error._tag).toBe("EvidenceIntegrityError");
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    category: "integrity_mismatch",
    details: {
      cleanup: "incomplete",
      cleanup_reason: "target survivor identity could not be verified",
      resources: ["native-target:4242"],
      execution_failure: "evidence_integrity_mismatch",
    },
  });
});

it("projects native partial observations through healthy cancellation failures", () => {
  const projected = projectAnalysisError(
    new AnalysisCancelledError("observe_native_calls", {
      partialObservation: nativeCallPartialObservation,
    }),
  );

  expect(projected).toMatchObject({
    code: "cancelled",
    details: {
      operation: "observe_native_calls",
      cleanup: "complete",
      partial_observation: nativeCallPartialObservation,
    },
  });
  expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(true);
});

it("retains native partial observations and cleanup uncertainty on provider failures", () => {
  const projected = projectAnalysisError(
    new ProviderAdapterError("native-lldb", "observe_native_calls", {
      partialObservation: nativeCallPartialObservation,
      cleanup: {
        reason: "target process termination could not be verified",
        resources: ["native-target:4242"],
      },
    }),
  );

  expect(projected).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      provider_id: "native-lldb",
      operation: "observe_native_calls",
      cleanup: "incomplete",
      cleanup_reason: "target process termination could not be verified",
      resources: ["native-target:4242"],
      execution_failure: "execution_failure",
      partial_observation: nativeCallPartialObservation,
    },
  });
  expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(true);
});

describe("analysis error projection: provider failures", () => {
  it("projects the primary browser failure alongside incomplete cleanup", () => {
    const projected = projectAnalysisError(
      new BrowserObservationError(
        "observe_javascript_runtime",
        "cleanup_failed",
        {
          cause: new AggregateError([
            new BrowserObservationError(
              "observe_javascript_runtime",
              "target_changed",
            ),
            new Error("socket close failed"),
          ]),
        },
      ),
    );

    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        operation: "observe_javascript_runtime",
        reason: "cleanup_failed",
        cleanup: "incomplete",
        resources: ["browser_transport"],
        primary_reason: "target_changed",
      },
    });
  });

  it("reports a timed-out active Hopper request and actionable retry guidance", () => {
    const projected = projectAnalysisError(
      new HopperTimeoutError(30_000, "trace_feature", 42, "busy"),
    );

    expect(projected).toMatchObject({
      code: "provider_timeout",
      category: "timeout",
      retryable: true,
      details: {
        stage: "analysis",
        operation: "trace_feature",
        request_id: 42,
        provider_state: "busy",
        timeout_ms: 30_000,
      },
    });
    expect(projected.message).toContain("binary_session.analysis_activity");
    expect(projected.remediation.action).toContain(
      "wait for the active Hopper request",
    );
  });

  it("identifies the REA session that already owns a Hopper target", () => {
    const error = new HopperStartError({
      ownerRunId: "session-owner",
      userMessage:
        "This Hopper target is already open in REA session session-owner. Use that REA session or close it before opening this target again.",
    });
    expect(projectAnalysisError(error)).toMatchObject({
      category: "unavailable",
      message: expect.stringContaining("session-owner"),
      remediation: {
        action: expect.stringContaining(
          "Use the active REA session session-owner",
        ),
      },
    });
  });

  it("retains the Hopper request and provider diagnostic on a remote failure", () => {
    expect(
      projectAnalysisError(
        new HopperRemoteError(
          7,
          "Hopper analysis failed in the selected document",
          {
            diagnosticType: "bridge_exception",
            operation: "trace_feature",
            requestId: 43,
          },
        ),
      ),
    ).toMatchObject({
      code: "execution_failure",
      details: {
        stage: "analysis",
        provider_code: 7,
        diagnostic_type: "bridge_exception",
        operation: "trace_feature",
        request_id: 43,
      },
      message: expect.stringContaining("Hopper analysis failed"),
    });
  });

  it("preserves detached, actionable provider diagnostics", () => {
    const diagnostics = {
      runtime_root: "/tmp/rea-ghidra-fixture",
      profile_digest: "a".repeat(64),
      exit_code: 1,
    };
    const error = new ProviderAdapterError("ghidra", "health", {
      diagnostics,
    });

    expect(error.diagnostics).not.toBe(diagnostics);
    expect(projectAnalysisError(error)).toMatchObject({
      details: {
        provider_id: "ghidra",
        operation: "health",
        diagnostics,
      },
    });
  });

  it("maps the Linux startup compatibility exit codes without host internals", () => {
    const expected = [
      [70, "private_display_unavailable"],
      [71, "x11_authorization_failed"],
      [72, "unsupported_hopper_build"],
      [73, "invalid_launch_command"],
      [74, "process_ownership_mismatch"],
      [75, "hopper_exited_during_startup"],
      [76, "unsupported_demo_dialog"],
      [77, "unexpected_display_geometry"],
      [78, "x11_input_failed"],
      [79, "runtime_dependency_unavailable"],
      [80, "x11_socket_directory_unusable"],
    ] as const;

    for (const [exitCode, code] of expected) {
      const projected = projectAnalysisError(new HopperProcessError(exitCode));
      expect(projected).toMatchObject({
        code: "provider_unavailable",
        details: { failure_code: code, exit_code: exitCode },
      });
      expect(projected.message).toMatch(/\S/u);
      expect(JSON.stringify(projected)).not.toContain("/proc/");
    }
  });
});

describe("analysis error projection: caller contract", () => {
  it("preserves the reported output constraint without exposing its internal cause", () => {
    const projected = projectAnalysisError(
      new AnalysisOutputError(
        "extract_firmware",
        "Report exceeded the declared byte budget",
        { cause: new Error("private internal cause") },
      ),
    );
    expect(projected).toMatchObject({
      code: "unreadable_output",
      details: {
        operation: "extract_firmware",
        reason: "Report exceeded the declared byte budget",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("private internal cause");
  });
  it("maps representative failures without exposing causes", () => {
    const secretCause = new Error("secret-token");
    const projected = [
      projectAnalysisError(
        new AnalysisInputError("overview", { cause: secretCause }),
      ),
      projectAnalysisError(
        new AnalysisCapabilityUnavailableError("fixture", "overview", "absent"),
      ),
      projectAnalysisError(
        new BinaryTargetError("/local/targets/app", "invalid", {
          cause: secretCause,
        }),
      ),
    ];

    expect(projected.map(({ code }) => code)).toEqual([
      "invalid_request",
      "capability_unavailable",
      "target_unavailable",
    ]);
    expect(projected[1]).toMatchObject({
      category: "unsupported_provider",
      message:
        "This analysis is unavailable for the current target. Choose another analysis or target.",
      details: {
        provider_id: "fixture",
        operation: "overview",
        reason: "absent",
      },
    });
    expect(projected[2]).toMatchObject({
      details: { path: "/local/targets/app" },
    });
    expect(JSON.stringify(projected)).not.toContain("secret-token");
  });

  it("uses explicit capability recovery while retaining the constraint", () => {
    const projected = projectAnalysisError(
      new AnalysisCapabilityUnavailableError(
        "fixture",
        "capture",
        "host constraint",
        {
          userMessage: "Use the supported host workflow.",
          cause: new Error("private internal cause"),
        },
      ),
    );
    expect(projected).toMatchObject({
      code: "capability_unavailable",
      category: "unsupported_provider",
      message: "Use the supported host workflow.",
      details: {
        provider_id: "fixture",
        operation: "capture",
        reason: "host constraint",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("private internal cause");
  });

  it("preserves exact artifact-integrity coordinates", () => {
    expect(
      projectAnalysisError(
        new ArtifactOperationError("inventory_artifact", "integrity", {
          logicalPath: "main.js",
          declaredSha256: "a".repeat(64),
          calculatedSha256: "b".repeat(64),
          unpacked: true,
        }),
      ),
    ).toMatchObject({
      category: "integrity_mismatch",
      details: {
        logical_path: "main.js",
        declared_sha256: "a".repeat(64),
        calculated_sha256: "b".repeat(64),
        unpacked: true,
      },
    });
  });

  it("gives missing residual unknowns lookup-specific remediation", () => {
    expect(
      projectAnalysisError(new UnknownRegistryError("not-found")),
    ).toMatchObject({
      code: "execution_failure",
      message:
        "The requested residual unknown does not exist in this session. Check the unknown_id and try again.",
      remediation: {
        action:
          "Check that the unknown_id belongs to this session, then retry.",
      },
      details: { reason: "not-found" },
    });
  });
});

describe("analysis error projection: operational diagnostics", () => {
  it("distinguishes an observed Hopper exit from an undetermined provider failure", () => {
    const exited = projectAnalysisError(
      new HopperProcessError(7, undefined, "search_strings", 4),
    );
    expect(exited).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      details: {
        stage: "analysis",
        provider_state: "exited",
        retry_action: "restart_provider",
        operation: "search_strings",
        request_id: 4,
        exit_code: 7,
      },
    });
    expect(exited.message).not.toContain("Run `rea doctor`, then try again.");
    expect(exited.remediation.action).toContain("Restart the owned provider");

    const unknown = projectAnalysisError(
      new HopperProcessError(null, undefined, "search_strings", 5),
    );
    expect(unknown.details).toMatchObject({
      stage: "analysis",
      provider_state: "unknown",
      retry_action: "unknown",
      operation: "search_strings",
      request_id: 5,
      exit_code: null,
    });
    expect(unknown.message).toContain("could not determine");
    expect(unknown.message).not.toContain("stopped");
    expect(unknown.remediation.action).toContain("provider_operation_health");
  });
});
