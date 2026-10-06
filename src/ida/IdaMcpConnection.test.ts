import { describe, expect, it } from "vitest";
import {
  decodeIdaToolResult,
  redactIdaTransportFailure,
} from "./IdaMcpConnection.js";

describe("upstream IDA tool result decoding", () => {
  it("redacts configured transport authentication without redacting caller evidence", () => {
    const error = redactIdaTransportFailure(
      new Error(
        "Invalid Authorization value Bearer fixture-secret at /caller/input",
      ),
      {
        url: "http://127.0.0.1:12345/mcp",
        headers: { Authorization: "Bearer fixture-secret" },
        mode: "attached",
        timeoutMs: 1000,
      },
    );
    expect(error.message).not.toContain("fixture-secret");
    expect(error.message).toContain("/caller/input");
    expect(
      decodeIdaToolResult({
        content: [
          { type: "text", text: "Caller-selected fixture-secret evidence" },
        ],
      }),
    ).toBe("Caller-selected fixture-secret evidence");
  });
  it("decodes scalar wrappers and legacy text without dropping structured dictionaries", () => {
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { result: "code" },
      }),
    ).toBe("code");
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { path: "input", result: "field" },
      }),
    ).toEqual({ path: "input", result: "field" });
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: '[{"address":"0x1000"}]' }],
      }),
    ).toEqual([{ address: "0x1000" }]);
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: "int main(void);" }],
      }),
    ).toBe("int main(void);");
  });
  it("preserves upstream failures and rejects truncated previews that still satisfy item schemas", () => {
    expect(() => decodeIdaToolResult({ content: [] })).toThrow(
      "empty observation",
    );
    expect(() =>
      decodeIdaToolResult({
        isError: true,
        content: [{ type: "text", text: "Decompiler license is unavailable" }],
      }),
    ).toThrow("Decompiler license is unavailable");
    expect(() =>
      decodeIdaToolResult({
        isError: false,
        structuredContent: {
          result: [{ addr: "0x1000", name: "main", size: "0x20" }],
        },
        content: [{ type: "text", text: "preview" }],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            total_chars: 70000,
            download_hint: "Download the full upstream output",
          },
        },
      }),
    ).toThrow("Download the full upstream output");
  });
});
