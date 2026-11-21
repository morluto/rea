import { describe, expect, it } from "vitest";
import { functionFileText } from "./functionFile.js";

const input = {
  procedure: { address: "0x1000", name: "unobfuscated" },
  body: { available: false as const, reason: "not observed" },
  identity: {
    targetSha256: "a".repeat(64),
    provider: { id: "fixture", name: "Ghidra", version: "12.1" },
    analysisProfileDigest: "b".repeat(64),
    layout: "address" as const,
  },
  limitations: ["partial output"],
  pseudocode: "return 0;\n",
};

describe("decompile function-file headers", () => {
  it("keeps unusual obfuscated names and provider diagnostics on comment lines", () => {
    const pseudocode = "int original(void) { return 42; }\n";
    const file = functionFileText({
      ...input,
      procedure: {
        ...input.procedure,
        name: "masked\u2028int counterfeit;\u2029name",
      },
      body: { available: false, reason: "missing\u0085fragment" },
      identity: {
        ...input.identity,
        provider: { id: "f", name: "engine\u2028spoof", version: "1" },
      },
      limitations: ["bad\u2029metadata"],
      pseudocode,
    });
    const [header, body] = file.split("\n\n");
    expect(body).toBe(pseudocode);
    expect(header).toContain("// name: masked int counterfeit; name");
    expect(header).toContain("// body_reason: missing fragment");
    expect(header).toContain("// provider: engine spoof 1 (f)");
    expect(header).toContain("// limitations: bad metadata");
    expect(header).not.toMatch(/[\u0085\u2028\u2029]/u);
    expect(header?.split("\n").every((line) => line.startsWith("// "))).toBe(
      true,
    );
  });

  it("retains the exact existing header for ordinary symbols and pseudocode", () => {
    const file = functionFileText(input);
    expect(file).toContain("// name: unobfuscated\n");
    expect(file).toContain("// limitations: partial output\n");
    expect(file.endsWith("\n\nreturn 0;\n")).toBe(true);
  });

  it("truncates long provider diagnostics without changing their prefix", () => {
    const limitation = "x".repeat(9_000);
    const file = functionFileText({
      ...input,
      procedure: { ...input.procedure, name: "n".repeat(50_000) },
      limitations: [limitation, ...Array.from({ length: 10_000 }, () => "y")],
    });
    expect(file).toContain("// name: " + "n".repeat(2_000) + "\n");
    expect(file).toContain("// limitations: " + "x".repeat(2_000) + "; y; y");
    expect(file).toContain("// limitations_truncated: true");
    const header = file.split("\n\n")[0];
    const line = header
      ?.split("\n")
      .find((row) => row.startsWith("// limitations:"));
    expect(line?.length).toBe(4_016);
  });
});
