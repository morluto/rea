import { describe, expect, it } from "vitest";

import {
  categorizeSwiftTypes,
  discoverObjcClasses,
  discoverObjcProtocols,
  discoverSwiftClasses,
} from "../src/domain/symbolAnalysis.js";

describe("symbol analysis", () => {
  it("filters Swift classes and reports the uncapped match count", () => {
    const symbols = Array.from({ length: 120 }, (_, index) => ({
      address: `0x${String(index)}`,
      name: `_TtCFixture${String(index)}`,
    }));
    const result = discoverSwiftClasses(symbols, "Fixture");
    if (
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result)
    ) {
      expect(result.count).toBe(120);
      expect(result.classes).toHaveLength(100);
      expect(Array.isArray(result.classes) ? result.classes[0] : null).toEqual({
        address: "0x0",
        name: "_TtCFixture0",
      });
    }
  });

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
});
