import type { HeaderArchitecture } from "../domain/binaryTargetTypes.js";

/** Bound Ghidra language for a caller-supplied raw-binary architecture. */
export interface GhidraRawBinaryLanguage {
  readonly languageId: string;
  readonly compilerSpecId: "default" | "gcc";
}

/**
 * Map the four caller-visible CPU families to little-endian generic Ghidra
 * languages with a supported generic compiler specification. These are
 * analysis conventions, not evidence of the target's original compiler.
 * Big-endian, Thumb-only, and Cortex-M variants are out of scope.
 */
export const ghidraRawBinaryLanguage = (
  architecture: HeaderArchitecture,
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
  }
};
