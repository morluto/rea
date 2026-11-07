import { describe, expect, it } from "vitest";

import {
  formatFromExtension,
  profileFactsFromHeader,
  targetProfileFactsSchema,
  unparsedFacts,
} from "./targetProfile.js";
import { elf, pe, thinMach, dosMz } from "./binaryTarget.fixture.js";
import { parseExecutableHeader } from "./binaryTarget.js";

const headerOf = (bytes: Buffer) => {
  const parsed = parseExecutableHeader(bytes, "x64");
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
  return parsed.value;
};

describe("target profile facts", () => {
  it("marks every header-derived fact as confirmed", () => {
    const facts = profileFactsFromHeader(headerOf(pe(0x8664)));

    expect(facts.format).toEqual({
      value: "pe",
      confidence: "confirmed",
      basis: "parsed-header",
    });
    expect(facts.architecture.value).toBe("x86_64");
    expect(facts.architecture.confidence).toBe("confirmed");
    expect(facts.managed.basis).toBe("parsed-header");
  });

  it("reports PE role and managed flag only when the header carries them", () => {
    const facts = profileFactsFromHeader(headerOf(pe(0x8664)));

    expect(facts.executable_role.value).toBe("application");
    expect(facts.executable_role.confidence).toBe("confirmed");
  });

  it.each([
    ["elf x86_64", elf(1, 1, 62)],
    ["elf arm64", elf(2, 2, 183)],
    ["thin mach-o arm64", thinMach(0xfeedfacf, 0x0100000c)],
    ["dos mz", dosMz()],
  ])(
    "leaves PE-only facts unknown for %s instead of defaulting them",
    (_label, bytes) => {
      const facts = profileFactsFromHeader(headerOf(bytes));

      expect(facts.executable_role).toEqual({
        value: null,
        confidence: "unknown",
        basis: "not-observed",
      });
      expect(facts.managed).toEqual({
        value: null,
        confidence: "unknown",
        basis: "not-observed",
      });
    },
  );

  it("never claims a confirmed fact when no header was parsed", () => {
    const facts = unparsedFacts(null);

    for (const fact of Object.values(facts)) {
      expect(fact.confidence).toBe("unknown");
      expect(fact.value).toBeNull();
      expect(fact.basis).toBe("not-observed");
    }
  });

  it("treats a filename extension as likely evidence, never confirmed", () => {
    const facts = unparsedFacts("pe");

    expect(facts.format).toEqual({
      value: "pe",
      confidence: "likely",
      basis: "file-extension",
    });
    expect(facts.architecture.value).toBeNull();
  });

  it("rejects a fact shape that strays from the contract", () => {
    expect(() =>
      targetProfileFactsSchema.parse({
        format: { value: "pe", confidence: "confirmed" },
        architecture: {
          value: null,
          confidence: "unknown",
          basis: "not-observed",
        },
        available_architectures: {
          value: null,
          confidence: "unknown",
          basis: "not-observed",
        },
        executable_role: {
          value: null,
          confidence: "unknown",
          basis: "not-observed",
        },
        managed: { value: null, confidence: "unknown", basis: "not-observed" },
      }),
    ).toThrow();
  });
});

describe("format hint from filename", () => {
  it.each([
    ["C:\\windows\\system32\\notepad.exe", "pe"],
    ["libfoo.so", "elf"],
    ["libbar.dylib", "mach-o"],
    ["COMMAND.COM", "dos-com"],
    ["archive.zip", null],
    ["no-extension", null],
  ] as const)("maps %s to %s", (path, expected) => {
    expect(formatFromExtension(path)).toBe(expected);
  });
});
