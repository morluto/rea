import { diffLines } from "diff";

import { digestCanonicalValue } from "./canonicalDigest.js";
import {
  createFunctionAddressProjection,
  hasFunctionBodyExtent,
  type AddressProjection,
} from "./functionComparisonAddressProjection.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import {
  createTextAddressLocator,
  parseAddress,
  transformProviderText,
} from "./functionComparisonTextParsing.js";
import type {
  FunctionNormalizedViews,
  MaskingCounts,
  NormalizedTextView,
  NormalizedViewDimension,
} from "./functionComparisonSchemas.js";
import { NORMALIZED_VIEW_DIMENSIONS } from "./functionComparisonSchemas.js";
import { functionFacetLimitations } from "./functionComparisonDimensions.js";

/** Masking policy identifier reported with every normalized view. */
const POLICY = "rea-address-normalized-text-v1";

/**
 * Recognized address-derived identifier forms of the supported providers.
 *
 * A label matches only when its suffix is fully hexadecimal and the whole token
 * ends there, so `sub_deallocate` and a named symbol such as `__RTC_CheckEsp`
 * never match. Matching is form-based; masking additionally requires that this
 * dossier corroborates the embedded address and does not report the name as a
 * named symbol.
 */
const NORMALIZABLE_ADDRESS_TOKEN =
  /(?<![0-9A-Za-z_])(?:(?<label>(?:thunk_|flt_)?(?:FUN|SUB|DAT|LAB|PTR|UNK|SwitchD|Join)_|(?:sub|loc|off|unk|nullsub)_|(?:fcn|sub|loc|off|data)\.)(?<identifier_prefix>0x)?(?<identifier_address>[0-9a-f]{4,})(?![0-9A-Za-z_])|(?<address>0x[0-9a-f]+))/giu;

/** Declared masking rules, reported verbatim so every view can be audited. */
const RULES = [
  {
    rule: "address_derived_identifier",
    description:
      "Recognized provider address-derived identifiers whose embedded address this dossier corroborates are replaced by provider-label-preserving ordinals; identifiers inside strings and comments, and names the dossier reports with a named symbol origin, stay visible. Function-local labels retain their explicit entry-relative offset.",
  },
  {
    rule: "function_relative_address",
    description:
      "Observed instruction locations and control-flow targets inside the function body are emitted as their exact offset from the function entry. Offsets are never collapsed into ordinals, and unrelated numeric constants stay visible.",
  },
  {
    rule: "corroborated_external_address",
    description:
      "External numeric operands are masked only when a call target is corroborated by the callee dossier or a unique operand matches an observed source-to-target reference at that instruction. Other numeric constants stay visible.",
  },
] as const;

const SHARED_LIMITATIONS = [
  "Normalized views compare provider text after declared address masking. Equal normalized views do not establish that both sides reference the same procedure, data, label, or layout; the exact pseudocode, assembly, calls, references, and CFG dimensions keep their own meanings and statuses.",
  "Ordinal placeholders are assigned independently by first appearance on each side. A normalized unchanged status means only that projected text is equal; it does not prove stable target identity or call order.",
] as const;

/**
 * Project one side's provider text into the address-normalized comparison space.
 *
 * Ordinals are deterministic but side-local. Equality means only that the text
 * matches after this projection; masked target identities and call order are
 * not established by ordinal tokens. Counts report occurrences, not addresses.
 */
const normalizeText = (
  text: string,
  projection: AddressProjection,
  dimension: NormalizedViewDimension,
): {
  readonly text: string;
  readonly counts: MaskingCounts;
  readonly maskedComparedCallee: boolean;
  readonly maskedUncomparedCallee: boolean;
} | null => {
  const identifiers = new Map<string, number>();
  const addresses = new Map<string, number>();
  let maskedIdentifiers = 0;
  let unmaskedIdentifiers = 0;
  let maskedAddresses = 0;
  let visibleAddresses = 0;
  let maskedComparedCallee = false;
  let maskedUncomparedCallee = false;
  // The exact calls dimension can settle only the callees it compares.
  const noteMaskedCallee = (address: bigint | null) => {
    if (address === null || !projection.isCalleeAddress(address)) return;
    if (projection.isComparedCalleeAddress(address))
      maskedComparedCallee = true;
    else maskedUncomparedCallee = true;
  };
  const addressLocation = createTextAddressLocator(
    text,
    dimension === "assembly_normalized",
  );
  const normalized = transformProviderText(
    text,
    dimension === "assembly_normalized",
    (code, codeStart) => {
      let output = "";
      let cursor = 0;
      for (const token of code.matchAll(NORMALIZABLE_ADDRESS_TOKEN)) {
        const match = token[0];
        const index = token.index;
        const groups = token.groups;
        if (match === undefined || index === undefined || groups === undefined)
          continue;
        output += code.slice(cursor, index);
        const isIdentifier = groups.label !== undefined;
        const addressText = isIdentifier
          ? `${groups.identifier_prefix ?? "0x"}${groups.identifier_address ?? ""}`
          : (groups.address ?? match);
        const address = parseAddress(addressText.toLowerCase());
        const mask =
          address === null
            ? null
            : isIdentifier
              ? projection.maskIdentifier(address, { code, index, match })
              : projection.maskTextAddress(
                  address,
                  addressLocation(codeStart + index),
                );
        if (mask === null) {
          if (isIdentifier) unmaskedIdentifiers += 1;
          else visibleAddresses += 1;
          output += match;
        } else if (isIdentifier) {
          noteMaskedCallee(address);
          maskedIdentifiers += 1;
          output +=
            mask.kind === "relative"
              ? `${groups.label}${mask.value}`
              : `${groups.label}<sym:${ordinal(identifiers, mask.value)}>`;
        } else {
          noteMaskedCallee(address);
          maskedAddresses += 1;
          output +=
            mask.kind === "relative"
              ? mask.value
              : `<addr:${ordinal(addresses, mask.value)}>`;
        }
        cursor = index + match.length;
      }
      return output + code.slice(cursor);
    },
  );
  if (normalized === null) return null;
  return {
    text: normalized,
    maskedComparedCallee,
    maskedUncomparedCallee,
    counts: {
      address_derived_identifiers: maskedIdentifiers,
      unmasked_address_derived_identifiers: unmaskedIdentifiers,
      corroborated_addresses: maskedAddresses,
      visible_addresses: visibleAddresses,
    },
  };
};

const ordinal = (ordinals: Map<string, number>, key: string): number => {
  const existing = ordinals.get(key);
  if (existing !== undefined) return existing;
  const next = ordinals.size + 1;
  ordinals.set(key, next);
  return next;
};

const unknownView = (
  dimension: NormalizedViewDimension,
  links: readonly string[],
  limitations: readonly string[],
): NormalizedTextView => ({
  dimension,
  status: "unknown",
  left_digest: null,
  right_digest: null,
  left_count: null,
  right_count: null,
  text_delta: null,
  evidence_links: [...links],
  masking: null,
  limitations: [...limitations],
  conclusion_kind: "unresolved_branch",
});

/**
 * Build the opt-in normalized views for one function pair.
 *
 * Nothing here can change the eight exact dimensions, their statuses, the
 * summary counts, or the overall comparison status. Each view is labelled, cites
 * both Evidence records, and declares the masking rules it applied.
 */
export const normalizedViews = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  options: {
    readonly links: readonly string[];
    readonly providersDiffer: boolean;
    readonly callsStatus: "unchanged" | "changed" | "unknown";
  },
): FunctionNormalizedViews => {
  const { links, providersDiffer } = options;
  const shared = [...SHARED_LIMITATIONS];
  if (providersDiffer) {
    const limitation =
      "Normalized text comparison requires one provider identity.";
    return {
      policy: POLICY,
      views: NORMALIZED_VIEW_DIMENSIONS.map((dimension) =>
        unknownView(dimension, links, [...shared, limitation]),
      ),
      limitations: [...shared, limitation],
    };
  }
  const relativeOffsets =
    hasFunctionBodyExtent(left) && hasFunctionBodyExtent(right);
  const limitations = relativeOffsets
    ? shared
    : [
        ...shared,
        "One dossier did not observe its own function body extent, so corroborated addresses on both sides were masked as ordinal placeholders instead of entry-relative offsets.",
      ];
  const leftProjection = createFunctionAddressProjection(left, relativeOffsets);
  const rightProjection = createFunctionAddressProjection(
    right,
    relativeOffsets,
  );
  return {
    policy: POLICY,
    views: NORMALIZED_VIEW_DIMENSIONS.map((dimension) => {
      const facetLimitations = [
        ...functionFacetLimitations(
          left,
          dimension === "pseudocode_normalized" ? "pseudocode" : "assembly",
        ).map((reason) => `Left: ${reason}`),
        ...functionFacetLimitations(
          right,
          dimension === "pseudocode_normalized" ? "pseudocode" : "assembly",
        ).map((reason) => `Right: ${reason}`),
      ];
      if (facetLimitations.length > 0)
        return unknownView(dimension, links, [
          ...limitations,
          ...facetLimitations,
        ]);
      const leftText = normalizeText(
        viewText(left, dimension),
        leftProjection,
        dimension,
      );
      const rightText = normalizeText(
        viewText(right, dimension),
        rightProjection,
        dimension,
      );
      if (leftText === null || rightText === null) {
        const failed = [
          ...(leftText === null ? ["Left"] : []),
          ...(rightText === null ? ["Right"] : []),
        ].join(" and ");
        return unknownView(dimension, links, [
          ...limitations,
          `${failed} provider text contains an unsupported raw string or an unterminated string, character literal, or block comment, so normalization was skipped.`,
        ]);
      }
      const masking: NonNullable<NormalizedTextView["masking"]> = {
        policy: POLICY,
        provider_id: left.evidence.provider.id,
        rules: RULES.map((rule) => ({ ...rule })),
        left: leftText.counts,
        right: rightText.counts,
      };
      const projected = {
        dimension,
        left_digest: digest(leftText.text),
        right_digest: digest(rightText.text),
        left_count: [...leftText.text].length,
        right_count: [...rightText.text].length,
        evidence_links: [...links],
        masking,
      };
      // Both projections completed, so an unresolved comparison keeps their facts.
      const unresolved = (reason: string): NormalizedTextView => ({
        ...projected,
        status: "unknown",
        text_delta: null,
        limitations: [...limitations, reason],
        conclusion_kind: "unresolved_branch",
      });
      const changes = diffLines(leftText.text, rightText.text, {
        timeout: 100,
        maxEditLength: 10_000,
      });
      if (changes === undefined)
        return unresolved(
          "Bounded line diff exceeded its time or edit-distance limit.",
        );
      const delta = changes.reduce(
        (summary, change) => ({
          added_lines:
            summary.added_lines + (change.added ? (change.count ?? 0) : 0),
          removed_lines:
            summary.removed_lines + (change.removed ? (change.count ?? 0) : 0),
          hunks: summary.hunks + (change.added || change.removed ? 1 : 0),
        }),
        { added_lines: 0, removed_lines: 0, hunks: 0 },
      );
      if (
        delta.hunks === 0 &&
        (leftText.maskedUncomparedCallee || rightText.maskedUncomparedCallee)
      )
        return unresolved(
          "Masked text references a call, tail-jump or thunk target that the exact calls dimension does not compare; normalized equality cannot establish callee identity or call order.",
        );
      if (
        delta.hunks === 0 &&
        options.callsStatus === "unknown" &&
        (leftText.maskedComparedCallee || rightText.maskedComparedCallee)
      )
        return unresolved(
          "Masked text references a dossier-listed callee or thunk target while the exact calls dimension is unknown; normalized equality cannot establish callee identity or call order.",
        );
      return {
        ...projected,
        status: delta.hunks === 0 ? "unchanged" : "changed",
        text_delta: delta,
        limitations: [...limitations],
        conclusion_kind: "derived_relationship",
      } satisfies NormalizedTextView;
    }),
    limitations: [...limitations],
  };
};

const viewText = (
  snapshot: FunctionSnapshot,
  dimension: NormalizedViewDimension,
): string =>
  dimension === "pseudocode_normalized"
    ? snapshot.dossier.pseudocode
    : snapshot.dossier.assembly.join("\n");

const digest = (value: string): string =>
  digestCanonicalValue(value, "Function normalized text view");
