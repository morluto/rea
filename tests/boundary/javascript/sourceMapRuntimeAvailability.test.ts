import { expect, it } from "vitest";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { runSourceMapCommand } from "../../../src/javascript/sourceMaps/SourceMapCommand.js";
import { PrivateRuntimeRootUnavailableError } from "../../../src/process/PrivateRuntimeRootUnavailableError.js";

it.each([false, true])(
  "preserves private-runtime retryable=%s through the source-map operation",
  async (retryable) => {
    const reason = "Native runtime self-test failed with a sharing violation";
    let launches = 0;
    const result = await runSourceMapCommand("{}", "/selected.map", undefined, {
      prepareOwnership: async () => {},
      createRuntime: async () => {
        throw new PrivateRuntimeRootUnavailableError(reason, { retryable });
      },
      launcher: async () => {
        launches += 1;
        throw new Error("A refused runtime must not launch a codec");
      },
    });
    expect(launches).toBe(0);
    if (result.ok) throw new Error("Unavailable runtime must refuse decoding");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      category: retryable ? "unavailable" : "unsupported_provider",
      retryable,
      details: {
        provider_id: "source-map-decoder",
        operation: "trace_web_source_location",
        reason,
      },
    });
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);
