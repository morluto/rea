import { describe, expect, it } from "vitest";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  ArtifactOperationError,
  BinaryTargetError,
  HopperProcessError,
  PermissionRequiredError,
  ProviderAdapterError,
  ReplayPlanStaleError,
  UnknownRegistryError,
  projectAnalysisError,
} from "./errors.js";

describe("analysis error projection: provider failures", () => {
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
      expect(projected.message.length).toBeGreaterThan(20);
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

  it.each([
    [
      "configure",
      false,
      false,
      "Add the exact missing scope beneath the administrator ceiling, then retry.",
    ],
    [
      "elicit",
      false,
      true,
      "Approve the exact missing scope, then retry the operation.",
    ],
    [
      "restart",
      true,
      false,
      "Add the exact missing scope to the administrator configuration, then restart the registered MCP server or client.",
    ],
  ] as const)(
    "projects %s permission remediation into stable protocol fields",
    (remediation, restartRequired, elicitationSupported, action) => {
      const projected = projectAnalysisError(
        new PermissionRequiredError({
          requested: {
            capability: "evidence_read",
            roots: ["/workspace/evidence.json"],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: "read:evidence",
          },
          missing: { roots: ["/workspace/evidence.json"] },
          ceiling: null,
          remediation,
        }),
      );

      expect(projected.remediation).toEqual({
        action,
        restart_required: restartRequired,
        elicitation_supported: elicitationSupported,
      });
    },
  );

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

  it("retains schema-authored input guidance", () => {
    expect(
      projectAnalysisError(
        new AnalysisInputError("find_changed_behavior", undefined, [
          {
            path: [],
            reason: "invalid_value",
            message:
              "Supply either existing comparisons or one investigation_run",
          },
        ]),
      ),
    ).toMatchObject({
      details: {
        issues: [
          {
            path: [],
            reason: "invalid_value",
            message:
              "Supply either existing comparisons or one investigation_run",
          },
        ],
      },
    });
  });

  it("distinguishes disabled integrity continuation from format support", () => {
    expect(
      projectAnalysisError(
        new ArtifactOperationError("inventory_artifact", "policy"),
      ),
    ).toMatchObject({
      code: "artifact_operation_failed",
      category: "unavailable",
      message: expect.stringContaining(
        "REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED=true",
      ),
    });
  });
});
