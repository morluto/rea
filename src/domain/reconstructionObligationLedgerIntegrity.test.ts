import { describe, expect, it, vi } from "vitest";

import { foldByKey } from "./reconstructionObligationLedgerIntegrity.js";

describe("reconstruction obligation grouping", () => {
  it("creates each group once and appends to that same array in place", () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({
      key: index % 2 === 0 ? "even" : "odd",
      index,
    }));
    const created: number[][] = [];
    const create = vi.fn(() => {
      const group: number[] = [];
      created.push(group);
      return group;
    });
    const add = vi.fn((group: number[], item: { readonly index: number }) => {
      group.push(item.index);
    });

    const groups = foldByKey(items, ({ key }) => key, create, add);

    expect(create).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(items.length);
    // Every append reached the group created for its key, and the result
    // holds those same arrays rather than copies.
    expect(groups.get("even")).toBe(created[0]);
    expect(groups.get("odd")).toBe(created[1]);
    for (const [index, [group]] of add.mock.calls.entries())
      expect(group).toBe(groups.get(index % 2 === 0 ? "even" : "odd"));
    expect(groups.get("even")).toHaveLength(2500);
    expect(groups.get("odd")).toHaveLength(2500);
  });

  it("skips items without a key", () => {
    const create = vi.fn((): string[] => []);
    const groups = foldByKey(
      ["kept", "skipped"],
      (item) => (item === "kept" ? "group" : null),
      create,
      (group, item) => {
        group.push(item);
      },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect([...groups]).toEqual([["group", ["kept"]]]);
  });
});
