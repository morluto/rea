import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisTimeoutError,
  ArtifactOperationError,
  BinaryTargetError,
  BrowserObservationError,
  ConfigurationError,
  EvidenceFileError,
  EvidenceIntegrityError,
  EvidenceLimitError,
  HopperCancelledError,
  HopperProcessError,
  HopperProtocolError,
  HopperRemoteError,
  HopperStartError,
  HopperTimeoutError,
  InvestigationWorkspaceError,
  NoBinaryOpenError,
  ProviderAdapterError,
  ProviderSelectionError,
  PermissionRequiredError,
  UnknownRegistryError,
  projectAnalysisError,
  type AnalysisError,
  type AnalysisErrorTag,
} from "../src/domain/errors.js";
import { ProcessCaptureError } from "../src/application/ProcessHarness.js";
import {
  analysisErrorJsonSchema,
  analysisErrorProjectionSchema,
} from "../src/contracts/errorSchemas.js";

describe("analysis error projection", () => {
  it("uses the correct provider-neutral protocol tag", () => {
    expect(new AnalysisProtocolError("invalid")._tag).toBe(
      "AnalysisProtocolError",
    );
  });

  it("projects bounded provider diagnostics without dropping local coordinates", () => {
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

  it("projects stable, safe Linux startup failure codes", () => {
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

  it("projects every typed failure without secrets", () => {
    const secretCause = new Error("secret-token");
    const byTag = {
      AnalysisProtocolError: new AnalysisProtocolError("protocol failed"),
      AnalysisInputError: new AnalysisInputError("overview", {
        cause: secretCause,
      }),
      AnalysisOutputError: new AnalysisOutputError(
        "overview",
        "invalid shape",
        {
          cause: secretCause,
        },
      ),
      AnalysisCapabilityUnavailableError:
        new AnalysisCapabilityUnavailableError("fixture", "overview", "absent"),
      AnalysisCancelledError: new AnalysisCancelledError("overview"),
      AnalysisTimeoutError: new AnalysisTimeoutError("overview", 50),
      ProviderSelectionError: new ProviderSelectionError("overview"),
      ProviderAdapterError: new ProviderAdapterError("fixture", "overview", {
        cause: secretCause,
      }),
      BrowserObservationError: new BrowserObservationError(
        "inspect_web_page",
        "endpoint_unreachable",
        { cause: secretCause },
      ),
      ArtifactOperationError: new ArtifactOperationError(
        "inventory_artifact",
        "integrity",
      ),
      ProcessCaptureError: new ProcessCaptureError("capture failed", {
        cause: secretCause,
      }),
      EvidenceIntegrityError: new EvidenceIntegrityError("integrity failed", {
        cause: secretCause,
      }),
      EvidenceLimitError: new EvidenceLimitError("records", 10),
      EvidenceFileError: new EvidenceFileError("read", "outside-root", {
        cause: secretCause,
      }),
      InvestigationWorkspaceError: new InvestigationWorkspaceError(
        "update",
        "revision-conflict",
        { cause: secretCause },
      ),
      UnknownRegistryError: new UnknownRegistryError("revision-conflict", {
        cause: secretCause,
      }),
      HopperTimeoutError: new HopperTimeoutError(100),
      HopperCancelledError: new HopperCancelledError(),
      HopperProtocolError: new HopperProtocolError("wire failed", {
        cause: secretCause,
      }),
      HopperRemoteError: new HopperRemoteError(7, "safe"),
      HopperProcessError: new HopperProcessError(1),
      HopperStartError: new HopperStartError({ cause: secretCause }),
      ConfigurationError: new ConfigurationError("configuration failed", {
        cause: secretCause,
      }),
      NoBinaryOpenError: new NoBinaryOpenError(),
      BinaryTargetError: new BinaryTargetError(
        "/secret/local/path",
        "invalid",
        {
          cause: secretCause,
        },
      ),
      PermissionRequiredError: new PermissionRequiredError(
        {
          capability: "evidence_read",
          roots: ["/workspace/evidence.json"],
          executables: [],
          environment_names: ["TOKEN_NAME"],
          network: "none",
          mount: false,
          operation_identity: "read:evidence",
        },
        { environment_names: ["TOKEN_NAME"] },
        null,
        false,
        true,
      ),
    } satisfies Readonly<Record<AnalysisErrorTag, AnalysisError>>;
    const errors = Object.values(byTag);
    const projected = errors.map(projectAnalysisError);
    expect(projected).toHaveLength(26);
    const serialized = JSON.stringify(projected);
    for (const hidden of [
      "secret-token",
      "AnalysisCapabilityUnavailableError",
      "declaredSha256",
    ])
      expect(serialized).not.toContain(hidden);
    expect(serialized).toContain("/secret/local/path");
    expect(serialized).toContain('"environment_names":["TOKEN_NAME"]');
    expect(
      projectAnalysisError(byTag.AnalysisCapabilityUnavailableError),
    ).toMatchObject({
      category: "unsupported_provider",
    });
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
    expect(projected.every(({ message }) => message.length > 0)).toBe(true);
    expect(
      projected.every(
        (value) => analysisErrorProjectionSchema.safeParse(value).success,
      ),
    ).toBe(true);
    expect(analysisErrorJsonSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(
      projectAnalysisError(
        new ProcessCaptureError("terminal cleanup failed", {
          reason: "cleanup_incomplete",
          cleanupResources: ["process_group"],
        }),
      ),
    ).toMatchObject({
      code: "cleanup_incomplete",
      details: { cleanup: "incomplete", resources: ["process_group"] },
    });
    expect(
      projected
        .map(({ message }) => message)
        .filter(
          (message) =>
            !/try again|run `rea doctor`|current target|when ready|smaller request|smaller artifact|fresh copy|re-import|reduce|inline evidence|configured evidence directory|evidence file|allow overwrite|refresh the current state|reported setting|call open_binary|supported file|review capture policy|review the requested scope/iu.test(
              message,
            ),
        ),
    ).toEqual([]);
  });

  it("validates every closed error-reason variant against the generated contract", () => {
    const variants: AnalysisError[] = [
      ...(
        [
          "cancelled",
          "format",
          "integrity",
          "limit",
          "path",
          "unavailable",
          "io",
        ] as const
      ).map(
        (reason) => new ArtifactOperationError("inventory_artifact", reason),
      ),
      ...(
        [
          "disabled",
          "outside-root",
          "not-file",
          "too-large",
          "exists",
          "invalid-json",
          "io",
        ] as const
      ).map((reason) => new EvidenceFileError("read", reason)),
      ...(
        [
          "disabled",
          "outside-root",
          "not-file",
          "too-large",
          "invalid-json",
          "integrity",
          "locked",
          "revision-conflict",
          "name-conflict",
          "io",
        ] as const
      ).map((reason) => new InvestigationWorkspaceError("update", reason)),
      ...(
        [
          "not-found",
          "already-exists",
          "revision-conflict",
          "invalid-transition",
          "integrity",
          "limit",
        ] as const
      ).map((reason) => new UnknownRegistryError(reason)),
      ...(
        [
          "capture_failed",
          "cleanup_incomplete",
          "permission_required",
          "cancelled",
        ] as const
      ).map(
        (reason) =>
          new ProcessCaptureError("SECRET capture diagnostic", { reason }),
      ),
      ...(
        [
          "remote",
          "authorization",
          "invalid_request",
          "bridge_exception",
        ] as const
      ).map((diagnostic) => new HopperRemoteError(9, "safe", diagnostic)),
    ];

    expect(variants).toHaveLength(38);
    for (const variant of variants) {
      const projected = projectAnalysisError(variant);
      const parsed = analysisErrorProjectionSchema.safeParse(projected);
      expect(parsed, JSON.stringify({ variant, projected })).toMatchObject({
        success: true,
      });
      expect(projected.code).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(JSON.stringify(projected)).not.toContain("SECRET");
    }
  });
});
