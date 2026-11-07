import { expect, it } from "vitest";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { err, ok } from "../../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../AnalysisProvider.js";
import { inspectNativeDispatch } from "./NativeDispatchMetadataInspection.js";

it("retains the binary reader refusal when the symbol fallback also fails", async () => {
  const direct = new AnalysisCapabilityUnavailableError(
    "native-macos",
    "inspect_native_dispatch_metadata",
    "Unsupported 32-bit Mach-O metadata",
  );
  const fallback = new AnalysisOutputError(
    "list_names",
    "symbol provider unavailable",
  );
  const analysis: AnalysisOperationPort = {
    execute: async (operation) =>
      err(operation === "list_names" ? fallback : direct),
  };
  const result = await inspectNativeDispatch(analysis, 10);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBe(fallback);
  expect(result.error.secondaryFailures).toContain(direct);
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      diagnostics: {
        binary_metadata_failure: {
          details: { reason: expect.stringContaining("Unsupported 32-bit") },
        },
      },
    },
  });
});

it("retains both the reader refusal and malformed symbol observation", async () => {
  const direct = new AnalysisCapabilityUnavailableError(
    "native-macos",
    "inspect_native_dispatch_metadata",
    "Unsupported 32-bit Mach-O metadata",
  );
  const analysis: AnalysisOperationPort = {
    execute: async (operation) =>
      operation === "list_names"
        ? ok(
            createAnalysisExecution(
              { invalid: true },
              { id: "fixture", name: "Fixture", version: "1" },
            ),
          )
        : err(direct),
  };
  const result = await inspectNativeDispatch(analysis, 10);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.secondaryFailures).toContain(direct);
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      diagnostics: {
        binary_metadata_failure: {
          details: { reason: "Unsupported 32-bit Mach-O metadata" },
        },
      },
      partial_observation: expect.any(Object),
    },
  });
});
