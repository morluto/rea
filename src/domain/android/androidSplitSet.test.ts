import { describe, expect, it } from "vitest";

import type { AndroidManifestFacts } from "./androidManifestFacts.js";
import {
  checkAndroidSplitSet,
  type SplitSetMemberInput,
} from "./androidSplitSet.js";

const facts = (
  overrides: Partial<AndroidManifestFacts>,
): AndroidManifestFacts => ({
  package: "dev.rea.fixture",
  version_code: 7,
  version_code_major: null,
  version_name: null,
  split: null,
  config_for_split: null,
  is_feature_split: null,
  isolated_splits: null,
  target_sandbox_version: null,
  is_split_required: null,
  min_sdk_version: null,
  target_sdk_version: null,
  unresolved_attributes: [],
  ...overrides,
});
const read = (
  id: string,
  overrides: Partial<AndroidManifestFacts>,
): SplitSetMemberInput => ({
  id,
  manifest: { state: "read", facts: facts(overrides) },
});

const good: SplitSetMemberInput[] = [
  read("base", {}),
  read("arm64", { split: "config.arm64_v8a" }),
  read("feature", { split: "feature_x", is_feature_split: true }),
  read("feature-xxhdpi", {
    split: "config.xxhdpi",
    config_for_split: "feature_x",
  }),
];

describe("checkAndroidSplitSet", () => {
  it("reports a coherent set as complete with manifest-based roles", () => {
    const report = checkAndroidSplitSet(good);
    expect(report.coverage).toBe("complete");
    expect(report.package_agreement.status).toBe("consistent");
    expect(report.version_code_agreement.status).toBe("consistent");
    expect(report.base_member_count).toBe(1);
    expect(report.members.map((member) => member.role.kind)).toEqual([
      "base",
      "config",
      "feature",
      "config",
    ]);
    expect(report.missing_parents).toEqual([]);
    expect(report.duplicate_split_names).toEqual([]);
  });

  it("echoes input order but yields identical findings for any order", () => {
    const forward = checkAndroidSplitSet(good);
    const reversed = checkAndroidSplitSet([...good].reverse());
    expect(reversed.members.map((member) => member.id)).toEqual(
      forward.members.map((member) => member.id).reverse(),
    );
    const { members: _a, ...forwardFindings } = forward;
    const { members: _b, ...reversedFindings } = reversed;
    expect(reversedFindings).toEqual(forwardFindings);
  });

  it("flags a version code disagreement with the members behind each value", () => {
    const report = checkAndroidSplitSet([
      read("base", { version_code: 8 }),
      read("arm64", { split: "config.arm64_v8a" }),
    ]);
    expect(report.version_code_agreement.status).toBe("inconsistent");
    expect(report.version_code_agreement.values).toEqual([
      { value: "7", members: ["arm64"] },
      { value: "8", members: ["base"] },
    ]);
  });

  it("flags duplicate split names", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      read("a", { split: "config.en" }),
      read("b", { split: "config.en" }),
    ]);
    expect(report.duplicate_split_names).toEqual([
      { split: "config.en", members: ["a", "b"] },
    ]);
  });

  it("flags a missing parent and makes coverage partial with the reason", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      read("orphan", {
        split: "config.fr",
        config_for_split: "feature_missing",
      }),
    ]);
    expect(report.missing_parents).toEqual([
      { member: "orphan", configures: "feature_missing" },
    ]);
    expect(report.coverage).toBe("partial");
    expect(report.coverage_reasons.join(" ")).toContain("feature_missing");
  });

  it("keeps an established disagreement visible when another member is unreadable", () => {
    const report = checkAndroidSplitSet([
      read("base", { version_code: 8 }),
      read("arm64", { split: "config.arm64_v8a" }),
      {
        id: "broken",
        manifest: { state: "unreadable", reason: "truncated ZIP" },
      },
    ]);
    expect(report.version_code_agreement.status).toBe("inconsistent");
    expect(report.coverage).toBe("partial");
    expect(report.members.find((m) => m.id === "broken")?.role).toEqual({
      kind: "unknown",
      basis: "unreadable",
    });
  });

  it("treats agreement as unknown, not consistent, when a member is unreadable", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      { id: "broken", manifest: { state: "unreadable", reason: "x" } },
    ]);
    expect(report.package_agreement.status).toBe("unknown");
  });

  it("reports an empty selection as partial with unknown agreement", () => {
    const report = checkAndroidSplitSet([]);
    expect(report.coverage).toBe("partial");
    expect(report.package_agreement.status).toBe("unknown");
    expect(report.version_code_agreement.status).toBe("unknown");
  });

  it("does not claim agreement when no member declares the value", () => {
    const report = checkAndroidSplitSet([
      read("base", { package: null, version_code: null }),
    ]);
    expect(report.package_agreement.status).toBe("unknown");
    expect(report.version_code_agreement.status).toBe("unknown");
  });

  it("makes coverage partial when more than one member has no split attribute", () => {
    const report = checkAndroidSplitSet([read("a", {}), read("b", {})]);
    expect(report.base_member_count).toBe(2);
    expect(report.coverage).toBe("partial");
    expect(report.coverage_reasons.join(" ")).toContain("one base");
  });

  it("treats a differing versionCodeMajor as a version disagreement", () => {
    const report = checkAndroidSplitSet([
      read("base", { version_code: 7, version_code_major: 1 }),
      read("arm64", { split: "config.arm64_v8a", version_code: 7 }),
    ]);
    expect(report.version_code_agreement.status).toBe("inconsistent");
    expect(
      report.version_code_agreement.values.map((v) => v.value).sort(),
    ).toEqual(["4294967303", "7"]);
  });

  it("derives a config role from the platform default when isFeatureSplit is undeclared", () => {
    const report = checkAndroidSplitSet([
      read("undeclared", { split: "config.en" }),
      read("declared", { split: "config.fr", is_feature_split: false }),
    ]);
    expect(report.members.map((member) => member.role)).toEqual([
      {
        kind: "config",
        basis: "manifest_default",
        for_split: null,
        for_split_unresolved: false,
      },
      {
        kind: "config",
        basis: "manifest",
        for_split: null,
        for_split_unresolved: false,
      },
    ]);
  });
});

describe("checkAndroidSplitSet (unresolved attributes)", () => {
  it("does not read an unresolved split as a base", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      read("unresolved", {
        split: null,
        unresolved_attributes: ["manifest@split"],
      }),
    ]);
    expect(report.members.find((m) => m.id === "unresolved")?.role).toEqual({
      kind: "unknown",
      basis: "unresolved",
    });
    expect(report.base_member_count).toBe(1);
    expect(report.coverage).toBe("partial");
    expect(report.coverage_reasons.join(" ")).toContain(
      "could not be resolved",
    );
  });

  it("does not read an unresolved isFeatureSplit as not-a-feature", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      read("flag", {
        split: "config.en",
        unresolved_attributes: ["manifest@isFeatureSplit"],
      }),
    ]);
    expect(report.members[1]?.role).toEqual({
      kind: "unknown",
      basis: "unresolved",
    });
  });

  it("keeps an unresolved configForSplit distinct from configuring the base", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      read("cfg", {
        split: "config.en",
        is_feature_split: false,
        unresolved_attributes: ["manifest@configForSplit"],
      }),
    ]);
    expect(report.members[1]?.role).toEqual({
      kind: "config",
      basis: "manifest",
      for_split: null,
      for_split_unresolved: true,
    });
    expect(report.missing_parents).toEqual([]);
    expect(report.coverage).toBe("partial");
  });
});

describe("checkAndroidSplitSet (review follow-ups)", () => {
  it("does not read an unresolved versionCodeMajor as zero", () => {
    const report = checkAndroidSplitSet([
      read("base", {
        version_code: 7,
        unresolved_attributes: ["manifest@versionCodeMajor"],
      }),
      read("arm64", { split: "config.arm64_v8a", version_code: 7 }),
    ]);
    expect(report.version_code_agreement.status).toBe("unknown");
    expect(report.version_code_agreement.values).toContainEqual({
      value: null,
      members: ["base"],
    });
  });

  it("keeps a known major distinct from an unresolved one", () => {
    const report = checkAndroidSplitSet([
      read("base", {
        version_code: 7,
        version_code_major: 1,
      }),
      read("arm64", {
        split: "config.arm64_v8a",
        version_code: 7,
        unresolved_attributes: ["manifest@versionCodeMajor"],
      }),
    ]);
    expect(report.version_code_agreement.status).not.toBe("consistent");
  });

  it("does not report a parent as missing when a selected manifest is unreadable", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      { id: "feature", manifest: { state: "unreadable", reason: "truncated" } },
      read("feature-fr", { split: "config.fr", config_for_split: "feature_x" }),
    ]);
    expect(report.missing_parents).toEqual([]);
    expect(report.unresolved_parent_lookups).toEqual([
      { member: "feature-fr", configures: "feature_x" },
    ]);
    expect(report.coverage).toBe("partial");
  });

  it("does not report a parent as missing when a selected split name is unresolved", () => {
    const report = checkAndroidSplitSet([
      read("base", {}),
      read("feature", {
        split: null,
        is_feature_split: true,
        unresolved_attributes: ["manifest@split"],
      }),
      read("feature-fr", { split: "config.fr", config_for_split: "feature_x" }),
    ]);
    expect(report.missing_parents).toEqual([]);
    expect(report.unresolved_parent_lookups).toEqual([
      { member: "feature-fr", configures: "feature_x" },
    ]);
  });

  it("orders coverage reasons independently of input order", () => {
    const members: SplitSetMemberInput[] = [
      read("base", {}),
      { id: "b", manifest: { state: "unreadable", reason: "truncated" } },
      { id: "a", manifest: { state: "unreadable", reason: "not a manifest" } },
    ];
    const forward = checkAndroidSplitSet(members);
    const reversed = checkAndroidSplitSet([...members].reverse());
    expect(forward.coverage_reasons.length).toBeGreaterThan(1);
    expect(reversed.coverage_reasons).toEqual(forward.coverage_reasons);
  });
});
