import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { fingerprintJavaScriptAst } from "./javascriptAstFingerprint.js";

describe("JavaScript AST fingerprints", () => {
  it("includes complete literal values in the fingerprint", () => {
    const prefix = "x".repeat(1_024);
    const left = parse(`const value = ${JSON.stringify(`${prefix}left`)};`);
    const right = parse(`const value = ${JSON.stringify(`${prefix}right`)};`);

    expect(fingerprintJavaScriptAst(left)).not.toBe(
      fingerprintJavaScriptAst(right),
    );
  });
});
