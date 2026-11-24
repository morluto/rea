import { describe, expect, it } from "vitest";

import {
  categorizeSwiftTypes,
  discoverObjcProtocols,
} from "./symbolAnalysis.js";

describe("modern Swift category evidence", () => {
  it.each([
    ["$s4main7ServiceCMa", "classes"],
    ["$s4main5StateOMa", "enums"],
    ["$s4main7ScoringPMp", "protocols"],
    ["$s4main5OuterV5InnerCMa", "classes"],
    ["$s4main4PairV5otherE7doubledSiyF", "extensions"],
    ["$S4main4PairVMa", "structs"],
    ["_T04main4PairVMa", "structs"],
    ["__T04main4PairVMa", "structs"],
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

  it("keeps undecoded substituted extension contexts unclassified", () => {
    const names = [
      "_$s1M7WrapperVAASQRzlE4sameySbxF",
      "_$s1M3BoxVAARi_zrlE1vxvM",
    ];
    const result = categorizeSwiftTypes(
      names.map((name, index) => ({ address: String(index), name })),
    );
    expect(result.categories).toMatchObject({
      structs: { count: 0 },
      other: { count: 2 },
    });
    expect(result.unclassified.map(({ name }) => name)).toEqual(names);
    const controls = [
      ["_$s1M7WrapperV1vxvg", "structs"],
      ["_$s1M7WrapperVMa", "structs"],
      ["_$s1M7WrapperVACyxGxcfC", "structs"],
      ["_$s10Foundation4DataV1ME10countTwiceSiyF", "extensions"],
    ] as const;
    for (const [name, category] of controls)
      expect(
        categorizeSwiftTypes([{ address: "0x1", name }]).categories,
      ).toMatchObject({ [category]: { count: 1 } });
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

describe("file-private Swift nominals", () => {
  it("classifies a private nested type by the kind after its discriminator", () => {
    const discriminator = "33_06D5FEE0226E625B433890B34489ED31LL";
    const names = [
      [`_$s4main8EnvelopeV5State${discriminator}O8describeSSyF`, "enums"],
      [`_$s4main7ServiceC4Item${discriminator}V6methodyyF`, "structs"],
      [`_$s4main5ColorO3Box${discriminator}CMa`, "classes"],
      [`_$s4main8EnvelopeV8describe${discriminator}SSyF`, "structs"],
      ["_$s4main7ServiceC5State6NestedLLVMa", "classes"],
    ] as const;
    for (const [name, category] of names) {
      expect(
        categorizeSwiftTypes([{ address: "0x1", name }], { category }),
      ).toMatchObject({
        total: 1,
        categories: { [category]: { count: 1 } },
        unclassified: [],
      });
    }
    expect(
      categorizeSwiftTypes(
        [
          {
            address: "0x1",
            name: `_$s4main8EnvelopeV5State${discriminator}O8describeSSyF`,
          },
        ],
        { category: "structs" },
      ),
    ).toMatchObject({
      total: 0,
      categories: { structs: { count: 0 }, enums: { count: 0 } },
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
          { address: "0x1", name: "$s4main5StateOMa" },
        ],
      ),
    ).toMatchObject({
      total: 0,
      unclassified: [
        {
          name: "shared",
          reason: "conflicting_categories",
          mangled_names: [
            "$s4main4PairVMa",
            "$s4main7ServiceCMa",
            "$s4main5StateOMa",
          ],
        },
      ],
    });
  });

  it("retains manglings whose prefix the demangler accepts", () => {
    const names = [
      "$e4main7ServiceCMa",
      "_$e4main7ServiceCMa",
      "@__swiftmacro_4main7ServiceCMa",
    ];
    const result = categorizeSwiftTypes(
      names.map((name, index) => ({ address: `0x${String(index)}`, name })),
    );
    expect(result.categories.other?.items.map((item) => item.name)).toEqual(
      names,
    );
    expect(result.unclassified.map((item) => item.name)).toEqual(names);
  });

  it("retains decoded and undecoded aliases when the filter matches only a mangled name", () => {
    const exact = "_$s4main7ServiceCMa";
    const demanglerOnly = "$e4main7ServiceCMa";
    const unresolved = ["_$s4main04PairVMa", demanglerOnly];
    const result = categorizeSwiftTypes(
      [
        { address: "0x2", name: exact },
        { address: "0x1", name: "renamedInitializer" },
      ],
      { category: "classes", pattern: "Service" },
      [
        ...[exact, ...unresolved, exact].map((name) => ({
          address: "0x1",
          name,
        })),
        { address: "0x2", name: demanglerOnly },
      ],
    );
    expect(result).toMatchObject({
      total: 2,
      categories: {
        classes: {
          count: 2,
          items: [
            {
              address: "0x2",
              name: exact,
              mangled_names: [exact, demanglerOnly],
            },
            {
              address: "0x1",
              name: "renamedInitializer",
              mangled_names: [exact, ...unresolved],
            },
          ],
        },
        other: { count: 0 },
      },
      unclassified: [],
    });
  });
});

it("does not recognize embedded Swift runtime markers in Objective-C selectors", () => {
  const names = [
    "-[Example check_TtC4main3Foo]",
    "-[Example check_TtP4main3Bar_]",
  ].map((name) => ({ name, address: "0x1" }));
  expect(categorizeSwiftTypes(names)).toMatchObject({
    total: 0,
    unclassified: [],
  });
  expect(discoverObjcProtocols(names)).toEqual({ count: 0, protocols: [] });
});

it("distinguishes protocol identity from protocol member contexts", () => {
  const symbols = [
    "_$s4main7ScoringMp",
    "$s4main7ScoringPMp",
    "_TtP4main7Scoring_",
    "_$s4main7ScoringP5scoreSiyFTq",
    "_$s4main7ScoringTL",
    "_$s4main7ScoringP5scoreSiyF",
  ].map((name, index) => ({ name, address: `0x${index}` }));
  expect(discoverObjcProtocols(symbols)).toEqual({
    count: 3,
    protocols: symbols.slice(0, 3),
  });
  // Function/requirement categorization still describes the enclosing nominal
  // context; it does not turn that member into a protocol inventory identity.
  expect(
    categorizeSwiftTypes([
      { address: "0x3", name: "_$s4main7ScoringP5scoreSiyFTq" },
    ]),
  ).toMatchObject({
    categories: { protocols: { count: 1 } },
    unclassified: [],
  });
});

it("selects exact Objective-C protocol symbol leaves", () => {
  const declarations = [
    "OBJC_PROTOCOL_$_Runnable",
    "_OBJC_PROTOCOL_$_Runnable",
    "__OBJC_PROTOCOL_$_Runnable",
    "Framework::__OBJC_PROTOCOL_$_Runnable",
  ].map((name, index) => ({ address: `0x${index}`, name }));
  const otherNames = [
    "s__OBJC_PROTOCOL_$_Runnable_1000",
    "PTR__OBJC_PROTOCOL_$_Runnable_1000",
    "-[Example useOBJC_PROTOCOL_$_Runnable]",
    "__OBJC_PROTOCOL_REFERENCE_$_Runnable",
    "__OBJC_PROTOCOL_$_",
  ].map((name, index) => ({ address: `0x${index + 4}`, name }));
  const duplicate = { address: "0x20", name: "OBJC_PROTOCOL_$_Runnable" };
  expect(
    discoverObjcProtocols([...otherNames, ...declarations, duplicate]),
  ).toEqual({
    count: declarations.length,
    protocols: declarations,
  });
});
