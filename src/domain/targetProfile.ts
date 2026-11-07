import { z } from "zod";

import type { ExecutableMetadata } from "./binaryTarget.js";
import { BINARY_ARCHITECTURES } from "./binaryTargetTypes.js";

/**
 * Evidence strength for a single profiled fact.
 *
 * The ladder exists so a consumer can tell "the header declared this" apart
 * from "the filename hinted at this" without having to know which parser ran.
 * Collapsing them into one boolean is what makes profile output untrustworthy.
 */
export const TARGET_FACT_CONFIDENCES = [
  "confirmed",
  "strongly-supported",
  "likely",
  "possible",
  "unknown",
] as const;
export type TargetFactConfidence = (typeof TARGET_FACT_CONFIDENCES)[number];

/** How a profiled fact was established. */
export const TARGET_FACT_BASES = [
  "parsed-header",
  "file-extension",
  "not-observed",
] as const;
export type TargetFactBasis = (typeof TARGET_FACT_BASES)[number];

/**
 * Executable formats `parseExecutableHeader` can report.
 *
 * Deliberately narrower than the repo-wide target format list: a header parse
 * never yields `raw-binary`, archive or database formats, and admitting them
 * here would make every profile describe a possibility it cannot establish.
 */
export const PROFILED_EXECUTABLE_FORMATS = [
  "elf",
  "mach-o",
  "mach-o-universal",
  "pe",
  "dos-mz",
  "dos-com",
] as const;
export type ProfiledExecutableFormat =
  (typeof PROFILED_EXECUTABLE_FORMATS)[number];

/** PE image role observed from COFF characteristics. */
export const PROFILED_EXECUTABLE_ROLES = [
  "application",
  "shared-library",
  "non-executable",
] as const;
export type ProfiledExecutableRole = (typeof PROFILED_EXECUTABLE_ROLES)[number];

export const profiledFormatSchema = z.enum(PROFILED_EXECUTABLE_FORMATS);
export const profiledArchitectureSchema = z.enum(BINARY_ARCHITECTURES);
export const profiledExecutableRoleSchema = z.enum(PROFILED_EXECUTABLE_ROLES);

/**
 * One profiled fact: its value, how sure we are, and why.
 *
 * `value` is nullable rather than optional so an absent fact is always present
 * in the document. Consumers can therefore enumerate every fact without
 * distinguishing "key omitted" from "fact unknown".
 */
const profiledFactSchema = <Value extends z.ZodType>(value: Value) =>
  z.strictObject({
    value: value.nullable(),
    confidence: z.enum(TARGET_FACT_CONFIDENCES),
    basis: z.enum(TARGET_FACT_BASES),
  });

export const targetProfileFactsSchema = z.strictObject({
  format: profiledFactSchema(profiledFormatSchema),
  architecture: profiledFactSchema(profiledArchitectureSchema),
  available_architectures: profiledFactSchema(
    z.array(profiledArchitectureSchema),
  ),
  executable_role: profiledFactSchema(profiledExecutableRoleSchema),
  managed: profiledFactSchema(z.boolean()),
});

/**
 * Provider-neutral profile of one target, derived from a bounded read.
 *
 * `limitations` is mandatory, not optional: every profile states what it could
 * not establish. An empty array is a claim that the bounded read was
 * sufficient, and callers should treat it as such.
 */
export const targetProfileSchema = z.strictObject({
  path: z.string().min(1),
  size_bytes: z.number().int().min(0),
  bytes_inspected: z.number().int().min(0),
  facts: targetProfileFactsSchema,
  limitations: z.array(z.string().min(1)),
});

export type TargetProfileFacts = z.infer<typeof targetProfileFactsSchema>;
export type TargetProfile = z.infer<typeof targetProfileSchema>;

/** Build one fact from a value whose evidence was observed directly. */
export const observedFact = <Value>(
  value: Value,
  confidence: TargetFactConfidence,
  basis: TargetFactBasis,
): {
  readonly value: Value;
  readonly confidence: TargetFactConfidence;
  readonly basis: TargetFactBasis;
} => ({
  value,
  confidence,
  basis,
});

/**
 * Build a fact that this read did not establish.
 *
 * Kept as a named constructor so no call site is tempted to pass `null` with a
 * stronger confidence by accident. The explanatory text for an unobserved fact
 * belongs in the profile's `limitations`, not on the fact itself: the fact
 * schema is strict, and a per-fact `reason` would duplicate that array.
 */
export const unobservedFact = <Value>(): {
  readonly value: null;
  readonly confidence: "unknown";
  readonly basis: "not-observed";
} => ({
  value: null,
  confidence: "unknown",
  basis: "not-observed",
});

/**
 * Project parsed header metadata into profile facts.
 *
 * Everything here came out of a parsed header at a declared offset, so it is
 * `confirmed` by construction. Facts this header family does not carry (PE role
 * and managed flag on non-PE files) stay `unknown` rather than being defaulted,
 * because a default would be indistinguishable from an observation.
 */
export const profileFactsFromHeader = (
  metadata: ExecutableMetadata,
): TargetProfileFacts => {
  const format = observedFact(metadata.format, "confirmed", "parsed-header");
  const architecture = observedFact(
    metadata.architecture,
    "confirmed",
    "parsed-header",
  );
  const availableArchitectures = observedFact(
    [...metadata.availableArchitectures],
    "confirmed",
    "parsed-header",
  );

  if (metadata.format === "pe")
    return targetProfileFactsSchema.parse({
      format,
      architecture,
      available_architectures: availableArchitectures,
      executable_role: observedFact(
        metadata.executableRole,
        "confirmed",
        "parsed-header",
      ),
      managed: observedFact(metadata.managed, "confirmed", "parsed-header"),
    });

  return targetProfileFactsSchema.parse({
    format,
    architecture,
    available_architectures: availableArchitectures,
    executable_role: unobservedFact<ProfiledExecutableRole>(),
    managed: unobservedFact<boolean>(),
  });
};

/**
 * Facts for a target whose bytes did not yield a usable executable header.
 *
 * A filename is weak evidence - it is attacker- and accident-controlled - so a
 * recognised extension earns `likely`, never `confirmed`.
 */
export const unparsedFacts = (
  extensionFormat: ProfiledExecutableFormat | null,
): TargetProfileFacts =>
  targetProfileFactsSchema.parse({
    format:
      extensionFormat === null
        ? unobservedFact<ProfiledExecutableFormat>()
        : observedFact(extensionFormat, "likely", "file-extension"),
    architecture: unobservedFact(),
    available_architectures: unobservedFact(),
    executable_role: unobservedFact(),
    managed: unobservedFact(),
  });

/** Map a filename extension to the format it weakly suggests, if any. */
export const formatFromExtension = (
  path: string,
): ProfiledExecutableFormat | null => {
  const match = /\.([A-Za-z0-9]+)$/u.exec(path);
  if (match === null) return null;
  switch (match[1]?.toLowerCase()) {
    case "exe":
    case "dll":
    case "sys":
    case "efi":
      return "pe";
    case "so":
      return "elf";
    case "dylib":
      return "mach-o";
    case "com":
      return "dos-com";
    default:
      return null;
  }
};
