import { describe, expect, it } from "vitest";

import { inspectNativeDispatchMetadata } from "./objcSwiftMetadata.js";

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
});
