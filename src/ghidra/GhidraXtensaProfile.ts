import { isDeepStrictEqual } from "node:util";

import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";

/**
 * Ghidra 12.1.4 `xtensa.ldefs` defines this language with a single compiler
 * specification, id `default` (`xtensa.cspec`); there is no `gcc` id. Its
 * default prototype models windowed calls.
 */
export const GHIDRA_XTENSA_LANGUAGE: GhidraLanguageOverride = {
  languageId: "Xtensa:LE:32:default",
  compilerSpecId: "default",
};

const ET_REL = 1;
const ET_EXEC = 2;
const ET_DYN = 3;

/** binutils `include/elf/xtensa.h`; `E_XTENSA_MACH` (0) is the only machine value. */
const EF_XTENSA_MACH = 0x0000000f;
const EF_XTENSA_XT_INSN = 0x00000100;
const EF_XTENSA_XT_LIT = 0x00000200;

/**
 * Bits this lane reads. Anything else in `e_flags` is refused rather than
 * assumed compatible.
 */
const EF_XTENSA_DECLARED_BITS =
  EF_XTENSA_MACH | EF_XTENSA_XT_INSN | EF_XTENSA_XT_LIT;

/** Keep family recognition separate from the deliberately bounded Ghidra lane. */
export const ghidraXtensaUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (target.kind !== "executable" || target.architecture !== "xtensa")
    return null;
  const metadata = target.xtensa;
  if (metadata.elfClass !== 32)
    return "This Ghidra Xtensa lane supports ELF32 only; Ghidra 12.1.4 ships 32-bit Xtensa languages only.";
  if (metadata.byteOrder !== "little")
    return "This Ghidra Xtensa lane supports little-endian images only; big-endian Xtensa cores need separate verification.";
  if (metadata.type !== ET_EXEC)
    return `This Ghidra Xtensa lane supports fixed-address ET_EXEC only; ${
      metadata.type === ET_REL
        ? "relocatable"
        : metadata.type === ET_DYN
          ? "shared and position-independent"
          : `e_type ${metadata.type}`
    } images need separate load verification.`;
  const unsupportedFlags = (metadata.flags & ~EF_XTENSA_DECLARED_BITS) >>> 0;
  if (unsupportedFlags !== 0)
    return `Xtensa e_flags declares bits outside the verified lane (0x${unsupportedFlags.toString(16)}); reserved or newer declarations are not treated as compatible with this profile.`;
  if ((metadata.flags & EF_XTENSA_MACH) !== 0)
    return `Xtensa e_flags declares machine ${metadata.flags & EF_XTENSA_MACH}; binutils defines only E_XTENSA_MACH (0), so this lane does not guess a core.`;
  const abi = metadata.abi;
  if (abi === undefined)
    return "The Xtensa ABI declaration in .xtensa.info was not inspected; this lane does not infer the windowed ABI.";
  switch (abi.status) {
    case "declared":
      return abi.abi === "windowed"
        ? null
        : "The image declares the call0 ABI in .xtensa.info, as ESP8266 builds do. This lane admits the windowed ABI that ESP-IDF uses for ESP32, ESP32-S2 and ESP32-S3; Ghidra's default Xtensa prototype models windowed calls, so call0 needs its own calling-convention selection and verification.";
    case "unrecognized":
      return `The image declares ABI=${abi.value} in .xtensa.info, which binutils does not define; this lane admits only the windowed ABI (0).`;
    case "absent":
      return "The image declares no ABI in .xtensa.info; this lane does not infer the windowed ABI from the family name.";
    case "unavailable":
      return [
        "The Xtensa ABI declaration is unreadable or malformed, so this lane does not infer the windowed ABI.",
        abi.reason,
      ].join(" ");
  }
};

/** Pin the language only for declarations admitted by the same lane boundary. */
export const ghidraXtensaLanguage = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined =>
  target.kind === "executable" &&
  target.architecture === "xtensa" &&
  ghidraXtensaUnsupportedReason(target) === null
    ? GHIDRA_XTENSA_LANGUAGE
    : undefined;

/** Commit source ELF interpretation without confusing target ISA with host CPU. */
export const ghidraXtensaProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  if (target.kind !== "executable" || target.architecture !== "xtensa")
    return {};
  const { elfClass, byteOrder, type, flags, abi } = target.xtensa;
  return {
    xtensa_elf: {
      elf_class: elfClass,
      byte_order: byteOrder,
      type,
      flags,
      abi: abi?.status === "declared" ? abi.abi : null,
    },
    xtensa_support_lane: "elf32-le-exec-windowed-generic-v1",
  };
};

/**
 * Bind a committed Xtensa profile to the target being imported. Every admitted
 * Xtensa ELF pins the same language, so the language checks alone cannot tell
 * a profile resolved for another image, whose ELF facts every Evidence record
 * would then attribute to this one.
 */
export const ghidraXtensaProfileMismatchReason = (
  target: BinaryTarget,
  parameters: Readonly<Record<string, unknown>>,
): string | null => {
  const expected = ghidraXtensaProfileParameters(target);
  return isDeepStrictEqual(parameters.xtensa_elf, expected.xtensa_elf) &&
    parameters.xtensa_support_lane === expected.xtensa_support_lane
    ? null
    : "The committed Xtensa analysis profile was resolved for a different target; reopen the target to resolve a new profile.";
};

/** What verify:ghidra:xtensa and REA's ESP-IDF measurement establish, and what they do not. */
export const ghidraXtensaLimitations = (
  target: BinaryTarget,
): readonly string[] =>
  target.kind === "executable" && target.architecture === "xtensa"
    ? [
        "REA verifies this lane against Ghidra 12.1.4 with source-owned windowed-call fixtures (entry, call8, retw.n, l32r). Decompiled code for other images is not verified function by function; check call targets and arguments against the assembly when they matter.",
        "REA pins Ghidra's generic `Xtensa:LE:32:default` language with the `default` compiler specification, whose default prototype models windowed calls according to Ghidra 12.1.4's xtensa.cspec. The language does not identify the ESP32, ESP32-S2 or ESP32-S3 core configuration or the producing compiler.",
        "Measured by REA: Ghidra 12.1.4 does not decode SALT/SALTU, which ESP32-S3 builds use, so disassembly, calls and parameters after them are missing in that function. Reported upstream or derived from Ghidra 12.1.4 sources, not reproduced by REA: decompiled output approximates register-window rotation; FLIX bundles and ESP32-S3 `ee.*` vector instructions are not decoded; zero-overhead loops are mis-modeled.",
      ]
    : [];
