import { describe, expect, it } from "vitest";

import {
  selectObjcClassCandidates,
  projectObjcClassCandidates,
} from "./symbolAnalysis.js";

const completeCoverage = { status: "complete" as const, reason: null };
const classImport = {
  requested_address: "0x1000",
  symbol: "_OBJC_CLASS_$_Document",
  binding_source: "bind" as const,
  library_ordinal: 1,
  library: "/System/Library/Frameworks/AppKit.framework/AppKit",
  weak: false,
  addend: "0",
};

describe("Objective-C class label discovery", () => {
  it("uses provider-tagged stripped class labels and filters their exact text", () => {
    const labels = [
      "__objc_class_HuntRoot_class",
      "__objc_class_HuntSub_class",
      "__objc_class_HuntWorker_class",
      "__objc_class_HuntModel_class",
      "__objc_class_HuntLegacy_class",
      "__objc_class_Hunt_class_class",
      "prefix__objc_class_HuntForeign_class",
      "__objc_class__class",
      "__objc_class_HuntMissingSuffix",
      "__objc_class_HuntExtra_class_suffix",
    ];
    const names = labels.map((name, index) => ({
      address: `0x${(index + 1).toString(16)}`,
      name,
      ...(index < 6
        ? { objc_class_label: "hopper_legacy_class_object" as const }
        : {}),
    }));

    const [root, ...siblings] = names;
    const sameName = { ...root!, address: "0x40", name: labels[0]! };
    const unowned = { address: "0x41", name: labels[0]! };
    const inventory = [root!, unowned, sameName, root!, ...siblings];
    expect(selectObjcClassCandidates(inventory, "Hunt")).toEqual([
      root,
      sameName,
      ...siblings.slice(0, 5),
    ]);
    expect(selectObjcClassCandidates(inventory, labels[0]!)).toEqual([
      root,
      sameName,
    ]);
  });

  it("keeps group order while selecting the first proven canonical row", () => {
    const alias = { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" };
    const plain = { address: "0x2000", name: "OBJC_CLASS_$_Document" };
    const canonical = { address: "0x1008", name: "OBJC_CLASS_$_Document" };
    const laterCanonical = { ...canonical, address: "0x1010" };
    const canonicalImport = {
      ...classImport,
      requested_address: canonical.address,
    };
    const scan = {
      bindings: [
        canonicalImport,
        classImport,
        { ...classImport, requested_address: laterCanonical.address },
        canonicalImport,
      ],
      coverage: completeCoverage,
    };
    expect(
      projectObjcClassCandidates(
        [alias, plain, canonical, laterCanonical],
        scan,
      ),
    ).toEqual({
      count: 2,
      classes: [
        {
          ...canonical,
          binding_identity: {
            symbol: classImport.symbol,
            binding_source: classImport.binding_source,
            library_ordinal: classImport.library_ordinal,
            library: classImport.library,
            weak: false,
            addend: "0",
            slot_addresses: [
              canonical.address,
              alias.address,
              laterCanonical.address,
            ],
          },
        },
        plain,
      ],
      identity_coverage: completeCoverage,
    });

    const secondAlias = { ...canonical, name: "OBJC_CLASS_$_Document$ptr" };
    expect(
      projectObjcClassCandidates([alias, secondAlias], {
        ...scan,
        bindings: [canonicalImport, classImport],
      }),
    ).toMatchObject({ count: 1, classes: [alias] });
  });
});

it.each([
  ["library_ordinal", -1, -2],
  ["binding_source", "bind", "weak"],
] as const)("keeps equal symbols separate across %s", (field, left, right) => {
  const rows = [
    { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" },
    { address: "0x2000", name: "OBJC_CLASS_$_Document$GOT" },
  ];
  const binding = { ...classImport, library_ordinal: 0, library: null };
  expect(
    projectObjcClassCandidates(rows, {
      bindings: [
        { ...binding, [field]: left },
        { ...binding, [field]: right, requested_address: "0x2000" },
      ],
      coverage: completeCoverage,
    }),
  ).toMatchObject({
    count: 2,
    classes: [
      {
        ...rows[0],
        binding_identity: { [field]: left, slot_addresses: ["0x1000"] },
      },
      {
        ...rows[1],
        binding_identity: { [field]: right, slot_addresses: ["0x2000"] },
      },
    ],
  });
});

it("excludes pointer and string labels that only contain a class marker", () => {
  const result = selectObjcClassCandidates(
    [
      { address: "0x1", name: "PTR__OBJC_CLASS_$_NSAlert_100028668" },
      { address: "0x2", name: "s__OBJC_CLASS_$_NSAlert_10002ed0d" },
      { address: "0x3", name: "AppKit::_OBJC_CLASS_$_NSAlert" },
    ],
    "",
  );
  expect(result).toEqual([
    { address: "0x3", name: "AppKit::_OBJC_CLASS_$_NSAlert" },
  ]);
});
