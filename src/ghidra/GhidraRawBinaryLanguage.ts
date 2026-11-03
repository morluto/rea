import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";

/** Bound Ghidra language for a caller-supplied raw-binary architecture. */
export interface GhidraRawBinaryLanguage {
  readonly languageId: string;
  readonly compilerSpecId: "default" | "gcc";
}

/**
 * Map caller-visible CPU families to little-endian Ghidra languages with a
 * supported generic compiler specification. These are analysis conventions,
 * not evidence of the target's original compiler. Big-endian ARM and
 * Thumb-only variants other than Cortex-M remain out of scope.
 */
export const ghidraRawBinaryLanguage = (
  architecture: Exclude<BinaryArchitecture, "mips">,
): GhidraRawBinaryLanguage => {
  switch (architecture) {
    case "x86":
      return { languageId: "x86:LE:32:default", compilerSpecId: "gcc" };
    case "x86_64":
      return { languageId: "x86:LE:64:default", compilerSpecId: "gcc" };
    case "arm":
      return { languageId: "ARM:LE:32:v7", compilerSpecId: "default" };
    case "arm64":
      return { languageId: "AARCH64:LE:64:v8A", compilerSpecId: "default" };
    case "cortex-m":
      return { languageId: "ARM:LE:32:Cortex", compilerSpecId: "default" };
  }
};
