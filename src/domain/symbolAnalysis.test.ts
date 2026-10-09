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
        other: {
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
