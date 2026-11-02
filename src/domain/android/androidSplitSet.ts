import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { AndroidManifestFacts } from "./androidManifestFacts.js";

/** One caller-selected member and what REA could read of its manifest. */
export interface SplitSetMemberInput {
  /** Caller-chosen stable identity, such as a digest or logical name. */
  readonly id: string;
  readonly manifest:
    | { readonly state: "read"; readonly facts: AndroidManifestFacts }
    | { readonly state: "unreadable"; readonly reason: string };
}

/**
 * `manifest`: the attribute was declared. `manifest_default`: the role relies
 * on the platform default of an attribute the manifest did not declare
 * (`isFeatureSplit` defaults to false), so it is derived, not observed.
 */
export type SplitRoleBasis = "manifest" | "manifest_default";

export type SplitRole =
  | { readonly kind: "base"; readonly basis: "manifest" }
  | { readonly kind: "feature"; readonly basis: "manifest" }
  | {
      readonly kind: "config";
      readonly basis: SplitRoleBasis;
      /** `null`: configures the base; otherwise the named split. */
      readonly for_split: string | null;
      /** `configForSplit` was declared but not resolved; `for_split` is then unknown. */
      readonly for_split_unresolved: boolean;
    }
  | {
      readonly kind: "unknown";
      /**
       * `unreadable`: the manifest could not be read. `unresolved`: it was
       * read, but `split` or `isFeatureSplit` is declared and not resolved,
       * so neither "base" nor a split role is observed.
       */
      readonly basis: "unreadable" | "unresolved";
    };

/**
 * The effective version code as a decimal string: `versionCodeMajor` in the
 * high 32 bits and `versionCode` in the low 32 bits. `null` when the low part
 * is not declared, or when either part is declared but unresolved; an
 * undeclared major counts as 0.
 */
export const effectiveVersionCode = (
  facts: Pick<
    AndroidManifestFacts,
    "version_code" | "version_code_major" | "unresolved_attributes"
  >,
): string | null => {
  if (
    facts.unresolved_attributes.includes("manifest@versionCode") ||
    facts.unresolved_attributes.includes("manifest@versionCodeMajor")
  )
    return null;
  if (facts.version_code === null) return null;
  const major = BigInt((facts.version_code_major ?? 0) >>> 0);
  return ((major << 32n) | BigInt(facts.version_code >>> 0)).toString();
};

export interface Agreement<T> {
  readonly status: "consistent" | "inconsistent" | "unknown";
  readonly values: readonly {
    readonly value: T | null;
    readonly members: readonly string[];
  }[];
}

export interface SplitSetReport {
  /** Members in the order the caller supplied them. */
  readonly members: readonly {
    readonly id: string;
    readonly role: SplitRole;
    readonly split: string | null;
  }[];
  readonly package_agreement: Agreement<string>;
  /** Compares {@link effectiveVersionCode}, so a differing major is visible. */
  readonly version_code_agreement: Agreement<string>;
  readonly duplicate_split_names: readonly {
    readonly split: string;
    readonly members: readonly string[];
  }[];
  /** Parents confirmed absent: every selected manifest was read and named. */
  readonly missing_parents: readonly {
    readonly member: string;
    readonly configures: string;
  }[];
  /**
   * Parents that are not among the known split names, but whose absence cannot
   * be confirmed because a selected member is unreadable or has an unresolved
   * `split`.
   */
  readonly unresolved_parent_lookups: readonly {
    readonly member: string;
    readonly configures: string;
  }[];
  readonly base_member_count: number;
  readonly coverage: "complete" | "partial";
  /** Why coverage is partial; empty when complete. */
  readonly coverage_reasons: readonly string[];
}

const roleOf = (facts: AndroidManifestFacts): SplitRole => {
  const unresolved = facts.unresolved_attributes;
  // An undeclared attribute is an observation; a declared-but-unresolved one
  // is not, so it must not be read as "no split" or "not a feature split".
  if (
    unresolved.includes("manifest@split") ||
    unresolved.includes("manifest@isFeatureSplit")
  )
    return { kind: "unknown", basis: "unresolved" };
  if (facts.is_feature_split === true)
    return { kind: "feature", basis: "manifest" };
  if (facts.split === null) return { kind: "base", basis: "manifest" };
  return {
    kind: "config",
    basis: facts.is_feature_split === false ? "manifest" : "manifest_default",
    for_split: facts.config_for_split,
    for_split_unresolved: unresolved.includes("manifest@configForSplit"),
  };
};

const agreement = <T extends string | number>(
  entries: readonly { id: string; value: T | null }[],
  unreadable: number,
): Agreement<T> => {
  const byValue = new Map<T | null, string[]>();
  for (const { id, value } of entries)
    byValue.set(value, [...(byValue.get(value) ?? []), id]);
  const values = [...byValue.entries()]
    .map(([value, members]) => ({ value, members: [...members].sort() }))
    .sort((left, right) =>
      compareUnicodeCodePoints(String(left.value), String(right.value)),
    );
  const declared = values.filter((entry) => entry.value !== null);
  // Disagreement among declared values is established even if other members
  // are unreadable or silent; agreement is claimed only when every selected
  // member was read and declared the same value.
  if (declared.length > 1) return { status: "inconsistent", values };
  const complete =
    declared.length === 1 &&
    unreadable === 0 &&
    !values.some((entry) => entry.value === null);
  return { status: complete ? "consistent" : "unknown", values };
};

/**
 * Check one caller-selected set of APK manifests. Pure: the result is
 * independent of input order except that `members` echoes that order.
 *
 * Coverage describes the supplied selection only. It cannot show that the
 * caller selected every APK that is installed or published.
 */
export const checkAndroidSplitSet = (
  inputs: readonly SplitSetMemberInput[],
): SplitSetReport => {
  const unreadable = inputs.filter((input) => input.manifest.state !== "read");
  const readable = inputs.flatMap((input) =>
    input.manifest.state === "read"
      ? [{ id: input.id, facts: input.manifest.facts }]
      : [],
  );

  const members = inputs.map((input) =>
    input.manifest.state === "read"
      ? {
          id: input.id,
          role: roleOf(input.manifest.facts),
          split: input.manifest.facts.split,
        }
      : {
          id: input.id,
          role: { kind: "unknown", basis: "unreadable" } as const,
          split: null,
        },
  );

  const bySplit = new Map<string, string[]>();
  for (const { id, facts } of readable)
    if (facts.split !== null)
      bySplit.set(facts.split, [...(bySplit.get(facts.split) ?? []), id]);
  const duplicate_split_names = [...bySplit.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([split, ids]) => ({ split, members: [...ids].sort() }))
    .sort((left, right) => compareUnicodeCodePoints(left.split, right.split));

  const declaredSplits = new Set(bySplit.keys());
  // Absence of a parent is confirmed only when every selected member was read
  // and its split name is known; otherwise the parent may be an unlisted one.
  const splitNamesKnown =
    unreadable.length === 0 &&
    !readable.some(({ facts }) =>
      facts.unresolved_attributes.includes("manifest@split"),
    );
  const parentless = readable
    .flatMap(({ id, facts }) =>
      facts.config_for_split !== null &&
      !declaredSplits.has(facts.config_for_split)
        ? [{ member: id, configures: facts.config_for_split }]
        : [],
    )
    .sort((left, right) => compareUnicodeCodePoints(left.member, right.member));
  const missing_parents = splitNamesKnown ? parentless : [];
  const unresolved_parent_lookups = splitNamesKnown ? [] : parentless;

  const base_member_count = members.filter(
    (member) => member.role.kind === "base",
  ).length;

  const coverage_reasons: string[] = [];
  for (const input of unreadable)
    if (input.manifest.state === "unreadable")
      coverage_reasons.push(
        `member ${input.id} is unreadable: ${input.manifest.reason}`,
      );
  if (inputs.length === 0) coverage_reasons.push("no members were supplied");
  if (inputs.length > 0 && base_member_count === 0 && unreadable.length === 0)
    coverage_reasons.push(
      "no base member (manifest without split) was supplied",
    );
  if (base_member_count > 1)
    coverage_reasons.push(
      `${base_member_count} members have no split attribute; a set has one base`,
    );
  for (const member of members) {
    if (member.role.kind === "unknown" && member.role.basis === "unresolved")
      coverage_reasons.push(
        `member ${member.id} declares a split or isFeatureSplit attribute that could not be resolved`,
      );
    if (member.role.kind === "config" && member.role.for_split_unresolved)
      coverage_reasons.push(
        `member ${member.id} declares a configForSplit that could not be resolved`,
      );
  }
  for (const missing of missing_parents)
    coverage_reasons.push(
      `member ${missing.member} configures ${missing.configures}, which is not in the supplied set`,
    );
  for (const lookup of unresolved_parent_lookups)
    coverage_reasons.push(
      `member ${lookup.member} configures ${lookup.configures}, which could not be matched because a selected member's split name is unknown`,
    );
  coverage_reasons.sort(compareUnicodeCodePoints);

  return {
    members,
    package_agreement: agreement(
      readable.map(({ id, facts }) => ({ id, value: facts.package })),
      unreadable.length,
    ),
    version_code_agreement: agreement(
      readable.map(({ id, facts }) => ({
        id,
        value: effectiveVersionCode(facts),
      })),
      unreadable.length,
    ),
    duplicate_split_names,
    missing_parents,
    unresolved_parent_lookups,
    base_member_count,
    coverage: coverage_reasons.length === 0 ? "complete" : "partial",
    coverage_reasons,
  };
};
