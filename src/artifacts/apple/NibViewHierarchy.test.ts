import { describe, expect, it } from "vitest";

import { projectNibViewHierarchy } from "./NibViewHierarchy.js";
import { InterfaceBuilderDecodeBudget } from "./InterfaceBuilderDecodeBudget.js";

// Use the same budget and diagnostic accounting as Interface Builder's NIB owner.
const projectFixture = (
  objects: Parameters<typeof projectNibViewHierarchy>[0],
  retainedIds: ReadonlySet<number>,
  expectedDiagnostics: readonly string[] = [],
  maximumBytes = 4_000_000,
) => {
  const budget = new InterfaceBuilderDecodeBudget(maximumBytes);
  const diagnostics: string[] = [];
  const projection = projectNibViewHierarchy(
    objects,
    retainedIds,
    () => budget.tryReserve(128),
    20_000,
    (description) => {
      budget.reserve(
        256,
        "NIB registry hierarchy diagnostics exceed the aggregate Interface Builder decode budget",
      );
      budget.reserveJsonStringOccurrence(description);
      diagnostics.push(description);
    },
  );
  expect(diagnostics).toEqual(expectedDiagnostics);
  return projection;
};

const object = (id: number, parent?: number) => ({
  id,
  class_name: "NSView",
  values:
    parent === undefined ? {} : { NSSuperview: { $nib_object_ref: parent } },
});

describe("serialized NIB view hierarchy bounds", () => {
  it("does not invent hierarchy for objects without serialized relationships", () => {
    expect(projectFixture([object(0)], new Set([0]))).toEqual({
      hierarchy: null,
      omitted: 0,
    });
  });

  it("uses the serialized parent direction and retains all sibling links", () => {
    expect(
      projectFixture(
        [object(0), object(1, 0), object(2, 0)],
        new Set([0, 1, 2]),
      ),
    ).toEqual({
      hierarchy: [
        {
          objectID: "0",
          children: [
            { objectID: "1", children: [] },
            { objectID: "2", children: [] },
          ],
        },
      ],
      omitted: 0,
    });
  });

  it("reports missing parents without inventing parentage", () => {
    expect(projectFixture([object(0, 99)], new Set([0]))).toEqual({
      hierarchy: [],
      omitted: 1,
    });
  });

  it("reports a missing encoded window content view as incomplete", () => {
    expect(
      projectFixture(
        [
          {
            id: 0,
            class_name: "NSWindowTemplate",
            values: { NSWindowView: { $nib_object_ref: 99 } },
          },
        ],
        new Set([0]),
      ),
    ).toEqual({ hierarchy: [{ objectID: "0", children: [] }], omitted: 1 });
  });

  it("marks unsupported serialized parent values as incomplete", () => {
    expect(
      projectFixture(
        [{ id: 0, class_name: "NSView", values: { NSSuperview: "unknown" } }],
        new Set([0]),
      ),
    ).toEqual({ hierarchy: null, omitted: 1 });
  });

  it("reports cyclic and self-referential parentage as incomplete", () => {
    expect(
      projectFixture(
        [object(0, 1), object(1, 0), object(2, 2)],
        new Set([0, 1, 2]),
      ),
    ).toEqual({
      hierarchy: [],
      omitted: 3,
    });
  });

  it("does not project children whose parent was not retained", () => {
    expect(projectFixture([object(0), object(1, 0)], new Set([1]))).toEqual({
      hierarchy: [],
      omitted: 1,
    });
  });

  it("reports nodes beyond the depth bound instead of claiming complete coverage", () => {
    const objects = Array.from({ length: 132 }, (_, id) =>
      object(id, id === 0 ? undefined : id - 1),
    );
    expect(
      projectFixture(objects, new Set(objects.map(({ id }) => id))).omitted,
    ).toBe(3);
  });

  it("reports nodes beyond the record bound", () => {
    const objects = Array.from({ length: 20_002 }, (_, id) =>
      object(id, id === 0 ? undefined : 0),
    );
    expect(
      projectFixture(objects, new Set(objects.map(({ id }) => id))).omitted,
    ).toBe(2);
  });

  it("reports nodes the shared representation budget cannot reserve", () => {
    const objects = [object(0), object(1, 0)];
    expect(projectFixture(objects, new Set([0, 1]), [], 128)).toEqual({
      hierarchy: [{ objectID: "0", children: [] }],
      omitted: 1,
    });
  });
});

it("does not treat a dangling registry owner as top-level authority", () => {
  const result = projectFixture(
    [
      {
        id: 0,
        class_name: "NSIBObjectData",
        values: {
          NSRoot: { $nib_object_ref: 99 },
          NSObjectsKeys: { $nib_object_ref: 2 },
          NSObjectsValues: { $nib_object_ref: 3 },
        },
      },
      object(1),
      {
        id: 2,
        class_name: "NSArray",
        values: { "NS.objects": { $nib_object_ref: 1 } },
      },
      {
        id: 3,
        class_name: "NSArray",
        values: { "NS.objects": { $nib_object_ref: 99 } },
      },
    ],
    new Set([1]),
    [
      "NSIBObjectData object 0: NSObjectsKeys/NSObjectsValues pair child 1 with registry value 99; NSRoot is 99 (unresolved). This decoded registry association does not establish visual parentage.",
    ],
  );
  expect(result.hierarchy).toEqual([]);
  expect(result.omitted).toBeGreaterThan(0);
});
