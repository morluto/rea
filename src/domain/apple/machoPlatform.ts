import { LC } from "./machoLoadCommandCodes.js";

/** Device platform encoded by a legacy LC_VERSION_MIN_* command. */
export type MachoVersionMinPlatform = 1 | 2 | 3 | 4;

/** loader.h LC_VERSION_MIN_* command codes and their device platforms. */
const MACHO_VERSION_MIN_PLATFORMS: ReadonlyMap<
  number,
  MachoVersionMinPlatform
> = new Map([
  [LC.VERSION_MIN_MACOSX, 1],
  [LC.VERSION_MIN_IPHONEOS, 2],
  [LC.VERSION_MIN_TVOS, 3],
  [LC.VERSION_MIN_WATCHOS, 4],
]);

/**
 * Legacy minimum-version commands contain exactly the four words in
 * `version_min_command`. Keep framing separate from the CPU-dependent platform.
 */
export const classifyMachoVersionMinCommand = (
  command: number,
  size: number,
):
  | { readonly kind: "exact"; readonly platform: MachoVersionMinPlatform }
  | { readonly kind: "truncated" | "oversized" }
  | null => {
  const platform = MACHO_VERSION_MIN_PLATFORMS.get(command);
  if (platform === undefined) return null;
  if (size === 16) return { kind: "exact", platform };
  return { kind: size < 16 ? "truncated" : "oversized" };
};

/**
 * dyld derives legacy simulator platforms from the CPU type. tvOS uses
 * x86_64 only; iOS and watchOS also recognize i386. Explicit LC_BUILD_VERSION
 * platforms do not use this rule.
 */
export const legacyMachoPlatform = (
  platform: MachoVersionMinPlatform,
  cpuType: number | null,
): number => {
  if (platform === 3) return cpuType === 0x01000007 ? 8 : 3;
  if (cpuType === 7 || cpuType === 0x01000007) {
    if (platform === 2) return 7;
    if (platform === 4) return 9;
  }
  return platform;
};
