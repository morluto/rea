import { describe, expect, it } from "vitest";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  ArtifactOperationError,
  BinaryTargetError,
  HopperProcessError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
  ProviderAdapterError,
  ReplayPlanStaleError,
  UnknownRegistryError,
  projectAnalysisError,
} from "./errors.js";

describe("analysis error projection: provider failures", () => {
  it("reports a timed-out active Hopper request and actionable retry guidance", () => {
    const projected = projectAnalysisError(
      new HopperTimeoutError(30_000, "find_code_for_string", 42, "busy"),
    );

    expect(projected).toMatchObject({
      code: "provider_timeout",
      category: "timeout",
      retryable: true,
      details: {
        stage: "analysis",
        operation: "find_code_for_string",
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
            operation: "find_code_for_string",
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
        operation: "find_code_for_string",
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
      projectAnalysisError(
        new ReplayPlanStaleError("a".repeat(64), "b".repeat(64)),
      ),
    ];

    expect(projected.map(({ code }) => code)).toEqual([
      "invalid_request",
      "capability_unavailable",
      "target_unavailable",
      "plan_stale",
    ]);
    expect(projected[1]).toMatchObject({ category: "unsupported_provider" });
    expect(projected[2]).toMatchObject({
      details: { path: "/local/targets/app" },
    });
    expect(JSON.stringify(projected)).not.toContain("secret-token");
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
