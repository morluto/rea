import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { describe, expect, it } from "vitest";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import {
  HOPPER_STARTUP_TIMEOUT_REMEDIATION,
  HopperProcessError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
  HopperCancelledError,
  HopperProtocolError,
  hopperErrorCatalogue,
} from "./HopperErrors.js";
import {
  DEFAULT_HOPPER_DEMO_DIALOG_TIMEOUT_MS,
  HOPPER_DEMO_DIALOG_TIMEOUT_SETTING,
  MINIMUM_HOPPER_DEMO_DIALOG_TIMEOUT_MS,
  type DialogTimeoutRejection,
  type HopperStartupFailureDiagnostic,
} from "./HopperStartupFailure.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  analysisErrorRemediationAction,
  analysisErrorUserMessage,
} from "../domain/analysisErrorPresentation.js";
import { analysisErrorProjectionSchema } from "../domain/analysisErrorProjectionSchema.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

describe("analysis error projection: Hopper provider failures", () => {
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

  it("projects an Apple Events denial as unavailable and not retryable from the same client", () => {
    const projected = projectAnalysisError(
      new HopperStartError({
        launchRejection: {
          boundary: "apple_events_authorization",
          reason: "not_authorized",
        },
        launcherFailure: {
          exit_code: 2,
          signal: null,
          stdout: { text: "", bytes: 0, retained_bytes: 0 },
          stderr: {
            text: "Cannot launch Hopper!\nNot authorized to send Apple events to Hopper Disassembler.\n",
            bytes: 90,
            retained_bytes: 90,
          },
          output_closed: true,
          diagnostic_truncated: false,
        },
      }),
    );
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      category: "unavailable",
      retryable: false,
      details: {
        stage: "launch",
        provider_state: "unknown",
        retry_action: "unknown",
        launch_rejection: {
          boundary: "apple_events_authorization",
          reason: "not_authorized",
        },
        launcher: { exit_code: 2, signal: null },
      },
    });
    expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
  });

  it("keeps an ordinary Hopper start failure retryable", () => {
    const projected = projectAnalysisError(
      new HopperStartError({
        userMessage: "Hopper's launcher helper failed before bridge readiness.",
      }),
    );
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      category: "unavailable",
      retryable: true,
      details: {
        stage: "launch",
        provider_state: "unknown",
        retry_action: "retry",
      },
    });
    expect(projected.details).not.toHaveProperty("launch_rejection");
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
});

describe("analysis error projection: Hopper startup failures", () => {
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
      [81, "demo_dialog_absent"],
      [82, "invalid_dialog_timeout"],
    ] as const;

    for (const [exitCode, code] of expected) {
      const projected = projectAnalysisError(new HopperProcessError(exitCode));
      expect(projected).toMatchObject({
        code: "provider_unavailable",
        details: { failure_code: code, exit_code: exitCode },
      });
      expect(projected.details).not.toHaveProperty("launch_rejection");
      expect(projected.message).toMatch(/\S/u);
      expect(JSON.stringify(projected)).not.toContain("/proc/");
    }
  });

  it("does not attribute an absent post-authentication dialog to publisher verification", () => {
    const projected = projectAnalysisError(new HopperProcessError(81));
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        failure_code: "demo_dialog_absent",
        exit_code: 81,
      },
    });
    expect(projected.details).not.toHaveProperty("launch_rejection");
    expect(projected.message).toContain("REA_HOPPER_DEMO_DIALOG_TIMEOUT_MS");
  });

  it("reports a rejected demo dialog timeout through its setting fields", () => {
    const dialogTimeout = {
      setting: HOPPER_DEMO_DIALOG_TIMEOUT_SETTING,
      value: "-5",
      source: "setting",
      minimum_ms: MINIMUM_HOPPER_DEMO_DIALOG_TIMEOUT_MS,
      maximum_ms: MAX_NODE_TIMER_DELAY_MS,
      default_ms: DEFAULT_HOPPER_DEMO_DIALOG_TIMEOUT_MS,
    } satisfies DialogTimeoutRejection;
    const projected = projectAnalysisError(
      new HopperProcessError(82, {
        diagnostic: {
          component: "hopper_private_display",
          operation: "launch",
          reason: "invalid_dialog_timeout",
          socket_directory: "/tmp/.X11-unix",
          socket_directory_mode: null,
          mount_read_only: null,
          effective_socket_directory_mode: null,
          effective_mount_read_only: null,
          wsl: false,
          strategy: "direct",
          fallback_reason: null,
          xvfb_stderr_bytes: 0,
          status: "error",
          failure_code: "invalid_dialog_timeout",
          dialog_timeout: dialogTimeout,
        } as HopperStartupFailureDiagnostic,
      }),
    );
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        failure_code: "invalid_dialog_timeout",
        exit_code: 82,
        diagnostics: { dialog_timeout: dialogTimeout },
      },
    });
    expect(projected.details).not.toHaveProperty("launch_rejection");
    expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
      true,
    );
  });
});

describe("analysis error projection: retry guidance", () => {
  it.each([
    [
      "unreadable output",
      new AnalysisOutputError("inspect_firmware_regions", "report missing"),
      "unreadable_output",
    ],
    [
      "adapter failure",
      new ProviderAdapterError("firmware", "inspect_firmware_regions"),
      "execution_failure",
    ],
    [
      "Hopper remote failure",
      new HopperRemoteError(7, "Hopper analysis failed", {
        diagnosticType: "bridge_exception",
        operation: "trace_feature",
      }),
      "execution_failure",
    ],
  ])(
    "does not recommend an unchanged retry for non-retryable %s",
    (_name, error, code) => {
      const projected = projectAnalysisError(error);

      expect(projected).toMatchObject({ code, retryable: false });
      for (const text of [projected.message, projected.remediation.action])
        expect(text).not.toMatch(/\bretry\b/iu);
    },
  );
});

describe("analysis error projection: operational diagnostics", () => {
  it("distinguishes an observed Hopper exit from an undetermined provider failure", () => {
    const exitedError = new HopperProcessError(7, {
      operation: "search_strings",
      requestId: 4,
    });
    const exited = projectAnalysisError(exitedError);
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
    expect(exited.message).toBe(analysisErrorUserMessage(exitedError));
    expect(exited.remediation.action).toBe(
      analysisErrorRemediationAction(exitedError),
    );
    expect(exited.message).toMatch(
      /Hopper exited.*search_strings.*exit code 7/iu,
    );
    expect(exited.remediation.action).toMatch(/close_binary.*open.*retry/iu);

    const unknownError = new HopperProcessError(null, {
      operation: "search_strings",
      requestId: 5,
    });
    const unknown = projectAnalysisError(unknownError);
    expect(unknown.details).toMatchObject({
      stage: "analysis",
      provider_state: "unknown",
      retry_action: "unknown",
      operation: "search_strings",
      request_id: 5,
      exit_code: null,
    });
    expect(unknown.message).toBe(analysisErrorUserMessage(unknownError));
    expect(unknown.remediation.action).toBe(
      analysisErrorRemediationAction(unknownError),
    );
    expect(unknown.message).toMatch(
      /could not determine.*busy, exited, or unreachable/iu,
    );
    expect(unknown.remediation.action).toMatch(
      /provider_operation_health.*before retrying or restarting/iu,
    );

    const unreachableError = new HopperProcessError(null, {
      operation: "search_strings",
      providerState: "unreachable",
    });
    const unreachable = projectAnalysisError(unreachableError);
    expect(unreachable).toMatchObject({
      code: "provider_unavailable",
      details: {
        provider_state: "unreachable",
        retry_action: "restart_provider",
        operation: "search_strings",
        exit_code: null,
      },
      message: analysisErrorUserMessage(unreachableError),
      remediation: { action: analysisErrorRemediationAction(unreachableError) },
    });
    expect(unreachable.message).toMatch(
      /unreachable.*process exit was not observed/iu,
    );
    expect(unreachable.remediation.action).toMatch(
      /close_binary.*Evidence and Unknown history.*export_evidence_bundle/iu,
    );
  });
});

it("retains Hopper startup diagnostics beside generic and secondary context", () => {
  const diagnostic = {
    component: "hopper_private_display",
    operation: "launch",
    reason: "fixture_denial",
    socket_directory: "/tmp/.X11-unix",
    socket_directory_mode: null,
    mount_read_only: null,
    effective_socket_directory_mode: null,
    effective_mount_read_only: null,
    wsl: false,
    strategy: "unavailable",
    fallback_reason: null,
    xvfb_stderr_bytes: 0,
    status: "error",
    failure_code: "private_display_unavailable",
  } as const;
  expect(
    projectAnalysisError(new HopperProcessError(null, { diagnostic })).details
      ?.diagnostics,
  ).toEqual(diagnostic);
  const generic = { caller_context: "retained" };
  expect(
    projectAnalysisError(
      new HopperProcessError(null, { diagnostic, diagnostics: generic }),
    ),
  ).toMatchObject({
    code: "provider_unavailable",
    details: { diagnostics: generic, provider_diagnostics: diagnostic },
  });
  const secondary = new HopperProcessError(null, {
    diagnostic,
  }).retainSecondaryFailure(new HopperProcessError(null), {
    retirement_error: "retained",
  });
  expect(projectAnalysisError(secondary).details).toMatchObject({
    provider_diagnostics: diagnostic,
    diagnostics: { retirement_error: "retained" },
  });
});

describe("analysis error projection: caller lifetime", () => {
  it("delivers each lifetime's Hopper startup recovery", () => {
    const error = new HopperTimeoutError(
      30_000,
      undefined,
      undefined,
      "not_started",
      "launch",
      undefined,
      {
        limit: analysisSettingLimit(
          "hopper.startup_timeout_ms",
          30_000,
          undefined,
        ),
      },
    );
    expect(projectAnalysisError(error).remediation.action).toMatch(
      /update_analysis_settings.*hopper\.startup_timeout_ms.*without restarting REA/u,
    );
    const invocation = projectAnalysisError(error, "invocation");
    expect(invocation.remediation.action).toBe(
      HOPPER_STARTUP_TIMEOUT_REMEDIATION,
    );
    expect(invocation.details?.limit).toMatchObject({
      setting: "hopper.startup_timeout_ms",
      effective_value: 30_000,
      scope: "rea-invocation",
      applies_at: "next_invocation",
      environment: "REA_HOPPER_STARTUP_TIMEOUT_MS",
    });
  });
});

describe("analysis error projection: Hopper caller lifetime", () => {
  it.each([
    [
      new HopperProcessError(7, { operation: "search_strings", requestId: 4 }),
      "close_binary",
      "exit code 7",
    ],
    [
      new HopperProcessError(null, {
        operation: "search_strings",
        providerState: "unreachable",
      }),
      "export_evidence_bundle",
      "process exit was not observed",
    ],
    [
      new HopperProcessError(null, { operation: "search_strings" }),
      "binary_session.provider_operation_health",
      "could not determine",
    ],
    [
      new HopperTimeoutError(30_000, "search_strings", 42, "busy"),
      "binary_session.analysis_activity",
      "remained busy",
    ],
    [
      new HopperTimeoutError(30_000, "search_strings", 42, "not_started"),
      "binary_session",
      "before it started",
    ],
  ] as const)(
    "keeps Hopper outcome facts and scopes request recovery to the caller",
    (error, continuingTool, outcome) => {
      const continuing = projectAnalysisError(error);
      const invocation = projectAnalysisError(error, "invocation");
      expect(continuing.message).toContain(continuingTool);
      expect(continuing.remediation.action).toContain(continuingTool);
      expect(invocation.message).toContain(outcome);
      expect(invocation.message).not.toContain(continuingTool);
      expect(invocation.remediation.action).toContain("rerunning the command");
      expect(invocation.remediation.action).not.toContain(continuingTool);
      expect(invocation.details).toEqual(continuing.details);
      expect(invocation.code).toBe(continuing.code);
      expect(invocation.category).toBe(continuing.category);
      expect(invocation.retryable).toBe(continuing.retryable);
      expect(analysisErrorProjectionSchema.parse(invocation)).toEqual(
        invocation,
      );
    },
  );

  it("keeps Hopper recovery scoped through composed cleanup and its history", () => {
    const primary = new HopperProcessError(null, {
      operation: "search_strings",
      providerState: "unreachable",
    });
    const cleanup = new ProviderCleanupError("hopper", ["hopper-bridge"], {});
    const composed = analysisErrorWithCleanupFailure(
      primary,
      cleanup,
    ).bindCleanupDependencies([cleanup]);
    const invocationPrimary = projectAnalysisError(primary, "invocation");
    const continuingPrimary = projectAnalysisError(primary);
    const invocation = projectAnalysisError(composed, "invocation");
    const continuing = projectAnalysisError(composed);
    expect(invocation.message).toBe(invocationPrimary.message);
    expect(continuing.message).toBe(continuingPrimary.message);
    expect(invocation.details).toMatchObject({
      resources: ["hopper-bridge"],
      diagnostics: { primary_error: invocationPrimary },
    });
    expect(continuing.details).toMatchObject({
      diagnostics: { primary_error: continuingPrimary },
    });

    releaseOwnedCleanup(cleanup);
    expect(
      projectAnalysisError(composed, "invocation").details?.cleanup_history,
    ).toMatchObject({ primary_error: invocationPrimary });
    expect(
      projectAnalysisError(composed).details?.cleanup_history,
    ).toMatchObject({ primary_error: continuingPrimary });
  });
});

describe("Hopper error catalogue", () => {
  it.each([
    ["", new HopperTimeoutError(30_000, "search_strings", 1, "busy")],
    ["", new HopperCancelledError()],
    ["", new HopperProtocolError("bad reply")],
    ...(
      [
        "remote",
        "authorization",
        "invalid_request",
        "capability_unavailable",
        "bridge_exception",
      ] as const
    ).map(
      (diagnosticType) =>
        [
          `diagnostic_type=${diagnosticType}`,
          new HopperRemoteError(7, "failed", { diagnosticType }),
        ] as const,
    ),
    ["", new HopperProcessError(7, { operation: "search_strings" })],
    ["", new HopperStartError()],
    [
      "Apple Events authorization denied",
      new HopperStartError({
        launchRejection: {
          boundary: "apple_events_authorization",
          reason: "not_authorized",
        },
      }),
    ],
  ] as const)(
    "lists the projected code, category and retryability (%s)",
    (discriminant, error) => {
      const projected = projectAnalysisError(error);
      expect(
        hopperErrorCatalogue().find(
          (row) => row.tag === error._tag && row.discriminant === discriminant,
        ),
      ).toEqual({
        tag: error._tag,
        discriminant,
        code: projected.code,
        category: projected.category,
        retryableByDefault: projected.retryable,
      });
    },
  );
});
