import { describe, expect, it } from "vitest";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
  AnalysisArtifactChangedError,
} from "./analysisErrorCore.js";
import { ArtifactOperationError } from "./artifactOperationError.js";
import {
  BinaryTargetError,
  ConfigurationError,
} from "./configurationErrors.js";
import { BrowserObservationError } from "./browserObservationError.js";
import { EvidenceFileError, EvidenceIntegrityError } from "./evidenceErrors.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { UnknownRegistryError } from "./unknownRegistryError.js";
import {
  childFailureDiagnostics,
  projectAnalysisError,
  projectAnalysisErrorWithoutPartialObservation,
} from "./analysisErrorProjection.js";
import {
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
} from "./analysisErrorPresentation.js";
import { ProviderSelectionError } from "./providerSelectionError.js";
import { analysisErrorProjectionSchema } from "./analysisErrorProjectionSchema.js";
import { nativeCallPartialObservationSchema } from "./native/nativeCallPartialObservation.js";
import { analysisSettingLimit } from "./analysisSettingDefinitions.js";
import { redactExplicitFailure } from "./explicitSensitiveFailure.js";
import { redactExplicitText } from "./explicitSensitiveValues.js";
import { analysisErrorWithCleanupFailure } from "./analysisErrorCleanup.js";
import {
  AnalysisError,
  ProviderOwnedAnalysisError,
  providerErrorTag,
  type AnalysisCallerLifetime,
  type AnalysisErrorOwnPresentation,
} from "./analysisErrorBase.js";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";

it("projects nested workflow-publication recovery for the actual caller lifetime", () => {
  const child = new UnknownRegistryError(
    "limit",
  ).retainWorkflowUnknownPublication({
    evidence_id: `ev_${"a".repeat(64)}`,
    evidence_retention: "retained",
    total_questions: 3,
    created_questions: 1,
    existing_questions: 0,
    next_question_index: 1,
  });
  const error = new AnalysisCancelledError(
    "trace_feature",
    childFailureDiagnostics({ child: { error: child } }),
  );
  const continuing = projectAnalysisError(error);
  const invocation = projectAnalysisError(error, "invocation");
  const childOf = (value: typeof continuing) => {
    const diagnostics = value.details?.diagnostics;
    if (
      typeof diagnostics !== "object" ||
      diagnostics === null ||
      Array.isArray(diagnostics)
    )
      throw new Error("Expected child diagnostics");
    return analysisErrorProjectionSchema.parse(diagnostics.child);
  };
  expect(
    childOf(continuing).details?.workflow_unknown_publication,
  ).toMatchObject({
    evidence_retention: "retained",
    created_questions: 1,
    next_question_index: 1,
  });
  expect(childOf(continuing).remediation.action).toContain(
    "get_evidence_bundle",
  );
  expect(
    childOf(invocation).details?.workflow_unknown_publication,
  ).toMatchObject({
    evidence_retention: "invocation-only",
    created_questions: 1,
    next_question_index: 1,
  });
  expect(childOf(invocation).remediation.action).not.toContain(
    "get_evidence_bundle",
  );
});

describe("agent recovery metadata", () => {
  it("does not mark deterministic input validation as retryable", () => {
    const projected = projectAnalysisError(
      new AnalysisInputError("extract_firmware", undefined, [
        { path: ["range", "length"], reason: "missing_argument" },
      ]),
    );

    expect(projected).toMatchObject({
      code: "invalid_request",
      retryable: false,
      recovery: {
        kind: "inspect_input_contract",
        operation: "extract_firmware",
      },
    });
    expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
  });

  it("distinguishes deterministic duplicate identities from stale update revisions", () => {
    const duplicate = projectAnalysisError(
      new UnknownRegistryError("already-exists"),
    );
    expect(duplicate).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      details: { reason: "already-exists" },
    });
    expect(analysisErrorProjectionSchema.parse(duplicate)).toEqual(duplicate);
    expect(
      projectAnalysisError(new UnknownRegistryError("revision-conflict")),
    ).toMatchObject({ code: "revision_conflict", retryable: true });
  });

  it.each(["history_gap", "revision_chain"] as const)(
    "preserves %s as an integrity failure with producer facts",
    (kind) => {
      const constraint = { kind, unknown_id: `unk_${"0".repeat(64)}` };
      const projected = projectAnalysisError(
        new UnknownRegistryError(constraint, {
          cause: new Error("Unrelated private diagnostic"),
        }),
      );
      expect(projected).toMatchObject({
        code: "evidence_integrity_mismatch",
        retryable: false,
        details: { reason: "integrity", constraint },
      });
      expect(projected.message).toContain(constraint.unknown_id);
      expect(JSON.stringify(projected)).not.toContain(
        "Unrelated private diagnostic",
      );
      expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
    },
  );

  it("keeps retryability for provider timeouts", () => {
    expect(
      projectAnalysisError(
        new AnalysisTimeoutError("inspect_binary_layout", 2500),
      ),
    ).toMatchObject({ code: "provider_timeout", retryable: true });
  });

  it("names the input contract for malformed analysis arguments", () => {
    const projected = projectAnalysisError(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["view", "kind"],
          reason: "invalid_value",
          expected: ["summary", "module"],
        },
      ]),
    );

    expect(projected).toMatchObject({
      recovery: {
        kind: "inspect_input_contract",
        operation: "inspect_analysis_view",
      },
      remediation: {
        action: expect.stringContaining("inspect_analysis_view"),
      },
    });
    expect(projected.remediation.action).toContain("tools/list");
    expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
  });

  it("omits schema recovery when a conforming request lacks a target fact", () => {
    const issue = {
      path: ["address"],
      reason: "invalid_value",
      message: "Address 0x2000 is in uninitialized memory block .bss",
      observed: { address: "0x2000", file_mapping: "uninitialized" },
    } as const;
    const projected = projectAnalysisError(
      new AnalysisInputError(
        "address_to_file_offset",
        {
          userMessage: "No exact original-file offset exists.",
          remediationAction: "Select an address inside a file-backed mapping.",
          conformsToInputContract: true,
        },
        [issue],
      ),
    );

    expect(projected).toEqual({
      code: "invalid_request",
      category: "invalid_input",
      message: "No exact original-file offset exists.",
      retryable: false,
      remediation: {
        action: "Select an address inside a file-backed mapping.",
      },
      details: { operation: "address_to_file_offset", issues: [issue] },
    });
    expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
  });

  it("separates timeout-state inspection from client deadline recovery", () => {
    const projected = projectAnalysisError(
      new AnalysisTimeoutError("inspect_binary_layout", 2_500),
    );

    expect(projected).toMatchObject({
      code: "provider_timeout",
      recovery: {
        kind: "inspect_timeout_state",
        operation: "inspect_binary_layout",
        timeout_ms: 2_500,
      },
    });
    expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
  });
});

describe("capability failure retry disposition", () => {
  it.each([
    { options: {}, retryable: false, category: "unsupported_provider" },
    {
      options: { retryable: false },
      retryable: false,
      category: "unsupported_provider",
    },
    { options: { retryable: true }, retryable: true, category: "unavailable" },
  ] as const)(
    "preserves the producer's $retryable disposition",
    ({ options, retryable, category }) => {
      const reason = "Native self-test failed with a sharing violation";
      const error = new AnalysisCapabilityUnavailableError(
        "fixture-provider",
        "inspect",
        reason,
        options,
      );
      const projected = projectAnalysisError(error);
      expect(projected).toMatchObject({
        code: "capability_unavailable",
        category,
        retryable,
        details: { reason },
      });
      if (retryable) {
        expect(projected.message).toBe(
          "Required runtime controls are unavailable for this attempt.",
        );
        expect(projected.remediation.action).toBe(
          analysisErrorRemediationAction(error),
        );
      }
      expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
        true,
      );
    },
  );

  it("preserves a caller-selected message for a retryable failure", () => {
    expect(
      projectAnalysisError(
        new AnalysisCapabilityUnavailableError(
          "fixture-provider",
          "inspect",
          "temporary failure",
          {
            retryable: true,
            userMessage: "Selected runtime diagnostic",
          },
        ),
      ).message,
    ).toBe("Selected runtime diagnostic");
  });

  it("uses generic recovery only when no more specific recovery exists", () => {
    const project = (options: {
      fallbackRemediationAction?: string;
      remediationAction?: string;
      retryable?: boolean;
    }) =>
      projectAnalysisError(
        new AnalysisCapabilityUnavailableError(
          "fixture",
          "inspect",
          "unavailable",
          options,
        ),
      );
    expect(
      project({ fallbackRemediationAction: "Generic" }).remediation.action,
    ).toBe("Generic");
    expect(
      project({
        fallbackRemediationAction: "Generic",
        remediationAction: "Specific",
      }).remediation.action,
    ).toBe("Specific");
    const retry = project({ retryable: true });
    const retryWithFallback = project({
      fallbackRemediationAction: "Generic",
      retryable: true,
    });
    expect(retryWithFallback.retryable).toBe(true);
    expect(retryWithFallback.remediation.action).toBe(retry.remediation.action);
  });

  it("retains cleanup ownership before allowing a transient operation to retry", () => {
    expect(
      projectAnalysisError(
        new AnalysisCapabilityUnavailableError(
          "fixture-provider",
          "inspect",
          "temporary failure",
          {
            retryable: true,
            cleanup: {
              reason: "owned handle is still live",
              resources: ["native-owner"],
            },
          },
        ),
      ),
    ).toMatchObject({
      code: "cleanup_incomplete",
      retryable: false,
      details: {
        cleanup: "incomplete",
        resources: ["native-owner"],
        execution_failure: "capability_unavailable",
      },
    });
  });
});

it("projects a published file receipt alongside retained cleanup failure", () => {
  const projected = projectAnalysisError(
    new EvidenceFileError("write", "io", {
      path: "/tmp/evidence.json",
      published: { path: "/tmp/evidence.json", bytes: 42 },
      cleanup: {
        reason: "staging directory is still owned",
        resources: ["/tmp/.rea-write-abc"],
      },
      cause: new Error("cleanup incomplete"),
    }),
  );
  expect(projected).toMatchObject({
    code: "cleanup_incomplete",
    message: expect.stringMatching(/published.*staging cleanup.*incomplete/iu),
    remediation: {
      action: expect.stringContaining("details.published_path"),
    },
    details: {
      operation: "write",
      path: "/tmp/evidence.json",
      published: true,
      published_path: "/tmp/evidence.json",
      bytes: 42,
      resources: ["/tmp/.rea-write-abc"],
    },
  });
  expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(true);
});

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

it("keeps a refusing provider's recovery on a target selection failure", () => {
  const selection = {
    reason: "target_unsupported" as const,
    requestedProviderId: "ghidra",
    candidateIds: ["ghidra"],
    userMessage: "Unsupported target: the configured extension is x86-64 only.",
  };
  expect(
    projectAnalysisError(
      new ProviderSelectionError({
        ...selection,
        remediationAction: "Omit the extension setting for this target.",
      }),
    ),
  ).toMatchObject({
    code: "capability_unavailable",
    message: selection.userMessage,
    remediation: { action: "Omit the extension setting for this target." },
    details: { selection_reason: "target_unsupported" },
  });
  expect(
    projectAnalysisError(new ProviderSelectionError(selection)).remediation
      .action,
  ).toBe(selection.userMessage);
});

it.each([false, true])(
  "marks occupied capacity retryable only while cleanup is confirmed: %s",
  (cleanupIncomplete) => {
    const projected = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_sqlite_database",
        "capacity",
        "Inspection slots are occupied",
        { max_concurrent_inspections: 2 },
        cleanupIncomplete
          ? {
              cleanup: {
                reason: "Snapshot removal denied",
                resources: ["/private/snapshot"],
              },
            }
          : undefined,
      ),
    );
    expect(projected.retryable).toBe(!cleanupIncomplete);
    expect(projected.code).toBe(
      cleanupIncomplete ? "cleanup_incomplete" : "resource_constraint",
    );
    expect(projected.details).toMatchObject({
      resource: "capacity",
      reported_limits: { max_concurrent_inspections: 2 },
    });
    expect(projected.remediation.action).toContain("Wait");
    expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
      true,
    );
  },
);

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

describe("analysis error projection: browser provider failures", () => {
  it("explains the service-worker policy refusal and names its recovery", () => {
    const projected = projectAnalysisError(
      new BrowserObservationError(
        "capture_browser_scenario",
        "service_worker_blocked",
      ),
    );

    expect(projected).toMatchObject({
      code: "target_unavailable",
      category: "unavailable",
      retryable: false,
      message: expect.stringContaining("service-worker policy is block"),
      remediation: {
        action: expect.stringContaining("environment.service_workers to allow"),
      },
      details: {
        operation: "capture_browser_scenario",
        reason: "service_worker_blocked",
      },
    });
  });

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

  it("keeps producer facts when a browser failure is attributed to another operation", () => {
    const partial = { kind: "browser-test-partial" } as never;
    const original = new BrowserObservationError(
      "inspect_web_page",
      "cleanup_failed",
      {
        detail: "Target page-1 closed while REA released its session.",
        remediationAction: "Release session page-1, then retry.",
        cleanup: { reason: "socket close failed", resources: ["page-1"] },
        diagnostics: { endpoint: "loopback" },
        partialObservation: partial,
        cause: new AggregateError([
          new BrowserObservationError("inspect_web_page", "target_changed"),
          new Error("socket close failed"),
        ]),
      },
    );
    const relabelled = original.forOperation("capture_web_screenshot");

    expect(relabelled).toMatchObject({
      operation: "capture_web_screenshot",
      reason: "cleanup_failed",
      cause: original.cause,
      diagnostics: { endpoint: "loopback" },
      partialObservation: partial,
    });
    const { details, ...projected } = projectAnalysisError(relabelled);
    const { details: originalDetails, ...originalProjected } =
      projectAnalysisError(original);
    expect(projected).toEqual(originalProjected);
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      message: "Target page-1 closed while REA released its session.",
      remediation: { action: "Release session page-1, then retry." },
    });
    expect(details).toEqual({
      ...originalDetails,
      operation: "capture_web_screenshot",
    });
    expect(details).toMatchObject({
      resources: ["page-1"],
      primary_reason: "target_changed",
    });
  });

  it("derives default browser guidance for the attributed operation", () => {
    const original = new BrowserObservationError(
      "inspect_web_page",
      "target_not_found",
    );
    expect(original.forOperation("inspect_web_page")).toBe(original);

    const relabelled = original.forOperation("discover_webmcp_tools");
    const projected = projectAnalysisError(relabelled);
    expect(projected).toMatchObject({
      code: "target_unavailable",
      message: expect.stringMatching(/^discover_webmcp_tools could not find/),
      details: {
        operation: "discover_webmcp_tools",
        reason: "target_not_found",
      },
    });
    expect(projected.message).not.toContain("inspect_web_page");
    expect(
      projectAnalysisError(
        new BrowserObservationError("inspect_web_page", "timeout").forOperation(
          "observe_web_session",
        ),
      ),
    ).toMatchObject({
      code: projectAnalysisError(
        new BrowserObservationError("observe_web_session", "timeout"),
      ).code,
      details: { operation: "observe_web_session", reason: "timeout" },
    });
  });
});

describe("analysis error projection: detached provider diagnostics", () => {
  it.each(["adapter", "cancelled", "timeout"])(
    "preserves detached, actionable diagnostics for %s errors",
    (kind) => {
      const diagnostics = {
        runtime_root: "/tmp/rea-ghidra-fixture",
        profile_digest: "a".repeat(64),
        exit_code: 1,
      };
      const error =
        kind === "adapter"
          ? new ProviderAdapterError("ghidra", "health", { diagnostics })
          : kind === "cancelled"
            ? new AnalysisCancelledError("health", { diagnostics })
            : new AnalysisTimeoutError("health", 250, { diagnostics });

      expect(error.diagnostics).not.toBe(diagnostics);
      expect(projectAnalysisError(error)).toMatchObject({
        details: {
          ...(kind === "adapter" ? { provider_id: "ghidra" } : {}),
          operation: "health",
          diagnostics,
        },
      });
      diagnostics.exit_code = 2;
      expect(error.diagnostics?.exit_code).toBe(1);
    },
  );
});

describe("analysis error projection: unclassified failures", () => {
  it.each(["hopper", "ghidra", "ida", "jadx", "kuna"])(
    "names doctor only with the provider it can check (%s)",
    (providerId) => {
      const projected = projectAnalysisError(
        new ProviderAdapterError(providerId, "open_binary"),
      );

      expect(projected.code).toBe("execution_failure");
      expect(projected.message).toContain(
        `${providerId} provider could not complete open_binary, and REA did not classify the failure`,
      );
      expect(projected.message).not.toContain("doctor");
      expect(projected.remediation.action).toContain(
        `\`rea doctor --provider ${providerId}\``,
      );
    },
  );

  it.each(["firmware", "native-macos", "rizin", "rea-cdp-browser", "rea"])(
    "does not send %s failures to a doctor that cannot check them",
    (providerId) => {
      const projected = projectAnalysisError(
        new ProviderAdapterError(providerId, "inspect"),
      );

      expect(projected.message).toContain("did not classify the failure");
      for (const text of [projected.message, projected.remediation.action])
        expect(text).not.toContain("doctor");
    },
  );

  it("keeps an authored provider message as the recovery", () => {
    const projected = projectAnalysisError(
      new ProviderAdapterError("firmware", "inspect", {
        userMessage: "Select a smaller firmware image.",
      }),
    );

    expect(projected.remediation.action).toBe(
      "Select a smaller firmware image.",
    );
  });

  it("does not attribute an unreadable result to provider readiness", () => {
    const projected = projectAnalysisError(
      new AnalysisOutputError("decompile", "failed"),
    );

    expect(projected.code).toBe("unreadable_output");
    for (const text of [projected.message, projected.remediation.action])
      expect(text).not.toContain("doctor");
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
      message: expect.stringMatching(/unavailable.*target/iu),
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

  it.each(["EACCES", "EPERM"] as const)(
    "reports a target the host refused to read (%s) as access_denied",
    (systemCode) => {
      const denied = Object.assign(new Error("denied"), { code: systemCode });
      const reason = `permission denied while reading target: ${systemCode}`;
      expect(
        projectAnalysisError(
          new BinaryTargetError("/local/targets/app", reason, {
            cause: denied,
          }),
        ),
      ).toMatchObject({
        code: "access_denied",
        category: "unavailable",
        retryable: false,
        remediation: {
          action: expect.stringMatching(
            /read access.*selected path.*readable local file/iu,
          ),
        },
        details: {
          path: "/local/targets/app",
          reason,
          system_code: systemCode,
          boundary: "filesystem-read",
        },
      });
      expect(
        projectAnalysisError(
          new BinaryTargetError("/local/targets/app", "missing", {
            cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
          }),
        ),
      ).toMatchObject({ code: "target_unavailable" });
    },
  );

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
      message: expect.stringMatching(
        /residual unknown.*does not exist.*unknown_id/iu,
      ),
      remediation: {
        action: expect.stringMatching(/unknown_id.*session.*retry/iu),
      },
      details: { reason: "not-found" },
    });
  });
});

describe("analysis error projection: evidence files", () => {
  it.each([
    ["read", "missing", "invalid_request", "invalid_input"],
    ["read", "not-file", "invalid_request", "invalid_input"],
    ["write", "missing", "invalid_request", "invalid_input"],
    ["write", "exists", "invalid_request", "invalid_input"],
    ["write", "path-limit", "resource_constraint", "resource_constraint"],
    [
      "read",
      "invalid-json",
      "evidence_integrity_mismatch",
      "execution_failure",
    ],
    ["read", "io", "execution_failure", "execution_failure"],
  ] as const)(
    "classifies a %s %s evidence file by who can correct it",
    (operation, reason, code, category) => {
      const projected = projectAnalysisError(
        new EvidenceFileError(operation, reason, { path: "/selected.json" }),
      );
      expect(projected).toMatchObject({
        code,
        category,
        details: { operation, reason, path: "/selected.json" },
      });
      expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
    },
  );
});

it("retains the primary failure and both cleanup reports after a secondary failure", () => {
  const callerReason = { caller: "stop" };
  const primary = new AnalysisCancelledError("execute_rizin_command", {
    cause: callerReason,
    capturedOutput: {
      stdout: "partial",
      stderr: "diagnostic",
      truncated: false,
    },
    cleanup: { reason: "writer remains", resources: ["writer"] },
  });
  const secondary = new AnalysisOutputError("open_binary", "cannot rebind", {
    cleanup: { reason: "provider remains", resources: ["provider", "writer"] },
  });
  const enriched = primary.retainSecondaryFailure(secondary, {
    rebind_error: projectAnalysisError(secondary),
  });
  expect(enriched).toBe(primary);
  expect(enriched._tag).toBe("AnalysisCancelledError");
  expect(enriched.cause).toBe(callerReason);
  expect(enriched.secondaryFailures).toEqual([secondary]);
  expect(projectAnalysisError(enriched)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      execution_failure: "cancelled",
      resources: ["writer"],
      cleanup_reason: "writer remains",
      captured_output: { stdout: "partial", stderr: "diagnostic" },
      diagnostics: { rebind_error: { code: "cleanup_incomplete" } },
    },
  });
});

it("retains secondary failures when the primary error has no cause", () => {
  const primary = new AnalysisCancelledError("execute_rizin_command");
  const secondary = new AnalysisOutputError("open_binary", "cannot rebind");

  primary.retainSecondaryFailure(secondary, {});

  expect(primary.cause).toBeUndefined();
  expect(primary.secondaryFailures).toEqual([secondary]);
});

it.each([false, true])(
  "preserves producer capability recovery with retryable=%s",
  (retryable) => {
    const recovery =
      "Choose an explicit disposition, then retry the same session.";
    const projected = projectAnalysisError(
      new AnalysisCapabilityUnavailableError("fixture", "close", "live state", {
        retryable,
        remediationAction: recovery,
      }),
    );
    expect(projected).toMatchObject({
      code: "capability_unavailable",
      retryable,
      remediation: { action: recovery },
      details: {
        provider_id: "fixture",
        operation: "close",
        reason: "live state",
      },
    });
    expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
      true,
    );
  },
);

it("does not offer entry-policy retries for integrity refusals without a declared-versus-observed entry contradiction", () => {
  const native = projectAnalysisError(
    new ArtifactOperationError(
      "inspect_artifact",
      "integrity",
      undefined,
      "hdiutil verify failed: invalid checksum",
    ),
  );
  expect(native.category).toBe("integrity_mismatch");
  expect(native.details).toMatchObject({
    reason: "integrity",
    detail: "hdiutil verify failed: invalid checksum",
  });
  expect(native.message).not.toContain("record-and-continue");
  expect(native.remediation.action).not.toContain("record-and-continue");
});

it.each([undefined, false, true])(
  "projects whether a refused request was sent (%s) and omits an unknown value",
  (requestSent) => {
    const details = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "cutter_command",
        "transport",
        "Cutter request exceeds its frame limit",
        { max_request_bytes: 8192 },
        requestSent === undefined ? {} : { requestSent },
      ),
    ).details;
    if (requestSent === undefined)
      expect(details).not.toHaveProperty("request_sent");
    else expect(details).toMatchObject({ request_sent: requestSent });
  },
);

it("preserves ordinary configuration recovery and projects a producer-owned session repair", () => {
  const settings = [{ setting: "REA_EXAMPLE", constraint: "must be positive" }];
  const original = projectAnalysisError(
    new ConfigurationError("Invalid setting", { settings }),
  );
  const repairing = projectAnalysisError(
    new ConfigurationError("Invalid setting", {
      settings,
      remediationAction: "Repair the running session, then retry.",
    }),
  );
  expect(original.remediation.action).toMatch(
    /correct.*REA_EXAMPLE.*environment.*shell.*MCP.*registration.*rerun/iu,
  );
  expect(repairing).toEqual({
    ...original,
    remediation: { action: "Repair the running session, then retry." },
  });
  expect(repairing.code).toBe("configuration_invalid");
});

const continuingOnly = {
  userMessage: "The fixture session remains usable.",
  remediationAction: "Update the fixture runtime setting on this session.",
};

describe("analysis error projection: caller lifetime", () => {
  it.each([
    new AnalysisTimeoutError("procedure_pseudo_code", 5000, {
      userMessage: "Only this request stopped.",
      remediationAction: "Rerun with a longer launch deadline.",
      continuingCallerGuidance: continuingOnly,
    }),
    new ProviderAdapterError("fixture", "procedure_pseudo_code", {
      userMessage: "Only this request stopped.",
      remediationAction: "Rerun with a longer launch deadline.",
      continuingCallerGuidance: continuingOnly,
    }),
    new AnalysisResourceConstraintError(
      "search_strings",
      "cpu",
      "Only this request stopped.",
      null,
      {
        remediationAction: "Rerun with a longer launch deadline.",
        continuingCallerGuidance: continuingOnly,
      },
    ),
  ])(
    "states continuing-session guidance only to a continuing caller ($_tag)",
    (error) => {
      expect(projectAnalysisError(error)).toMatchObject({
        message:
          "Only this request stopped. The fixture session remains usable.",
        remediation: {
          action: "Update the fixture runtime setting on this session.",
        },
      });
      const invocation = projectAnalysisError(error, "invocation");
      expect(invocation).toMatchObject({
        code: projectAnalysisError(error).code,
        message: "Only this request stopped.",
        remediation: { action: "Rerun with a longer launch deadline." },
      });
      expect(analysisErrorUserMessage(error, "invocation")).toBe(
        "Only this request stopped.",
      );
      expect(analysisErrorRemediationAction(error, "invocation")).toBe(
        "Rerun with a longer launch deadline.",
      );
    },
  );

  it("re-scopes a limit for a finished invocation and keeps its enforced facts", () => {
    const limit = analysisSettingLimit(
      "regex.matching_deadline_ms",
      250,
      "setting",
    );
    const error = new AnalysisResourceConstraintError(
      "search_strings",
      "cpu",
      "Regex matching exceeded its deadline.",
      null,
      { limit },
    );
    expect(projectAnalysisError(error).details?.limit).toEqual(limit);
    expect(projectAnalysisError(error, "invocation").details?.limit).toEqual({
      setting: "regex.matching_deadline_ms",
      effective_value: 250,
      source: "setting",
      unit: "ms",
      minimum: limit.minimum,
      maximum: limit.maximum,
      agent_editable: true,
      update_mode: "runtime",
      pending_restart: false,
      applies_at: "next_invocation",
      scope: "rea-invocation",
      environment: "REA_REGEX_MATCHING_DEADLINE_MS",
    });
    // The error keeps its runtime facts for other projections.
    expect(error.limit).toEqual(limit);
  });

  it("names a per-call parameter, not an environment, when a setting has no launch seed", () => {
    const error = new AnalysisTimeoutError("inspect_wasm_artifact", 100, {
      limit: analysisSettingLimit("wasm.command_timeout_ms", 100, "request"),
    });
    expect(projectAnalysisError(error, "invocation").details?.limit).toEqual(
      expect.objectContaining({
        setting: "wasm.command_timeout_ms",
        source: "request",
        update_mode: "parameter",
        parameter: "command_timeout_ms",
        applies_at: "next_invocation",
        scope: "rea-invocation",
      }),
    );
    expect(
      analysisSettingLimit("wasm.command_timeout_ms", 100, "runtime"),
    ).toMatchObject({ source: "runtime", update_mode: "runtime" });
    expect(
      analysisSettingLimit("javascript.max_heap_mb", 128, "request"),
    ).toMatchObject({
      source: "request",
      update_mode: "parameter",
      parameter: "max_heap_mb",
    });
    expect(
      analysisSettingLimit("javascript.analysis_timeout_ms", 1, "default"),
    ).toMatchObject({ source: "default", update_mode: "runtime" });
    expect(
      projectAnalysisError(error, "invocation").details?.limit,
    ).not.toHaveProperty("environment");
  });
});

describe("analysis error projection: composed failures for a caller lifetime", () => {
  it("projects a composed cleanup failure's children for the caller and keeps their history", () => {
    const limit = analysisSettingLimit(
      "regex.matching_deadline_ms",
      250,
      "setting",
    );
    const primary = new AnalysisTimeoutError("search_strings", 250, {
      limit,
      userMessage: "Only this request stopped.",
      remediationAction: "Rerun with a longer launch deadline.",
      continuingCallerGuidance: continuingOnly,
    });
    const cleanup = new ProviderCleanupError(
      "fixture",
      ["fixture-process"],
      { reason: "exit unconfirmed" },
      { remediationAction: "Close the retained fixture process." },
    );
    const composed = analysisErrorWithCleanupFailure(
      primary,
      cleanup,
    ).bindCleanupDependencies([primary, cleanup]);
    const child = (lifetime: AnalysisCallerLifetime) =>
      projectAnalysisError(composed, lifetime).details;
    expect(child("invocation")).toMatchObject({
      limit: { scope: "rea-invocation" },
      diagnostics: {
        primary_error: projectAnalysisError(primary, "invocation"),
        cleanup_error: { code: "cleanup_incomplete" },
      },
    });
    expect(child("continuing")).toMatchObject({
      limit: { scope: "rea-runtime" },
      diagnostics: { primary_error: projectAnalysisError(primary) },
    });
    expect(projectAnalysisError(composed, "invocation").message).toBe(
      "Only this request stopped.",
    );
    expect(projectAnalysisError(composed).message).toBe(
      `Only this request stopped. ${continuingOnly.userMessage}`,
    );
    // After cleanup resolves, history keeps the composition-time snapshot.
    releaseOwnedCleanup(cleanup);
    for (const lifetime of ["continuing", "invocation"] as const)
      expect(child(lifetime)?.cleanup_history).toMatchObject({
        primary_error: projectAnalysisError(primary, lifetime),
        cleanup_error: { code: "cleanup_incomplete" },
      });
  });

  it("keeps caller lifetime for a secondary failure embedded in child diagnostics", () => {
    const primary = new AnalysisInputError("read_bytes", undefined, []);
    const secondary = new AnalysisTimeoutError("search_strings", 250, {
      limit: analysisSettingLimit("regex.matching_deadline_ms", 250, "setting"),
      continuingCallerGuidance: continuingOnly,
    });
    primary.retainSecondaryFailure(secondary);
    const history = childFailureDiagnostics({
      primary_error: { error: primary },
    });
    expect(history.diagnostics?.primary_error).toEqual(
      projectAnalysisError(primary, "continuing"),
    );
    expect(history.invocationDiagnostics?.primary_error).toEqual(
      projectAnalysisError(primary, "invocation"),
    );
  });

  it("records one lifetime form when no child depends on the caller", () => {
    const composed = analysisErrorWithCleanupFailure(
      new AnalysisInputError("read_bytes", undefined, [
        { path: ["address"], reason: "invalid_format" },
      ]),
      new ProviderCleanupError("fixture", ["fixture-process"], {}),
    );
    expect(composed.invocationDiagnostics).toBeUndefined();
    expect(projectAnalysisError(composed, "invocation").details).toEqual(
      projectAnalysisError(composed).details,
    );
  });

  it("keeps the named integrity check when redaction rebuilds an artifact change", () => {
    const error = new AnalysisArtifactChangedError(
      "inspect_artifact",
      "/target/secret-token.bin",
      "member changed",
      { integrityCheck: "member-identity" },
    );
    const redacted = redactExplicitFailure(error, ["secret-token"]);
    expect(redacted).not.toBe(error);
    expect(projectAnalysisError(redacted)).toMatchObject({
      code: "artifact_changed",
      details: { integrity_check: "member-identity" },
    });
  });

  it("keeps continuing guidance through redaction and redacts its text", () => {
    const guidance = {
      userMessage: "The session for secret-token remains usable.",
      remediationAction: "Retry secret-token on this session.",
    };
    const error = new AnalysisTimeoutError("procedure_pseudo_code", 5000, {
      userMessage: "Only this request stopped.",
      remediationAction: "Rerun with a longer launch deadline.",
      continuingCallerGuidance: guidance,
    });
    const redact = (text: string) => redactExplicitText(text, ["secret-token"]);
    const redacted = redactExplicitFailure(error, ["secret-token"]);
    expect(projectAnalysisError(redacted)).toMatchObject({
      message: `Only this request stopped. ${redact(guidance.userMessage)}`,
      remediation: { action: redact(guidance.remediationAction) },
    });
    expect(JSON.stringify(projectAnalysisError(redacted))).not.toContain(
      "secret-token",
    );
    expect(projectAnalysisError(redacted, "invocation")).toMatchObject({
      message: "Only this request stopped.",
      remediation: { action: "Rerun with a longer launch deadline." },
    });
  });
});

describe("analysis error projection: provider-owned errors", () => {
  class ExampleProviderError extends ProviderOwnedAnalysisError {
    readonly _tag = providerErrorTag("ExampleProviderError");
    constructor() {
      super("Example provider stopped with internal state");
    }
    override ownPresentation(): AnalysisErrorOwnPresentation {
      return {
        code: "provider_unavailable",
        category: "unavailable",
        message: "The example provider stopped.",
        remediation: "Restart the example provider, then retry.",
        details: { stage: "launch" },
      };
    }
  }

  it("projects a tag outside the domain set through the error's own presentation", () => {
    const projection = projectAnalysisError(new ExampleProviderError());
    expect(projection).toMatchObject({
      code: "provider_unavailable",
      category: "unavailable",
      message: "The example provider stopped.",
      remediation: { action: "Restart the example provider, then retry." },
      details: { stage: "launch" },
    });
    expect(analysisErrorProjectionSchema.parse(projection)).toEqual(projection);
  });

  it("refuses an error whose tag is neither a domain tag nor provider-owned", () => {
    class StrayError extends AnalysisError {
      readonly _tag = "StrayError" as unknown as AnalysisError["_tag"];
    }
    expect(() => projectAnalysisError(new StrayError("stray"))).toThrow(
      "Unknown analysis error tag",
    );
  });
});

describe("analysis error projection: composite argument observations", () => {
  const left = { kind: "retained-evidence", evidence_id: "left" } as const;
  const right = { kind: "retained-evidence", evidence_id: "right" } as const;
  const own = { kind: "retained-evidence", evidence_id: "comparison" } as const;

  it("keeps each argument's observation beside the failure's own partial", () => {
    const failure = new AnalysisCancelledError("compare_managed_members", {
      partialObservation: own,
    })
      .retainArgumentObservation("left", left)
      .retainArgumentObservation("right", right)
      .retainArgumentObservation("left", right);

    expect(projectAnalysisError(failure).details).toMatchObject({
      partial_observation: own,
      argument_observations: [
        { argument: "left", observation: left },
        { argument: "right", observation: right },
      ],
    });
    expect(
      projectAnalysisErrorWithoutPartialObservation(failure).details,
    ).not.toHaveProperty("argument_observations");
    expect(
      projectAnalysisError(
        new AnalysisCancelledError("compare_managed_members"),
      ).details,
    ).not.toHaveProperty("argument_observations");
  });

  it("reads an inner failure's argument observations through cleanup before and after it settles", () => {
    const primary = new AnalysisInputError(
      "compare_managed_members",
    ).retainArgumentObservation("left", left);
    const cleanup = new ProviderCleanupError("fixture", ["fixture-file"], {});
    const composed = analysisErrorWithCleanupFailure(
      primary,
      cleanup,
    ).bindCleanupDependencies([cleanup]);
    const expected = [{ argument: "left", observation: left }];

    expect(projectAnalysisError(composed).details).toMatchObject({
      cleanup: "incomplete",
      argument_observations: expected,
    });
    expect(
      projectAnalysisErrorWithoutPartialObservation(composed).details,
    ).not.toHaveProperty("argument_observations");

    releaseOwnedCleanup(cleanup);
    expect(
      projectAnalysisError(composed).details?.argument_observations,
    ).toEqual(expected);
  });
});
