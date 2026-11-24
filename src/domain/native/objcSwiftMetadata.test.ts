import { describe, expect, it } from "vitest";

import {
  inspectNativeDispatchMetadata,
  swiftConformanceSchema,
} from "./objcSwiftMetadata.js";

describe("symbol-only Objective-C implementation identity", () => {
  it.each([" ", "  ", "\t"])(
    "separates category ownership with separator %j",
    (separator) => {
      const metadata = inspectNativeDispatchMetadata(
        [
          {
            address: "0x1000",
            name: `-[StoreController(Actions)${separator}buildTapped:]`,
          },
        ],
        1,
      );
      expect(metadata.objc_dispatch_implementations).toMatchObject([
        {
          class_name: "StoreController",
          category: "Actions",
          selector: "buildTapped:",
        },
      ]);
    },
  );

  it("parses symbol category ownership once and retains the original symbol evidence", () => {
    const names = [
      "-[StoreController(Actions) buildTapped:]",
      "-[StoreController(OtherActions) buildTapped:]",
    ];
    const result = inspectNativeDispatchMetadata(
      names.map((name) => ({ address: "0x1000", name })),
      2,
    );
    expect(result.objc_classes.map(({ name }) => name)).toEqual([
      "StoreController",
    ]);
    expect(result.objc_dispatch_implementations).toMatchObject([
      {
        class_name: "StoreController",
        category: "Actions",
        decode: { status: "partial", reason: "symbol_name_only" },
        evidence: [{ description: `Provider symbol ${names[0]}` }],
      },
      {
        class_name: "StoreController",
        category: "OtherActions",
        evidence: [{ description: `Provider symbol ${names[1]}` }],
      },
    ]);
  });

  it("retains an owner outside the category-symbol grammar without guessing a category", () => {
    const result = inspectNativeDispatchMetadata(
      [{ address: "0x1000", name: "-[StoreController(A)(B) buildTapped:]" }],
      1,
    );
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      class_name: "StoreController(A)(B)",
    });
    expect(result.objc_dispatch_implementations[0]).not.toHaveProperty(
      "category",
    );
  });

  it("orders distinct category identities independently of provider inventory order", () => {
    const names = [
      "-[StoreController(Actions) buildTapped:]",
      "-[StoreController(OtherActions) buildTapped:]",
    ];
    const inspect = (ordered: string[]) =>
      inspectNativeDispatchMetadata(
        ordered.map((name) => ({ address: "0x1000", name })),
        ordered.length,
      );
    const forward = inspect(names);
    const reverse = inspect([...names].reverse());
    expect(reverse).toEqual(forward);
    expect(
      reverse.objc_dispatch_implementations.map(({ category }) => category),
    ).toEqual(["Actions", "OtherActions"]);
    expect(
      reverse.objc_dispatch_implementations.map(({ evidence }) =>
        evidence.map(({ description }) => description),
      ),
    ).toEqual(names.map((name) => [`Provider symbol ${name}`]));
  });
});

describe("symbol-only Objective-C implementation addresses", () => {
  it.each([
    { source: "0X00002000", canonical: "0x2000", numeric: 8192 },
    {
      source: "0x1fffffffffffff",
      canonical: "0x1fffffffffffff",
      numeric: Number.MAX_SAFE_INTEGER,
    },
    {
      source: "0x20000000000000",
      canonical: "0x20000000000000",
      numeric: null,
    },
    { source: "ram:0x2000", canonical: "ram:0x2000", numeric: null },
    { source: "rom:0x2000", canonical: "rom:0x2000", numeric: null },
  ])(
    "preserves $source without inventing a numeric method identity",
    ({ source, canonical, numeric }) => {
      const result = inspectNativeDispatchMetadata(
        [{ address: source, name: "-[StoreController buildTapped:]" }],
        1,
      );
      expect(result.objc_classes[0]?.methods[0]?.address).toBe(numeric);
      expect(result.objc_dispatch_implementations[0]).toMatchObject({
        implementation_address: canonical,
        location: { address: canonical },
        evidence: [{ location: { address: source } }],
      });
    },
  );

  it("retains unparseable symbol coordinates as reported evidence, without claiming a location", () => {
    const source = "invalid::0x2000";
    const result = inspectNativeDispatchMetadata(
      [
        { address: source, name: "-[StoreController buildTapped:]" },
        { address: source, name: "$s5Store7launchyyF" },
      ],
      2,
    );
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      implementation_address: null,
      location: { address: null },
      evidence: [{ location: { address: null }, reported_address: source }],
    });
    expect(result.swift_symbols[0]).toMatchObject({
      address: null,
      evidence: [{ location: { address: null }, reported_address: source }],
    });
  });

  it("merges equivalent method coordinates and retains every source spelling", () => {
    const addresses = ["0x2000", "0X002000"];
    for (const ordered of [addresses, [...addresses].reverse()]) {
      const result = inspectNativeDispatchMetadata(
        ordered.map((address) => ({
          address,
          name: "-[StoreController buildTapped:]",
        })),
        ordered.length,
      );
      expect(result.objc_dispatch_implementations).toHaveLength(1);
      expect(result.objc_dispatch_implementations[0]).toMatchObject({
        implementation_address: "0x2000",
        location: { address: "0x2000" },
      });
      expect(
        result.objc_dispatch_implementations[0]?.evidence.map(
          ({ location }) => location.address,
        ),
      ).toEqual(ordered);
      expect(result.objc_classes[0]?.methods).toMatchObject([
        { selector: "buildTapped:", address: 8192 },
      ]);
    }
  });

  it.each([
    ["0x2000", "0x3000"],
    ["ram:0x2000", "rom:0x2000"],
    ["", "0x2000"],
    ["unresolved", "unresolved"],
  ])(
    "retains distinct or unknown implementation identities: %j and %j",
    (left, right) => {
      const result = inspectNativeDispatchMetadata(
        [left, right].map((address) => ({
          address,
          name: "-[StoreController buildTapped:]",
        })),
        2,
      );
      expect(result.objc_dispatch_implementations).toHaveLength(2);
      expect(result.objc_classes[0]?.methods).toEqual([
        {
          selector: "buildTapped:",
          method_type: "instance",
          address: null,
          is_required: null,
          is_optional: null,
        },
      ]);
    },
  );
});

describe("ObjC/Swift metadata", () => {
  it("bounds symbol projections and labels symbol-only metadata as partial", () => {
    const result = inspectNativeDispatchMetadata(
      [
        { address: "ram:0x1000", name: "OBJC_CLASS_$_StoreController" },
        { address: "ram:0x2000", name: "-[StoreController buildTapped:]" },
        { address: "ram:0x3000", name: "$s5Store7launchyyF" },
      ],
      2,
    );
    expect(result.objc_classes).toHaveLength(1);
    expect(result.objc_dispatch_implementations).toHaveLength(1);
    expect(result.objc_classes[0]).toMatchObject({
      is_meta_class: null,
      is_root_class: null,
      ivar_count: null,
    });
    expect(result.objc_classes[0]?.methods[0]).toMatchObject({
      is_required: null,
      is_optional: null,
    });
    expect(result.swift_symbols).toHaveLength(0);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        facet: "objc_class_symbols",
        status: "partial",
        reason: expect.stringContaining("record_limit_reached"),
      }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        facet: "swift_dispatch_tables",
        status: "unsupported",
      }),
    );
  });

  it("projects every accepted Swift symbol spelling and counts it", () => {
    const names = [
      "$s5Store7launchyyF",
      "_$s5Store7launchyyF",
      "$S5Store7launchyyF",
      "_$S5Store7launchyyF",
      "_T05Store7launchyyF",
      "__T05Store7launchyyF",
      "@__swiftmacro_5Store7launchfMf_",
      "$e5Store7launchyyF",
      "_$e5Store7launchyyF",
      "_TtC5Store11StoreHandle",
      "_Tprintf",
    ];
    const result = inspectNativeDispatchMetadata(
      names.map((name, index) => ({
        address: `ram:0x${(0x1000 + index * 0x100).toString(16)}`,
        name,
      })),
      names.length,
    );

    expect(result.swift_symbols.map((entry) => entry.mangled_name)).toEqual(
      names.slice(0, -1),
    );
    expect(
      result.swift_symbols.every((entry) => entry.decode.status === "partial"),
    ).toBe(true);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        facet: "swift_declarations",
        examined: 10,
        decoded: 0,
      }),
    );
  });

  it("retains unlocated Swift and Objective-C symbols with explicit unknown addresses and source evidence", () => {
    const result = inspectNativeDispatchMetadata(
      [
        { name: "$s4Test7MyClassC", address: "" },
        { name: "-[StoreController buildTapped:]", address: "" },
        { name: "$s5Store7launchyyF", address: "ram:0x3000" },
      ],
      3,
    );
    expect(result.swift_symbols).toMatchObject([
      {
        mangled_name: "$s4Test7MyClassC",
        address: null,
        evidence: [{ location: { address: null }, reported_address: "" }],
      },
      { mangled_name: "$s5Store7launchyyF", address: "ram:0x3000" },
    ]);
    expect(result.swift_symbols[1]?.evidence[0]).not.toHaveProperty(
      "reported_address",
    );
    expect(result.objc_dispatch_implementations).toMatchObject([
      {
        class_name: "StoreController",
        implementation_address: null,
        location: { address: null },
        evidence: [{ location: { address: null }, reported_address: "" }],
      },
    ]);
    expect(result.objc_classes[0]?.methods[0]).toMatchObject({
      selector: "buildTapped:",
      address: null,
    });
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        facet: "swift_declarations",
        status: "partial",
        examined: 2,
        decoded: 0,
      }),
    );
  });
});

it("derives classes only from complete class symbol leaves", () => {
  const result = inspectNativeDispatchMetadata(
    [
      "PTR__OBJC_CLASS_$_NSAlert_100028668",
      "s__OBJC_CLASS_$_NSAlert_10002ed0d",
      "s__OBJC_CLASS_$_NSAppleEventManage_10002ed23",
      "_OBJC_CLASS_$_Local",
      "/System/Library/Frameworks/AppKit::_OBJC_CLASS_$_NSAlert",
      "_OBJC_METACLASS_$_Local",
      "OwnController::viewDidLoad",
    ].map((name, index) => ({ address: `0x${String(index + 1)}`, name })),
    7,
  );
  expect(result.objc_classes.map(({ name }) => name)).toEqual([
    "Local",
    "NSAlert",
  ]);
  expect(result.coverage).toContainEqual(
    expect.objectContaining({
      facet: "objc_class_definitions",
      status: "unsupported",
      reason: expect.stringContaining("namespace_declarations"),
    }),
  );
  expect(result.coverage).toContainEqual(
    expect.objectContaining({
      facet: "objc_dispatch_implementations",
      reason: "provider_name_inventory_has_no_supported_objc_method_symbols",
    }),
  );
});

it("requires the Swift ABI type-reference kind on every conformance", () => {
  const field = swiftConformanceSchema.shape.type_reference_kind;
  expect(field.safeParse(0).success).toBe(true);
  expect(field.safeParse(undefined).success).toBe(false);
});

describe("dispatch implementation composite-key ordering parity", () => {
  it("orders quotes, backslashes, punctuation, null addresses, categories, and code points per the composite-key contract regardless of inventory order", () => {
    const entries = [
      { address: "0x1000", name: '-[Class"A sel:]' },
      { address: "0x1000", name: "-[Class!A sel:]" },
      { address: "0x1000", name: "-[ClassA(Cat) sel:]" },
      { address: "0x1000", name: "-[ClassA sel:]" },
      { address: "0x2000", name: "-[ClassA sel:]" },
      { address: "", name: "-[ClassA sel:]" },
      { address: "0x1000", name: "-[Class\\A sel:]" },
      { address: "0x1000", name: "+[ClassA sel:]" },
      { address: "0x1000", name: "-[ClassA alt:]" },
      { address: "0x1000", name: "-[Class\uE000 sel:]" },
      { address: "0x1000", name: "-[Class\u{10000} sel:]" },
    ];
    // Canonical order of compositeKey([class_name, selector, method_type, implementation_address ?? "", category ?? null])
    // under compareUnicodeCodePoints:
    // - "!" (0x21) precedes "A" (0x41)
    // - selector "alt:" precedes "sel:"; method_type "class" precedes "instance"
    // - missing address normalizes to "" (closing quote 0x22 < "0" 0x30)
    // - quoted category "\"Cat\"" (0x22) precedes null (0x6e "n") at the same address
    // - JSON escapes "\"" -> "\\\"" (0x5c, 0x22) and "\\" -> "\\\\" (0x5c, 0x5c), placing both after "A" (0x41)
    // - BMP U+E000 precedes supplementary U+10000 (not UTF-16 lead surrogate 0xD800)
    const expected = [
      ["Class!A", "sel:", "instance", "0x1000", null],
      ["ClassA", "alt:", "instance", "0x1000", null],
      ["ClassA", "sel:", "class", "0x1000", null],
      ["ClassA", "sel:", "instance", null, null],
      ["ClassA", "sel:", "instance", "0x1000", "Cat"],
      ["ClassA", "sel:", "instance", "0x1000", null],
      ["ClassA", "sel:", "instance", "0x2000", null],
      ['Class"A', "sel:", "instance", "0x1000", null],
      ["Class\\A", "sel:", "instance", "0x1000", null],
      ["Class\uE000", "sel:", "instance", "0x1000", null],
      ["Class\u{10000}", "sel:", "instance", "0x1000", null],
    ];
    const project = (
      metadata: ReturnType<typeof inspectNativeDispatchMetadata>,
    ) =>
      metadata.objc_dispatch_implementations.map(
        ({
          class_name,
          selector,
          method_type,
          implementation_address,
          category,
        }) => [
          class_name,
          selector,
          method_type,
          implementation_address,
          category ?? null,
        ],
      );
    const forward = inspectNativeDispatchMetadata(entries, entries.length);
    const reversed = inspectNativeDispatchMetadata(
      [...entries].reverse(),
      entries.length,
    );
    expect(project(forward)).toEqual(expected);
    expect(project(reversed)).toEqual(expected);
  });
});
