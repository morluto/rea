import { describe, expect, it } from "vitest";

import {
  categorizeSwiftTypes,
  discoverObjcClasses,
  discoverObjcProtocols,
} from "./symbolAnalysis.js";

describe("symbol analysis", () => {
  it("deduplicates Objective-C classes and protocols by symbol name", () => {
    const names = [
      { address: "0x1", name: "_OBJC_CLASS_$_App" },
      { address: "0x2", name: "_OBJC_CLASS_$_App" },
      { address: "0x3", name: "_OBJC_PROTOCOL_$_Delegate" },
      { address: "0x4", name: "_OBJC_PROTOCOL_$_Delegate" },
    ];
    expect(discoverObjcClasses(names, "App")).toMatchObject({ count: 1 });
    expect(discoverObjcProtocols(names)).toMatchObject({ count: 1 });
  });

  it("excludes Objective-C ivars, metaclasses, properties, and protocols from classes", () => {
    const result = discoverObjcClasses(
      [
        { address: "0x1", name: "_OBJC_IVAR_$_Fixture.value" },
        { address: "0x2", name: "_OBJC_METACLASS_$_Fixture" },
        { address: "0x3", name: "_OBJC_PROP_$_Fixture.value" },
        { address: "0x4", name: "_OBJC_PROTOCOL_$_FixtureProtocol" },
        { address: "0x5", name: "_OBJC_CLASS_$_Fixture" },
      ],
      "",
    );

    expect(result).toMatchObject({
      count: 1,
      classes: [{ address: "0x5", name: "_OBJC_CLASS_$_Fixture" }],
    });
  });

  it("distinguishes class and protocol definitions from compiler bookkeeping labels", () => {
    // Label forms emitted by Apple clang for a class and @protocol reference.
    const names = [
      { address: "0x40", name: "_OBJC_CLASS_$_Fixture" },
      { address: "0x128", name: "__OBJC_CLASS_RO_$_Fixture" },
      { address: "0x198", name: "_OBJC_CLASSLIST_REFERENCES_$_" },
      { address: "0x90", name: "l_OBJC_CLASS_NAME_" },
      { address: "0x1a0", name: "__OBJC_PROTOCOL_$_Delegate" },
      { address: "0x208", name: "__OBJC_PROTOCOL_REFERENCE_$_Delegate" },
    ];
    expect(discoverObjcClasses(names, "")).toEqual({
      count: 1,
      classes: [{ address: "0x40", name: "_OBJC_CLASS_$_Fixture" }],
    });
    expect(discoverObjcProtocols(names)).toEqual({
      count: 1,
      protocols: [{ address: "0x1a0", name: "__OBJC_PROTOCOL_$_Delegate" }],
    });
  });

  it("categorizes every Swift mangling family and deduplicates names", () => {
    const result = categorizeSwiftTypes([
      { address: "1", name: "_TtCClass" },
      { address: "2", name: "_TtVStruct" },
      { address: "3", name: "_TtOEnum" },
      { address: "4", name: "_TtPProtocol" },
      { address: "5", name: "_TtEExtension" },
      { address: "6", name: "prefix_TtOther" },
      { address: "7", name: "_TtCClass" },
    ]);
    expect(result).toMatchObject({
      total: 6,
      categories: {
        classes: { count: 1 },
        structs: { count: 1 },
        enums: { count: 1 },
        protocols: { count: 1 },
        extensions: { count: 1 },
        other: { count: 1 },
      },
    });
  });

  it("filters Swift categories by a case-sensitive literal name", () => {
    const result = categorizeSwiftTypes(
      [
        { address: "0x1", name: "_TtCAccount" },
        { address: "0x2", name: "_TtCSession" },
        { address: "0x3", name: "_TtVAccountState" },
      ],
      { category: "classes", pattern: "Account" },
    );

    expect(result).toMatchObject({
      total: 1,
      categories: {
        classes: {
          count: 1,
          items: [{ address: "0x1", name: "_TtCAccount" }],
        },
        structs: { count: 0, items: [] },
      },
    });
  });

  it("classifies modern Swift manglings reported by current providers", () => {
    const result = categorizeSwiftTypes([
      { address: "0x1000009f8", name: "$s4main4PairVMa" },
      { address: "0x100000ac4", name: "$s4main6ScorerVMa" },
      { address: "0x100000ab4", name: "_$s4main4PairVMa" },
      { address: "0x1", name: "_TtCClass" },
      { address: "0x1000009f8", name: "$s4main4PairVMa" },
    ]);

    expect(result).toMatchObject({
      total: 4,
      categories: {
        classes: { count: 1 },
        structs: {
          count: 3,
          items: [
            { address: "0x1000009f8", name: "$s4main4PairVMa" },
            { address: "0x100000ac4", name: "$s4main6ScorerVMa" },
            { address: "0x100000ab4", name: "_$s4main4PairVMa" },
          ],
        },
      },
    });
  });

  it("keeps non-Swift procedure names out of the Swift inventory", () => {
    const result = categorizeSwiftTypes([
      { address: "0x1", name: "printf" },
      { address: "0x2", name: "_OBJC_CLASS_$_App" },
      { address: "0x3", name: "std::vector<int>::push_back" },
    ]);

    expect(result).toMatchObject({ total: 0 });
  });
});

describe("modern Swift category evidence", () => {
  it.each([
    ["$s4main4PairVMa", "structs"],
    ["_$s4main6ScorerVMa", "structs"],
    ["$s4main7ServiceCMa", "classes"],
    ["$s4main5StateOMa", "enums"],
    ["$s4main7ScoringPMp", "protocols"],
    ["$s4main5OuterV5InnerCMa", "classes"],
    ["$s4main4PairV5otherE7doubledSiyF", "extensions"],
    ["$S4main4PairVMa", "structs"],
    ["_T04main4PairVMa", "structs"],
    ["$s4_TtX4PairVMa", "structs"],
  ] as const)("decodes nominal contexts for %s", (name, category) => {
    expect(
      categorizeSwiftTypes([{ address: "0x1", name }], { category }),
    ).toMatchObject({
      total: 1,
      categories: { [category]: { count: 1 } },
      unclassified: [],
    });
  });

  it("retains unresolved Swift observations under category filters", () => {
    const names = [
      "$s4main13swiftIndirectySiAA7Scoring_p_SitF",
      "$sSi4mainE7doubledSiyF",
      "$s9999999999999999999999BadVMa",
      "$s4main04PairVMa",
    ];
    const result = categorizeSwiftTypes(
      names.map((name, index) => ({ address: String(index), name })),
      { category: "structs" },
    );
    expect(result).toMatchObject({
      total: 0,
      unclassified: names.map((name) => ({
        name,
        mangled_names: [name],
        reason: "category_not_decoded",
      })),
      limitations: expect.arrayContaining([
        expect.stringContaining("could not be established"),
      ]),
    });
    expect(
      categorizeSwiftTypes([{ address: "0x1", name: names[0] ?? "" }], {
        category: "structs",
        pattern: "missing",
      }),
    ).toMatchObject({ total: 0, unclassified: [] });
  });

  it("joins Swift aliases only at the exact procedure address", () => {
    const result = categorizeSwiftTypes(
      [
        { address: "0x1", name: "main::Pair::typeMetadataAccessor" },
        { address: "0x2", name: "std::vector<int>::push_back" },
        { address: "0x3", name: "main::Pair::other" },
      ],
      { category: "structs", pattern: "Pair" },
      [
        { address: "0x1", name: "_$s4main4PairVMa" },
        { address: "0x4", name: "$s4main4PairVMa" },
      ],
    );
    expect(result).toMatchObject({
      total: 1,
      categories: {
        structs: {
          items: [
            {
              address: "0x1",
              name: "main::Pair::typeMetadataAccessor",
              mangled_names: ["_$s4main4PairVMa"],
            },
          ],
        },
      },
      unclassified: [],
    });
  });

  it("deduplicates display names after selecting a category", () => {
    expect(
      categorizeSwiftTypes(
        [
          { address: "0x1", name: "shared" },
          { address: "0x2", name: "shared" },
        ],
        { category: "structs" },
        [
          { address: "0x1", name: "$s4main7ServiceCMa" },
          { address: "0x2", name: "$s4main4PairVMa" },
        ],
      ),
    ).toMatchObject({
      total: 1,
      categories: { structs: { items: [{ address: "0x2", name: "shared" }] } },
    });
  });
});

describe("Swift alias ambiguity", () => {
  it("reports conflicting aliases rather than choosing a category", () => {
    expect(
      categorizeSwiftTypes(
        [{ address: "0x1", name: "shared" }],
        { category: "structs" },
        [
          { address: "0x1", name: "$s4main4PairVMa" },
          { address: "0x1", name: "$s4main7ServiceCMa" },
        ],
      ),
    ).toMatchObject({
      total: 0,
      unclassified: [
        {
          name: "shared",
          reason: "conflicting_categories",
          mangled_names: ["$s4main4PairVMa", "$s4main7ServiceCMa"],
        },
      ],
    });
  });
});
