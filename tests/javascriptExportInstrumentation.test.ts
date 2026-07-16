import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { instrumentJavaScriptExport } from "../src/domain/javascriptExportInstrumentation.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

describe("JavaScript export instrumentation", () => {
  it.each([
    [
      "plain",
      "const hidden = (value) => value.trim();",
      "(value) => value.trim()",
    ],
    ["minified", "const x=a=>a+1,y=2;", "a=>a+1"],
    [
      "bundle",
      "(()=>{const registry={7:(m)=>m.exports=(x)=>x*2};globalThis.r=registry})()",
      "(x)=>x*2",
    ],
  ])(
    "deterministically exposes one exact %s expression",
    (_name, text, selectedText) => {
      const source = encode(text);
      const original = source.slice();
      const start = text.indexOf(selectedText);
      const selected = encode(selectedText);
      const input = {
        artifact_path: "/approved/app.js",
        artifact_sha256: sha256(source),
        selection: {
          byte_start: start,
          byte_end: start + selected.byteLength,
          selected_sha256: sha256(selected),
          export_name: "selected",
        },
      };

      const first = instrumentJavaScriptExport(source, input);
      const second = instrumentJavaScriptExport(source, input);

      expect(first).toEqual(second);
      expect(source).toEqual(original);
      expect(first.manifest).toMatchObject({
        original_sha256: sha256(source),
        instrumented_sha256: sha256(first.bytes),
        output_format: "commonjs-factory",
        inserted_ranges: [
          { purpose: "factory-prefix" },
          { purpose: "export-binding" },
          { purpose: "factory-suffix" },
        ],
      });
    },
  );

  it("rejects stale artifacts and ambiguous caller-selected bytes", () => {
    const source = encode("const hidden = () => 1;");
    const input = {
      artifact_path: "/approved/app.js",
      artifact_sha256: "0".repeat(64),
      selection: {
        byte_start: 15,
        byte_end: 22,
        selected_sha256: "1".repeat(64),
        export_name: "hidden",
      },
    };

    expect(() => instrumentJavaScriptExport(source, input)).toThrow(
      /artifact digest mismatch/u,
    );
    expect(() =>
      instrumentJavaScriptExport(source, {
        ...input,
        artifact_sha256: sha256(source),
      }),
    ).toThrow(/selection digest mismatch/u);
  });
});
