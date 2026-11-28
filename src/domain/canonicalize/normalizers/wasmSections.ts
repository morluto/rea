import { createHash } from "node:crypto";

import { readLeb128, ULEB32 } from "../../leb128.js";
import { isStrictUtf8, strictUtf8Decoder } from "../../strictUtf8.js";
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
/** WASM core version 1, little-endian. Matched as a fixed signature, not read. */
const WASM_VERSION_1 = Buffer.from([0x01, 0x00, 0x00, 0x00]);
/** Defensive ceiling so a malformed length field cannot spin the walk. */
const MAX_SECTIONS = 1_000_000;
/**
 * Maximum custom-section name bytes decoded and retained. A section name is
 * artifact-controlled and can span megabytes; classification needs only a
 * bounded prefix, and the stored name must not reproduce an inflated name.
 */
const MAX_CUSTOM_NAME_BYTES = 128;

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

interface CustomName {
  /** Bounded, decoded name prefix retained in the fact; "" when unreadable. */
  readonly name: string;
  /** Full declared name length in bytes, even when only a prefix was decoded. */
  readonly nameBytes: number;
  /** True when the declared name exceeds the retained prefix. */
  readonly truncated: boolean;
  /** False when the name bytes are not valid UTF-8; the name is then unverified. */
  readonly readable: boolean;
  readonly contentStart: number;
}

/**
 * Decode a bounded name prefix as strict UTF-8. A WASM section name is a raw
 * byte vector, not guaranteed UTF-8, so a lossy decode would invent a plausible
 * name (U+FFFD) for malformed bytes and hide the unreadable identity. When the
 * full name fits the budget, any malformed byte makes the name unreadable. When
 * the name is truncated at the byte budget, decode in stream mode so a multibyte
 * sequence legitimately cut at the boundary is tolerated while genuinely
 * malformed bytes still fail. Returns null when the bytes are not valid UTF-8.
 */
const decodeNamePrefix = (slice: Buffer, truncated: boolean): string | null => {
  if (!truncated) return isStrictUtf8(slice) ? slice.toString("utf8") : null;
  try {
    // A truncated prefix may end mid-sequence; a stream decode tolerates only a
    // trailing incomplete sequence while still failing on malformed bytes. This
    // needs its own decoder instance, which strictUtf8Decoder returns per call.
    // "preserve" keeps ignoreBOM, so a leading BOM in the name is not dropped.
    return strictUtf8Decoder("preserve").decode(slice, { stream: true });
  } catch {
    return null;
  }
};

/** Read a custom section's name (LEB-prefixed), decoding only a bounded prefix. */
const readCustomName = (
  bytes: Buffer,
  payloadStart: number,
  payloadEnd: number,
): CustomName | null => {
  // Reuse the shared LEB128 owner for the name-length prefix, bounded to this
  // section's payload as the enclosing range rather than rescanning bytes.
  const header = readLeb128(bytes, payloadStart, payloadEnd, ULEB32);
  if ("failure" in header) return null;
  const nameBytes = Number(header.value);
  const nameEnd = header.next + nameBytes;
  if (nameEnd > payloadEnd) return null;
  const truncated = nameBytes > MAX_CUSTOM_NAME_BYTES;
  const decodeEnd = Math.min(nameEnd, header.next + MAX_CUSTOM_NAME_BYTES);
  const decoded = decodeNamePrefix(
    bytes.subarray(header.next, decodeEnd),
    truncated,
  );
  return {
    name: decoded ?? "",
    nameBytes,
    truncated,
    readable: decoded !== null,
    contentStart: nameEnd,
  };
};

/** A name is link-relevant when it is an exact known name or a `reloc.` prefix. */
const isLinkRelevant = (parsed: CustomName): boolean =>
  parsed.name.startsWith("reloc.") ||
  (!parsed.truncated && LINK_RELEVANT_CUSTOM.has(parsed.name));

const recognizes = (bytes: Buffer): boolean =>
  bytes.length >= 8 &&
  bytes.subarray(0, 4).equals(WASM_MAGIC) &&
  bytes.subarray(4, 8).equals(WASM_VERSION_1);

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

/** A retained link-relevant custom section, kept as behavior-relevant. */
const linkSectionFact = (
  parsed: CustomName,
  payloadStart: number,
  size: number,
  region: Buffer,
): CanonicalizeFact => ({
  collection: "wasm-custom-section",
  name: parsed.name,
  classification: "behavior-relevant",
  bytes: size,
  location: { offset: payloadStart, bytes: size },
  sha256: canonicalizeDigest(region),
  sample: null,
  detail: parsed.truncated
    ? `Link-relevant custom section retained; declared name is ${String(parsed.nameBytes)} bytes, truncated to ${String(MAX_CUSTOM_NAME_BYTES)}.`
    : "Link-relevant custom section retained.",
});

/** A retained padding exemplar: a custom section non-semantic to execution. */
const paddingSectionFact = (
  bytes: Buffer,
  parsed: CustomName | null,
  payloadStart: number,
  payloadEnd: number,
  size: number,
  region: Buffer,
  budget: NormalizerBudget,
): CanonicalizeFact => ({
  collection: "wasm-custom-section",
  name: parsed?.name ?? null,
  classification: "non-semantic-padding",
  bytes: size,
  location: { offset: payloadStart, bytes: size },
  sha256: canonicalizeDigest(region),
  sample: canonicalizeSample(
    bytes.subarray(parsed?.contentStart ?? payloadStart, payloadEnd),
    budget.sampleUnits,
  ),
  detail:
    parsed === null
      ? "Custom section with an unreadable name; non-semantic to execution."
      : parsed.truncated
        ? `Custom section; non-semantic to WASM execution. Declared name is ${String(parsed.nameBytes)} bytes, truncated to ${String(MAX_CUSTOM_NAME_BYTES)}.`
        : "Custom section; non-semantic to WASM execution.",
});

/** A custom section whose name-length field could not be read; left unverified. */
const malformedSectionFact = (
  payloadStart: number,
  size: number,
  region: Buffer,
): CanonicalizeFact => ({
  collection: "wasm-custom-section",
  name: null,
  classification: "unverified",
  bytes: size,
  location: { offset: payloadStart, bytes: size },
  sha256: canonicalizeDigest(region),
  sample: null,
  detail:
    "Custom section with an unreadable name-length field; its content is unverified.",
});

/** A custom section whose name bytes are not valid UTF-8; its identity is unverified. */
const invalidNameSectionFact = (
  payloadStart: number,
  nameBytes: number,
  size: number,
  region: Buffer,
): CanonicalizeFact => ({
  collection: "wasm-custom-section",
  name: null,
  classification: "unverified",
  bytes: size,
  location: { offset: payloadStart, bytes: size },
  sha256: canonicalizeDigest(region),
  sample: null,
  detail: `Custom section name (${String(nameBytes)} declared bytes) is not valid UTF-8; its identity is unverified.`,
});

/** A bounded group accumulator: retained count, overflow count, bytes and digest. */
interface CustomGroup {
  retained: number;
  examined: number;
  overflow: number;
  overflowBytes: number;
  readonly digest: ReturnType<typeof createHash>;
}

const newGroup = (): CustomGroup => ({
  retained: 0,
  examined: 0,
  overflow: 0,
  overflowBytes: 0,
  digest: createHash("sha256"),
});

/** Record one group member beyond the exemplar budget, by reference only. */
const collapseIntoGroup = (
  group: CustomGroup,
  size: number,
  region: Buffer,
): void => {
  group.overflow += 1;
  group.overflowBytes += size;
  // Fold the member's own digest into the group digest so the omitted group
  // keeps a bounded identity without retaining its bytes.
  group.digest.update(canonicalizeDigest(region));
};

const groupReduction = (
  collection: string,
  group: CustomGroup,
  basis: string,
): CanonicalizeReduction => ({
  collection,
  examined: group.examined,
  retained: group.retained,
  collapsed: group.overflow,
  collapsed_bytes: group.overflowBytes,
  group_sha256: group.overflow > 0 ? group.digest.digest("hex") : null,
  basis,
});

const canonicalize = (
  bytes: Buffer,
  budget: NormalizerBudget,
): NormalizedArtifactFacts => {
  const core: CanonicalizeFact[] = [];
  const collapsed: CanonicalizeFact[] = [];
  const limitations: string[] = [];
  const coreSections = newGroup();
  const malformed = newGroup();
  const invalidName = newGroup();
  const padding = newGroup();
  const link = newGroup();
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
    // The section-length field reuses the shared LEB128 owner; the module end is
    // its enclosing range. The width and overflow checks live in that owner.
    const size = readLeb128(bytes, offset + 1, bytes.length, ULEB32);
    if ("failure" in size) {
      truncated = true;
      limitations.push(
        `Malformed section length at byte ${String(offset)}; the remaining bytes are unverified.`,
      );
      break;
    }
    const payloadStart = size.next;
    const sectionSize = Number(size.value);
    const payloadEnd = payloadStart + sectionSize;
    if (payloadEnd > bytes.length) {
      truncated = true;
      limitations.push(
        `Truncated section at byte ${String(offset)} declares ${String(sectionSize)} payload bytes beyond the artifact; unverified.`,
      );
      break;
    }
    sectionsExamined += 1;
    const region = bytes.subarray(payloadStart, payloadEnd);

    if (id !== 0) {
      // A well-formed module carries at most one of each core section, but a
      // crafted module can repeat a core id up to a million times. Bound core
      // retention like the custom groups so the fact set cannot grow with the
      // attacker's input; the overflow keeps a group digest, not its bytes.
      coreSections.examined += 1;
      if (coreSections.retained < budget.maxFacts) {
        coreSections.retained += 1;
        core.push(coreSectionFact(id, payloadStart, sectionSize));
      } else collapseIntoGroup(coreSections, sectionSize, region);
      offset = payloadEnd;
      continue;
    }

    const parsed = readCustomName(bytes, payloadStart, payloadEnd);
    if (parsed === null) {
      // An unreadable name-length field is a malformed section, not padding:
      // keep it unverified with partial coverage. Bound retention like the other
      // groups so the overflow keeps a group digest rather than losing identity.
      malformed.examined += 1;
      if (malformed.retained < budget.maxFacts) {
        malformed.retained += 1;
        collapsed.push(malformedSectionFact(payloadStart, sectionSize, region));
      } else collapseIntoGroup(malformed, sectionSize, region);
      offset = payloadEnd;
      continue;
    }
    if (!parsed.readable) {
      // The name-length field read, but the name bytes are not valid UTF-8. A
      // lossy decode would invent a plausible name and hide the lost identity,
      // so retain the section as unverified with partial coverage. Bound
      // retention like the other groups so overflow keeps a group digest.
      invalidName.examined += 1;
      if (invalidName.retained < budget.maxFacts) {
        invalidName.retained += 1;
        collapsed.push(
          invalidNameSectionFact(
            payloadStart,
            parsed.nameBytes,
            sectionSize,
            region,
          ),
        );
      } else collapseIntoGroup(invalidName, sectionSize, region);
      offset = payloadEnd;
      continue;
    }
    if (isLinkRelevant(parsed)) {
      link.examined += 1;
      if (link.retained < budget.maxFacts) {
        link.retained += 1;
        core.push(linkSectionFact(parsed, payloadStart, sectionSize, region));
      } else collapseIntoGroup(link, sectionSize, region);
    } else {
      padding.examined += 1;
      if (padding.retained < budget.maxFacts) {
        padding.retained += 1;
        collapsed.push(
          paddingSectionFact(
            bytes,
            parsed,
            payloadStart,
            payloadEnd,
            sectionSize,
            region,
            budget,
          ),
        );
      } else collapseIntoGroup(padding, sectionSize, region);
    }
    offset = payloadEnd;
  }

  const reductions: CanonicalizeReduction[] = [];
  if (coreSections.overflow > 0) {
    reductions.push(
      groupReduction(
        "wasm-section",
        coreSections,
        "Core sections beyond the exemplar budget were counted with a group digest, not retained; a well-formed module carries at most one of each.",
      ),
    );
    limitations.push(
      `${String(coreSections.overflow)} further core sections were collapsed to counts; raise max_facts to retain more exemplars.`,
    );
  }
  if (padding.overflow > 0) {
    reductions.push(
      groupReduction(
        "wasm-custom-section",
        padding,
        "Custom sections beyond the exemplar budget were counted with a group digest, not retained; they are non-semantic to execution.",
      ),
    );
    limitations.push(
      `${String(padding.overflow)} further custom sections were collapsed to counts; raise max_facts to retain more exemplars.`,
    );
  }
  if (link.overflow > 0) {
    reductions.push(
      groupReduction(
        "wasm-link-section",
        link,
        "Link-relevant custom sections beyond the exemplar budget were counted with a group digest; raise max_facts to retain more.",
      ),
    );
    limitations.push(
      `${String(link.overflow)} further link-relevant custom sections were collapsed to counts; raise max_facts to retain more exemplars.`,
    );
  }

  if (malformed.examined > 0) {
    if (malformed.overflow > 0)
      reductions.push(
        groupReduction(
          "wasm-custom-section",
          malformed,
          "Malformed custom sections beyond the exemplar budget were counted with a group digest and left unverified; raise max_facts to retain more.",
        ),
      );
    limitations.push(
      `${String(malformed.examined)} custom sections had an unreadable name-length field and were left unverified.`,
    );
  }

  if (invalidName.examined > 0) {
    if (invalidName.overflow > 0)
      reductions.push(
        groupReduction(
          "wasm-custom-section",
          invalidName,
          "Custom sections with non-UTF-8 names beyond the exemplar budget were counted with a group digest and left unverified; raise max_facts to retain more.",
        ),
      );
    limitations.push(
      `${String(invalidName.examined)} custom sections had a name that is not valid UTF-8 and were left unverified.`,
    );
  }

  const omitted =
    coreSections.overflow > 0 ||
    padding.overflow > 0 ||
    link.overflow > 0 ||
    malformed.overflow > 0 ||
    invalidName.overflow > 0;
  return {
    detected_format: "wasm",
    normalizer: "wasm-sections",
    core,
    collapsed,
    reductions,
    coverage: {
      status:
        truncated ||
        omitted ||
        malformed.examined > 0 ||
        invalidName.examined > 0
          ? "partial"
          : "complete",
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
