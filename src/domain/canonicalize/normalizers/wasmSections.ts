import type {
  CanonicalizeFact,
  CanonicalizeReduction,
} from "../canonicalizeArtifact.js";
import {
  canonicalizeDigest,
  canonicalizeSample,
  type ArtifactNormalizer,
  type NormalizedArtifactFacts,
  type NormalizerBudget,
} from "../normalizer.js";

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
/** Defensive ceiling so a malformed length field cannot spin the walk. */
const MAX_SECTIONS = 1_000_000;

/** Known core section ids whose presence and bytes drive module behavior. */
const CORE_SECTION_NAMES: Readonly<Record<number, string>> = {
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "data-count",
  13: "tag",
};

/**
 * Custom sections the core semantics ignore but that a linker or toolchain
 * consumes; their identity is behavior-relevant for a module that will be
 * linked, so they are retained rather than collapsed. Matched case-sensitively
 * by exact name or, for relocations, the `reloc.` prefix.
 */
const LINK_RELEVANT_CUSTOM = new Set([
  "linking",
  "dylink",
  "dylink.0",
  "target_features",
]);
const isLinkRelevantCustom = (name: string): boolean =>
  LINK_RELEVANT_CUSTOM.has(name) || name.startsWith("reloc.");

interface Leb {
  readonly value: number;
  readonly next: number;
}

/** Read an unsigned LEB128 u32 within 5 bytes; null on truncation or overflow. */
const readU32Leb = (bytes: Buffer, offset: number): Leb | null => {
  let result = 0;
  let shift = 0;
  let index = offset;
  for (let part = 0; part < 5; part += 1) {
    if (index >= bytes.length) return null;
    const byte = bytes[index]!;
    index += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (result > 0xffffffff) return null;
      return { value: result, next: index };
    }
    shift += 7;
  }
  return null;
};

/** Read a custom section's name (LEB-prefixed) from its payload; null if malformed. */
const readCustomName = (
  bytes: Buffer,
  payloadStart: number,
  payloadEnd: number,
): { readonly name: string; readonly contentStart: number } | null => {
  const header = readU32Leb(bytes, payloadStart);
  if (header === null) return null;
  const nameEnd = header.next + header.value;
  if (nameEnd > payloadEnd) return null;
  return {
    name: bytes.toString("utf8", header.next, nameEnd),
    contentStart: nameEnd,
  };
};

const recognizes = (bytes: Buffer): boolean =>
  bytes.length >= 8 &&
  bytes.subarray(0, 4).equals(WASM_MAGIC) &&
  bytes.readUInt32LE(4) === 1;

const coreSectionFact = (
  id: number,
  payloadStart: number,
  size: number,
): CanonicalizeFact => ({
  collection: "wasm-section",
  name: CORE_SECTION_NAMES[id] ?? `section-${String(id)}`,
  classification: "behavior-relevant",
  bytes: size,
  location: { offset: payloadStart, bytes: size },
  sha256: null,
  sample: null,
  detail:
    CORE_SECTION_NAMES[id] === undefined
      ? "Unknown core section id; retained as behavior-relevant."
      : null,
});

/** Classify one custom section as link-relevant core or non-semantic padding. */
const customSectionFact = (
  bytes: Buffer,
  payloadStart: number,
  payloadEnd: number,
  size: number,
  budget: NormalizerBudget,
): CanonicalizeFact => {
  const parsed = readCustomName(bytes, payloadStart, payloadEnd);
  const name = parsed?.name ?? null;
  const region = bytes.subarray(payloadStart, payloadEnd);
  if (name !== null && isLinkRelevantCustom(name))
    return {
      collection: "wasm-custom-section",
      name,
      classification: "behavior-relevant",
      bytes: size,
      location: { offset: payloadStart, bytes: size },
      sha256: canonicalizeDigest(region),
      sample: null,
      detail: "Link-relevant custom section retained.",
    };
  return {
    collection: "wasm-custom-section",
    name,
    classification: "non-semantic-padding",
    bytes: size,
    location: { offset: payloadStart, bytes: size },
    sha256: canonicalizeDigest(region),
    sample: canonicalizeSample(
      bytes.subarray(parsed?.contentStart ?? payloadStart, payloadEnd),
      budget.sampleUnits,
    ),
    detail:
      name === null
        ? "Custom section with an unreadable name; non-semantic to execution."
        : "Custom section; non-semantic to WASM execution.",
  };
};

const canonicalize = (
  bytes: Buffer,
  budget: NormalizerBudget,
): NormalizedArtifactFacts => {
  const core: CanonicalizeFact[] = [];
  const collapsed: CanonicalizeFact[] = [];
  const limitations: string[] = [];
  let customExamined = 0;
  let customRetained = 0;
  let customCollapsedBytes = 0;
  let sectionsExamined = 0;
  let truncated = false;

  if (!recognizes(bytes)) {
    return {
      detected_format: "wasm",
      normalizer: "wasm-sections",
      core,
      collapsed,
      reductions: [],
      coverage: {
        status: "partial",
        examined: 0,
        total: null,
        truncated: false,
      },
      limitations: [
        "Selected bytes are not a WASM v1 module (magic or version mismatch); structure unverified.",
      ],
    };
  }

  let offset = 8;
  while (offset < bytes.length) {
    if (sectionsExamined >= MAX_SECTIONS) {
      truncated = true;
      limitations.push(
        `Stopped after ${String(MAX_SECTIONS)} sections; the remaining bytes are unverified.`,
      );
      break;
    }
    const id = bytes[offset]!;
    const size = readU32Leb(bytes, offset + 1);
    if (size === null) {
      truncated = true;
      limitations.push(
        `Malformed section length at byte ${String(offset)}; the remaining bytes are unverified.`,
      );
      break;
    }
    const payloadStart = size.next;
    const payloadEnd = payloadStart + size.value;
    if (payloadEnd > bytes.length) {
      truncated = true;
      limitations.push(
        `Truncated section at byte ${String(offset)} declares ${String(size.value)} payload bytes beyond the artifact; unverified.`,
      );
      break;
    }
    sectionsExamined += 1;

    if (id !== 0) {
      core.push(coreSectionFact(id, payloadStart, size.value));
    } else {
      customExamined += 1;
      const fact = customSectionFact(
        bytes,
        payloadStart,
        payloadEnd,
        size.value,
        budget,
      );
      if (fact.classification === "behavior-relevant") core.push(fact);
      else if (customRetained < budget.maxFacts) {
        customRetained += 1;
        collapsed.push(fact);
      } else customCollapsedBytes += size.value;
    }
    offset = payloadEnd;
  }

  const reductions: CanonicalizeReduction[] = [];
  const customBeyondBudget = customExamined - customRetained;
  if (customExamined > customRetained) {
    reductions.push({
      collection: "wasm-custom-section",
      examined: customExamined,
      retained: customRetained,
      collapsed: customExamined - customRetained,
      collapsed_bytes: customCollapsedBytes,
      basis:
        "Custom sections beyond the exemplar budget were counted, not retained; they are non-semantic to execution.",
    });
  }
  if (customBeyondBudget > 0)
    limitations.push(
      `${String(customBeyondBudget)} further custom sections were collapsed to counts; raise max_facts to retain more exemplars.`,
    );

  return {
    detected_format: "wasm",
    normalizer: "wasm-sections",
    core,
    collapsed,
    reductions,
    coverage: {
      status: truncated ? "partial" : "complete",
      examined: sectionsExamined,
      total: truncated ? null : sectionsExamined,
      truncated,
    },
    limitations,
  };
};

/** Canonicalize WASM by separating behavior-relevant core/link sections from non-semantic custom padding. */
export const wasmSectionNormalizer: ArtifactNormalizer = {
  id: "wasm-sections",
  format: "wasm",
  recognizes,
  canonicalize,
};
