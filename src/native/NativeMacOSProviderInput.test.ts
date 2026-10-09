import { describe, expect, it } from "vitest";

import { NativeMacOSProvider } from "./NativeMacOSProvider.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../tests/fixtures/nativeCommands.js";

describe("native dispatch metadata input boundary", () => {
  it("retains canonical argument failures before attempting target inspection", async () => {
    const client = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner(),
      "darwin",
    ).createClient(nativeMachoTarget("/does-not-exist"));
    const cases: ReadonlyArray<{
      parameters: Readonly<Record<string, JsonValue>>;
      path: string;
      reason: string;
    }> = [
      {
        parameters: { max_records: null },
        path: "max_records",
        reason: "invalid_type",
      },
      {
        parameters: { max_records: "5" },
        path: "max_records",
        reason: "invalid_type",
      },
      {
        parameters: { max_records: 0 },
        path: "max_records",
        reason: "out_of_range",
      },
      {
        parameters: { max_record: 5 },
        path: "max_record",
        reason: "unknown_argument",
      },
    ];
    for (const { parameters, path, reason } of cases) {
      const result = await client.execute(
        "inspect_native_dispatch_metadata",
        parameters,
      );
      if (result.ok)
        throw new Error("Expected invalid dispatch metadata input");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_native_dispatch_metadata",
          issues: [{ path: [path], reason }],
        },
      });
    }
  });
});
