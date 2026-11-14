import type { CanonicalizeRequestedFormat } from "./canonicalizeArtifact.js";
import {
  unrecognizedArtifactFacts,
  unrecognizedRequestedFacts,
  type CanonicalizeProfile,
  type NormalizedArtifactFacts,
  type NormalizerBudget,
} from "./normalizer.js";
import { asarHeaderNormalizer } from "./normalizers/asarHeader.js";
import { jsonStructureNormalizer } from "./normalizers/jsonStructure.js";
import { wasmSectionNormalizer } from "./normalizers/wasmSections.js";

/**
 * Default, config-driven normalizer set, in recognition order. New shields or
 * formats are added declaratively by extending this profile, not by forking the
 * orchestration below.
 */
export const DEFAULT_CANONICALIZE_PROFILE: CanonicalizeProfile = {
  normalizers: [
    wasmSectionNormalizer,
    asarHeaderNormalizer,
    jsonStructureNormalizer,
  ],
};

/**
 * Select a normalizer and produce bounded canonicalization facts. `auto`
 * recognizes the format from the bytes; an explicit format runs that
 * normalizer, which reports its own recognition limitation on a mismatch.
 */
export const canonicalizeArtifactFacts = (
  bytes: Buffer,
  requested: CanonicalizeRequestedFormat,
  budget: NormalizerBudget,
  profile: CanonicalizeProfile = DEFAULT_CANONICALIZE_PROFILE,
): NormalizedArtifactFacts => {
  if (requested === "auto") {
    const recognized = profile.normalizers.find((normalizer) =>
      normalizer.recognizes(bytes),
    );
    return recognized === undefined
      ? unrecognizedArtifactFacts()
      : recognized.canonicalize(bytes, budget);
  }
  const selected = profile.normalizers.find(
    (normalizer) => normalizer.format === requested,
  );
  return selected === undefined
    ? unrecognizedRequestedFacts(requested)
    : selected.canonicalize(bytes, budget);
};
