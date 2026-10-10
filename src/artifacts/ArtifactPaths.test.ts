import { describe, expect, it } from "vitest";

import {
  annotateEnglishUnicodeCaseCollisions,
  ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION,
} from "./ArtifactPaths.js";

const NOTE =
  "a case-insensitive destination cannot store both. This comparison is not a filesystem observation.";

const annotate = (paths: readonly string[]) => {
  const occurrences = paths.map((logical_path) => ({
    logical_path,
    limitations: [] as string[],
  }));
  const limitation = annotateEnglishUnicodeCaseCollisions(occurrences);
  return {
    limitation,
    byPath: new Map(
      occurrences.map(({ logical_path, limitations }) => [
        logical_path,
        limitations,
      ]),
    ),
  };
};

describe("English Unicode case collisions", () => {
  it("names the other spelling of a colliding file", () => {
    const { limitation, byPath } = annotate([".", "Main.js", "main.js", "x"]);
    expect(limitation).toBe(ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION);
    expect(byPath.get("Main.js")).toEqual([
      `Logical path Main.js collides under English (en-US) Unicode case folding with main.js; ${NOTE}`,
    ]);
    expect(byPath.get("main.js")).toEqual([
      `Logical path main.js collides under English (en-US) Unicode case folding with Main.js; ${NOTE}`,
    ]);
    expect(byPath.get("x")).toEqual([]);
  });

  it("records a directory collision once at the diverging segment", () => {
    const { byPath } = annotate([
      "res/Foo",
      "res/Foo/a.txt",
      "res/foo",
      "res/foo/b.txt",
    ]);
    expect(byPath.get("res/Foo")).toEqual([
      `Logical path res/Foo collides under English (en-US) Unicode case folding with res/foo; ${NOTE}`,
    ]);
    expect(byPath.get("res/foo/b.txt")).toEqual([
      `Logical path res/foo/b.txt is under res/foo, which collides under English (en-US) Unicode case folding with res/Foo; ${NOTE}`,
    ]);
  });

  it("counts further spellings, each of which is its own occurrence", () => {
    const { byPath } = annotate(["A.txt", "a.txt", "a.TXT"]);
    expect(byPath.get("a.txt")).toEqual([
      `Logical path a.txt collides under English (en-US) Unicode case folding with A.txt and 1 other spelling; ${NOTE}`,
    ]);
  });

  it("stays linear for large case-variant subtrees", () => {
    const count = 5_000;
    const paths = Array.from({ length: count }, (_, index) => [
      `Foo/a${String(index)}.txt`,
      `foo/b${String(index)}.txt`,
    ]).flat();
    const { byPath } = annotate(paths);
    for (const path of paths) {
      const limitations = byPath.get(path) ?? [];
      expect(limitations).toHaveLength(1);
      expect(limitations[0]?.length).toBeLessThan(300);
    }
  });

  it("walks names with more components than the call stack holds", () => {
    const deep = Array.from({ length: 30_000 }, () => "a").join("/");
    const { byPath } = annotate([deep, `${deep}/X`, `${deep}/x`]);
    expect(byPath.get(`${deep}/X`)).toHaveLength(1);
    expect(byPath.get(deep)).toEqual([]);
  });
});
