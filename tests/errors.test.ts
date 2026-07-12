import { describe, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
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
  NoBinaryOpenError,
  ProviderAdapterError,
  ProviderSelectionError,
  projectAnalysisError,
  type AnalysisError,
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
    const errors: readonly AnalysisError[] = [
      new AnalysisProtocolError("protocol"),
      new AnalysisInputError("overview", { cause: secretCause }),
      new AnalysisOutputError("overview", "invalid shape", {
        cause: secretCause,
      }),
      new AnalysisCapabilityUnavailableError("fixture", "overview", "absent"),
      new AnalysisCancelledError("overview"),
      new ProviderSelectionError("overview"),
      new ProviderAdapterError("fixture", "overview", { cause: secretCause }),
      new ProcessCaptureError("capture refused", { cause: secretCause }),
      new EvidenceIntegrityError("integrity", { cause: secretCause }),
      new EvidenceLimitError("records", 10),
      new EvidenceFileError("read", "outside-root", { cause: secretCause }),
      new HopperTimeoutError(100),
      new HopperCancelledError(),
      new HopperProtocolError("wire", { cause: secretCause }),
      new HopperRemoteError(7, "safe"),
      new HopperProcessError(1),
      new HopperStartError({ cause: secretCause }),
      new ConfigurationError("configuration", { cause: secretCause }),
      new NoBinaryOpenError(),
      new BinaryTargetError("/secret/local/path", "invalid", {
        cause: secretCause,
      }),
    ];
    const projected = errors.map(projectAnalysisError);
    expect(new Set(projected.map(({ tag }) => tag)).size).toBe(errors.length);
    expect(projected).toHaveLength(20);
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
