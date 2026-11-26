import { describe, expect, it } from "vitest";
import type {
  BinaryTarget,
  MipsElfMetadata,
} from "../domain/binaryTargetTypes.js";
import { ghidraPinnedLanguage } from "./GhidraAnalysisProfile.js";
import {
  GHIDRA_EE_LANGUAGE_ID,
  GHIDRA_EE_SUPPORT_LANE,
  ghidraEeLanguageOverride,
  ghidraEeProfileParameters,
  ghidraEeUnsupportedReason,
  isGhidraEeTarget,
} from "./GhidraEeProfile.js";
import { ghidraProcessorUnsupportedReason } from "./GhidraPspProfile.js";
import {
  ghidraMipsProfileMismatchReason,
  ghidraMipsProfileParameters,
} from "./GhidraMipsProfile.js";

// The declaration ee-gcc writes for a retail PlayStation 2 executable:
// MIPS III, R5900, EABI64, no ABI flags record, no GNU attributes.
const EE_FLAGS = 0x20924000;

const target = (change: Partial<MipsElfMetadata> = {}): BinaryTarget => ({
  path: "/fixture.elf",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "mips",
  availableArchitectures: ["mips"],
  mips: {
    elfClass: 32,
    byteOrder: "little",
    type: 2,
    flags: EE_FLAGS,
    gnuAttributes: null,
    abiFlags: null,
    ...change,
  },
});

describe("PlayStation 2 EE profile", () => {
  it("recognises the EF_MIPS_MACH_5900 declaration", () => {
    expect(isGhidraEeTarget(target())).toBe(true);
    expect(isGhidraEeTarget(target({ flags: 0x70001001 }))).toBe(false);
  });

  it("admits the ee-gcc declaration and pins the extension's language", () => {
    expect(ghidraEeUnsupportedReason(target())).toBeNull();
    expect(ghidraProcessorUnsupportedReason(target())).toBeNull();
    expect(ghidraEeLanguageOverride(target())).toEqual({
      languageId: GHIDRA_EE_LANGUAGE_ID,
      compilerSpecId: "default",
    });
    expect(ghidraPinnedLanguage(target())).toEqual({
      languageId: GHIDRA_EE_LANGUAGE_ID,
      compilerSpecId: "default",
    });
    expect(ghidraEeProfileParameters(target())).toMatchObject({
      mips_support_lane: GHIDRA_EE_SUPPORT_LANE,
      language_id: GHIDRA_EE_LANGUAGE_ID,
      compiler_spec_id: "default",
      language_selection: "provider-pinned",
    });
  });

  it("admits NOREORDER and a missing ABI field, nothing else", () => {
    expect(
      ghidraEeUnsupportedReason(target({ flags: EE_FLAGS | 1 })),
    ).toBeNull();
    expect(
      ghidraEeUnsupportedReason(target({ flags: EE_FLAGS & ~0x00004000 })),
    ).toBeNull();
    const refused: readonly [Partial<MipsElfMetadata>, RegExp][] = [
      [{ flags: EE_FLAGS | 0x04000000 }, /ASE/u],
      [{ flags: (EE_FLAGS & ~0xf0000000) | 0x70000000 }, /EF_MIPS_ARCH_3/u],
      [{ flags: (EE_FLAGS & ~0x0000f000) | 0x00001000 }, /EABI64/u],
      [{ flags: EE_FLAGS | 0x100 }, /undeclared/u],
      [{ byteOrder: "big" }, /little-endian/u],
      [{ type: 1 }, /ET_EXEC/u],
      [
        {
          abiFlags: {
            version: 0,
            isaLevel: 3,
            isaRevision: 0,
            gprSize: 2,
            cpr1Size: 1,
            cpr2Size: 0,
            fpAbi: 1,
            isaExtension: 0,
            ases: 0,
            flags1: 0,
            flags2: 0,
          },
        },
        /ABI flags record/u,
      ],
    ];
    for (const [change, reason] of refused) {
      const altered = target(change);
      expect(ghidraEeUnsupportedReason(altered)).toMatch(reason);
      expect(ghidraEeLanguageOverride(altered)).toBeUndefined();
      expect(ghidraEeProfileParameters(altered)).toEqual({});
    }
  });

  it("refuses an uninspected ABI flags declaration", () => {
    const value = target();
    if (value.kind !== "executable" || value.architecture !== "mips")
      throw new Error("expected MIPS target");
    const facts = { ...value.mips };
    delete facts.abiFlags;
    const uninspected = { ...value, mips: facts };
    expect(ghidraEeUnsupportedReason(uninspected)).not.toBeNull();
    expect(ghidraEeLanguageOverride(uninspected)).toBeUndefined();
  });

  it("leaves generic MIPS and PSP declarations to their own lanes", () => {
    expect(ghidraEeUnsupportedReason(target({ flags: 0x70001001 }))).toBeNull();
    expect(ghidraEeUnsupportedReason(target({ flags: 0x10a23001 }))).toBeNull();
    expect(
      ghidraEeLanguageOverride(target({ flags: 0x70001001 })),
    ).toBeUndefined();
  });

  it.each([
    { fpAbi: 1, msa: 0 },
    { fpAbi: 0, msa: null },
    { fpAbi: null, msa: null },
  ])("refuses GNU MIPS attributes %o", (gnuAttributes) => {
    const value = target({ gnuAttributes });
    expect(ghidraEeUnsupportedReason(value)).toMatch(
      /GNU MIPS ABI attributes/u,
    );
    expect(ghidraEeLanguageOverride(value)).toBeUndefined();
    expect(ghidraProcessorUnsupportedReason(value)).not.toBeNull();
  });

  it("refuses an uninspected GNU attributes section", () => {
    const value = target();
    if (value.kind !== "executable" || value.architecture !== "mips")
      throw new Error("expected MIPS target");
    const facts = { ...value.mips };
    delete facts.gnuAttributes;
    expect(ghidraEeUnsupportedReason({ ...value, mips: facts })).not.toBeNull();
  });

  it("binds the committed EE lane, not the generic MIPS lane, at open", () => {
    const value = target();
    const lane = ghidraEeProfileParameters(value);
    const committed = { ...ghidraMipsProfileParameters(value), ...lane };
    expect(
      ghidraMipsProfileMismatchReason(value, committed, false, lane),
    ).toBeNull();
    // Without the extension lane the generic expectation refuses the profile.
    expect(
      ghidraMipsProfileMismatchReason(value, committed, false),
    ).not.toBeNull();
    // A generic-lane commitment does not satisfy the EE expectation.
    expect(
      ghidraMipsProfileMismatchReason(
        value,
        ghidraMipsProfileParameters(value),
        false,
        lane,
      ),
    ).not.toBeNull();
  });
});
