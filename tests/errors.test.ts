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
  UnknownRegistryError,
  projectAnalysisError,
  type AnalysisError,
  type AnalysisErrorTag,
} from "../src/domain/errors.js";
import { ProcessCaptureError } from "../src/application/ProcessHarness.js";

describe("analysis error projection", () => {
  it("uses the correct provider-neutral protocol tag", () => {
    expect(new AnalysisProtocolError("invalid")._tag).toBe(
      "AnalysisProtocolError",
    );
  });

  it("projects every typed failure without internal details", () => {
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
    } satisfies Readonly<Record<AnalysisErrorTag, AnalysisError>>;
    const errors = Object.values(byTag);
    const projected = errors.map(projectAnalysisError);
    expect(projected).toHaveLength(24);
    const serialized = JSON.stringify(projected);
    for (const hidden of [
      "secret-token",
      "/secret/local/path",
      "fixture",
      "overview",
      "AnalysisCapabilityUnavailableError",
      "main.js",
      "declaredSha256",
    ])
      expect(serialized).not.toContain(hidden);
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
    });
    expect(projected.every(({ message }) => message.length > 0)).toBe(true);
    expect(
      projected.every(({ message }) =>
        /try again|run `rea doctor`|current target|when ready|smaller request|smaller artifact|fresh copy|re-import|reduce|inline evidence|configured evidence directory|evidence file|allow overwrite|refresh the current state|reported setting|call open_binary|supported file|review capture policy/u.test(
          message,
        ),
      ),
    ).toBe(true);
  });
});
