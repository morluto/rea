import { describe, expect, it } from "vitest";

import {
  mergeNibHierarchies,
  projectNibViewHierarchy,
} from "./NibViewHierarchy.js";

const object = (id: number, parent?: number) => ({
  id,
  class_name: "NSView",
  values:
    parent === undefined ? {} : { NSSuperview: { $nib_object_ref: parent } },
});

describe("serialized NIB view hierarchy bounds", () => {
  it("leaves archives without superview links to the legacy projection", () => {
    expect(projectNibViewHierarchy([object(0)], new Set([0]))).toEqual({
      hierarchy: null,
      omitted: 0,
    });
  });

  it("uses the serialized parent direction and retains all sibling links", () => {
    expect(
      projectNibViewHierarchy(
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
    expect(projectNibViewHierarchy([object(0, 99)], new Set([0]))).toEqual({
      hierarchy: [],
      omitted: 1,
    });
  });

  it("reports a missing encoded window content view as incomplete", () => {
    expect(
      projectNibViewHierarchy(
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
      projectNibViewHierarchy(
        [{ id: 0, class_name: "NSView", values: { NSSuperview: "unknown" } }],
        new Set([0]),
      ),
    ).toEqual({ hierarchy: null, omitted: 1 });
  });

  it("reports cyclic and self-referential parentage as incomplete", () => {
    expect(
      projectNibViewHierarchy(
        [object(0, 1), object(1, 0), object(2, 2)],
        new Set([0, 1, 2]),
      ),
    ).toEqual({
      hierarchy: [],
      omitted: 3,
    });
  });

  it("does not project children whose parent was not retained", () => {
    expect(
      projectNibViewHierarchy([object(0), object(1, 0)], new Set([1])),
    ).toEqual({
      hierarchy: [],
      omitted: 1,
    });
  });

  it("reports nodes beyond the depth bound instead of claiming complete coverage", () => {
    const objects = Array.from({ length: 132 }, (_, id) =>
      object(id, id === 0 ? undefined : id - 1),
    );
    expect(
      projectNibViewHierarchy(objects, new Set(objects.map(({ id }) => id)))
        .omitted,
    ).toBe(3);
  });

  it("reports nodes beyond the record bound", () => {
    const objects = Array.from({ length: 20_002 }, (_, id) =>
      object(id, id === 0 ? undefined : 0),
    );
    expect(
      projectNibViewHierarchy(objects, new Set(objects.map(({ id }) => id)))
        .omitted,
    ).toBe(2);
  });
});

describe("legacy NIB hierarchy preservation", () => {
  it("keeps encoded window parents while merging shared views only once", () => {
    const legacy = [
      {
        objectID: "window",
        children: [
          { objectID: "view", children: [{ objectID: "first", children: [] }] },
        ],
      },
    ];
    const recovered = [
      {
        objectID: "view",
        children: [
          { objectID: "first", children: [] },
          { objectID: "second", children: [] },
        ],
      },
    ];
    expect(mergeNibHierarchies(legacy, recovered).hierarchy).toEqual([
      {
        objectID: "window",
        children: [
          {
            objectID: "view",
            children: [
              { objectID: "first", children: [] },
              { objectID: "second", children: [] },
            ],
          },
        ],
      },
    ]);
  });
  it("moves an existing root under its encoded parent without duplicate visits", () => {
    expect(
      mergeNibHierarchies(
        [{ objectID: "child", children: [] }],
        [
          {
            objectID: "parent",
            children: [{ objectID: "child", children: [] }],
          },
        ],
      ),
    ).toEqual({
      hierarchy: [
        { objectID: "parent", children: [{ objectID: "child", children: [] }] },
      ],
      omitted: 0,
    });
  });
  it("reports conflicting encoded parents rather than dropping a link silently", () => {
    const legacy = [
      { objectID: "first", children: [{ objectID: "child", children: [] }] },
    ];
    const recovered = [
      { objectID: "second", children: [{ objectID: "child", children: [] }] },
    ];
    expect(mergeNibHierarchies(legacy, recovered).omitted).toBe(1);
  });
  it("does not introduce a cycle when moving an existing root", () => {
    const legacy = [
      { objectID: "child", children: [{ objectID: "parent", children: [] }] },
    ];
    const recovered = [
      { objectID: "parent", children: [{ objectID: "child", children: [] }] },
    ];
    expect(mergeNibHierarchies(legacy, recovered)).toEqual({
      hierarchy: legacy,
      omitted: 1,
    });
  });
});
