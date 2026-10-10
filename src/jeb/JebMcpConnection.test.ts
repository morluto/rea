import { describe, expect, it } from "vitest";

import { decodeJebToolResult } from "./JebMcpConnection.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

describe("decodeJebToolResult", () => {
  it("passes refusal envelopes through so the provider preserves the engine reason", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        structuredContent: {
          success: false,
          message: "The decompilation failed because the item is missing",
        },
      }),
    ).toEqual({
      success: false,
      message: "The decompilation failed because the item is missing",
    });
  });

  it("decodes a single JSON text block", () => {
    expect(
      decodeJebToolResult({
        content: [
          { type: "text", text: '{"success":true,"text":"int x(){}"}' },
        ],
      }),
    ).toEqual({ success: true, text: "int x(){}" });
  });

  it("keeps non-JSON success text as an observed string", () => {
    expect(
      decodeJebToolResult({
        content: [{ type: "text", text: "plain observation" }],
      }),
    ).toBe("plain observation");
  });

  it("rejects unparseable error text as a protocol failure with the engine text", () => {
    expect(() =>
      decodeJebToolResult({
        isError: true,
        content: [{ type: "text", text: "engine exploded" }],
      }),
    ).toThrow(/engine exploded/);
  });

  it("rejects contentless results instead of inventing an observation", () => {
    expect(() => decodeJebToolResult({ content: [] })).toThrow(
      AnalysisProtocolError,
    );
  });
});
