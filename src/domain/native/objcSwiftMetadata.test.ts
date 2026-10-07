import { fc } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  countMethodsByType,
  isDbSaveComplete,
  isGetterSelector,
  isSetterSelector,
  inspectNativeDispatchMetadata,
  propertyNameFromSelector,
  swiftDeclsByKind,
  type ObjcMethod,
  type SwiftDecl,
  type DbSaveResult,
} from "./objcSwiftMetadata.js";

describe("ObjC/Swift metadata", () => {
  it("identifies getter selectors", () => {
    expect(isGetterSelector("name")).toBe(true);
    expect(isGetterSelector("setName:")).toBe(false);
    expect(isGetterSelector("set")).toBe(true);
  });

  it("identifies setter selectors", () => {
    expect(isSetterSelector("setName:")).toBe(true);
    expect(isSetterSelector("name")).toBe(false);
  });

  it("extracts property name from selector", () => {
    expect(propertyNameFromSelector("name")).toBe("name");
    expect(propertyNameFromSelector("setName:")).toBe("name");
    expect(propertyNameFromSelector("set")).toBe("set");
  });

  it("counts methods by type", () => {
    const methods: ObjcMethod[] = [
      {
        selector: "init",
        method_type: "instance",
        address: 0x1000,
        is_required: false,
        is_optional: false,
      },
      {
        selector: "alloc",
        method_type: "class",
        address: 0x2000,
        is_required: false,
        is_optional: false,
      },
    ];
    const counts = countMethodsByType(methods);
    expect(counts.instance).toBe(1);
    expect(counts.class).toBe(1);
    expect(counts.ivar_getter).toBe(0);
    expect(counts.ivar_setter).toBe(0);
  });

  it("filters Swift declarations by kind", () => {
    const decls: SwiftDecl[] = [
      {
        kind: "class",
        name: "Foo",
        module: null,
        access_level: "public",
        super_class: null,
        protocols: [],
        is_final: false,
        is_required: false,
        is_convenience_init: false,
        is_override: false,
      },
    ];
    const classes = swiftDeclsByKind(decls, "class");
    expect(classes).toHaveLength(1);
    expect(classes[0]!.name).toBe("Foo");
  });

  it("checks database save completeness", () => {
    const result: DbSaveResult = {
      operation: "save",
      succeeded: true,
      preserved_names: 10,
      preserved_comments: 5,
      preserved_bookmarks: 3,
      database_path: "/tmp/db.hop",
      error: null,
    };
    expect(isDbSaveComplete(result, 10, 5, 3)).toBe(true);
    expect(isDbSaveComplete(result, 11, 5, 3)).toBe(false);
  });

  it("is monotone in every expected count and total at the observed count", () => {
    fc.assert(
      fc.property(
        fc.record({
          operation: fc.constantFrom(
            "save",
            "readback",
            "open_database",
            "close_database",
            "export",
            "import",
          ),
          succeeded: fc.boolean(),
          preserved_names: fc.nat({ max: 50 }),
          preserved_comments: fc.nat({ max: 50 }),
          preserved_bookmarks: fc.nat({ max: 50 }),
          database_path: fc.option(fc.string(), { nil: null }),
          error: fc.option(fc.string(), { nil: null }),
        }),
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        (result, names, comments, bookmarks) => {
          // Completeness is downward closed: if demanding more was met,
          // demanding less must also be met.
          if (isDbSaveComplete(result, names + 1, comments, bookmarks)) {
            expect(isDbSaveComplete(result, names, comments, bookmarks)).toBe(
              true,
            );
          }
          if (isDbSaveComplete(result, names, comments + 1, bookmarks)) {
            expect(isDbSaveComplete(result, names, comments, bookmarks)).toBe(
              true,
            );
          }
          if (isDbSaveComplete(result, names, comments, bookmarks + 1)) {
            expect(isDbSaveComplete(result, names, comments, bookmarks)).toBe(
              true,
            );
          }
          // Expecting exactly what was preserved is complete iff the save worked.
          expect(
            isDbSaveComplete(
              result,
              result.preserved_names,
              result.preserved_comments,
              result.preserved_bookmarks,
            ),
          ).toBe(result.succeeded);
        },
      ),
      { numRuns: 200 },
    );
  });

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
