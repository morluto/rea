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

  it("exhaustively projects stable tags without causes or local paths", () => {
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
    expect(new Set(projected.map(({ tag }) => tag)).size).toBe(errors.length);
    expect(projected).toHaveLength(24);
    expect(JSON.stringify(projected)).not.toContain("secret-token");
    expect(JSON.stringify(projected)).not.toContain("/secret/local/path");
    expect(
      projected.find(({ tag }) => tag === "HopperTimeoutError"),
    ).toMatchObject({ details: { timeoutMs: 100 } });
    expect(
      projected.find(({ tag }) => tag === "ProviderAdapterError"),
    ).toMatchObject({
      details: { providerId: "fixture", operation: "overview" },
    });
  });
});
