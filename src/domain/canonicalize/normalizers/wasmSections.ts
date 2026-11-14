import { createHash } from "node:crypto";

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

interface CustomName {
  /** Bounded, decoded name prefix retained in the fact. */
  readonly name: string;
  /** Full declared name length in bytes, even when only a prefix was decoded. */
  readonly nameBytes: number;
  /** True when the declared name exceeds the retained prefix. */
  readonly truncated: boolean;
  readonly contentStart: number;
}

/** Read a custom section's name (LEB-prefixed), decoding only a bounded prefix. */
const readCustomName = (
  bytes: Buffer,
  payloadStart: number,
  payloadEnd: number,
): CustomName | null => {
  const header = readU32Leb(bytes, payloadStart);
  if (header === null) return null;
  const nameEnd = header.next + header.value;
  if (nameEnd > payloadEnd) return null;
  const decodeEnd = Math.min(nameEnd, header.next + MAX_CUSTOM_NAME_BYTES);
  return {
    name: bytes.toString("utf8", header.next, decodeEnd),
    nameBytes: header.value,
    truncated: header.value > MAX_CUSTOM_NAME_BYTES,
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
      offset = payloadEnd;
      continue;
    }

    const parsed = readCustomName(bytes, payloadStart, payloadEnd);
    const region = bytes.subarray(payloadStart, payloadEnd);
    if (parsed !== null && isLinkRelevant(parsed)) {
      link.examined += 1;
      if (link.retained < budget.maxFacts) {
        link.retained += 1;
        core.push(linkSectionFact(parsed, payloadStart, size.value, region));
      } else collapseIntoGroup(link, size.value, region);
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
            size.value,
            region,
            budget,
          ),
        );
      } else collapseIntoGroup(padding, size.value, region);
    }
    offset = payloadEnd;
  }

  const reductions: CanonicalizeReduction[] = [];
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

  const omitted = padding.overflow > 0 || link.overflow > 0;
  return {
    detected_format: "wasm",
    normalizer: "wasm-sections",
    core,
    collapsed,
    reductions,
    coverage: {
      status: truncated || omitted ? "partial" : "complete",
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
