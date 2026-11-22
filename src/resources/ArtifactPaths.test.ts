import { describe, expect, it } from "vitest";

import {
  ArtifactPathRegistry,
  destinationCaseCollision,
  DestinationCaseCollisionFailure,
  annotateEnglishUnicodeCaseCollisions,
  ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";

const longName = "x".repeat(2_048);

const obstructedDestination = (path: string) => {
  const registry = new ArtifactPathRegistry();
  registry.add(longName, "file");
  registry.add(path, "directory");
};

it.each([
  ["absolute or unsafe", () => normalizeArtifactPath(`C:/${longName}`)],
  [
    "absolute or unsafe",
    () => normalizeArtifactPath("\0".repeat(longName.length)),
  ],
  ["not normalized", () => normalizeArtifactPath(`${longName}/../child`)],
  ["prefix conflict", () => obstructedDestination(`${longName}/child`)],
  ["path collision", () => obstructedDestination(longName)],
] as const)("bounds the %s path diagnostic", (diagnostic, fail) => {
  expect.assertions(3);
  try {
    fail();
  } catch (failure: unknown) {
    expect(failure).toMatchObject({ reason: "path" });
    if (!(failure instanceof Error)) throw failure;
    expect(failure.message).toContain(diagnostic);
    expect(failure.message.length).toBeLessThan(1_024);
  }
});

it.each(["a:b", "C:cache/file.txt", "a:"])(
  "preserves a literal POSIX colon name %s",
  (path) => {
    expect(normalizeArtifactPath(path)).toBe(path);
  },
);

const annotate = (paths: readonly string[]) => {
  const occurrences = paths.map((logical_path) => ({
    entry_kind: "file" as const,
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

const expectCollision = (
  limitations: string[] | undefined,
  ...facts: string[]
) => {
  expect(limitations).toHaveLength(1);
  const warning = limitations?.[0] ?? "";
  for (const fact of facts) expect(warning).toContain(fact);
};

describe("English Unicode case collisions", () => {
  it("retains repeated same-kind entries while rejecting file-directory aliasing", () => {
    const registry = new ArtifactPathRegistry();
    registry.add("duplicate", "file");
    expect(() => registry.add("duplicate", "file")).not.toThrow();
    expect(() => registry.add("duplicate", "directory")).toThrow(
      "Artifact path collision",
    );
  });

  it("reports colliding spellings at the diverging segment only", () => {
    const { limitation, byPath } = annotate([
      "Main.js",
      "main.js",
      "a.TXT",
      "A.txt",
      "a.txt",
      "res/Foo",
      "res/Foo/a.txt",
      "res/foo",
      "res/foo/b.txt",
      "unrelated",
    ]);
    expect(limitation).toBe(ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION);
    expectCollision(byPath.get("Main.js"), "Main.js collides", "with main.js;");
    expectCollision(byPath.get("main.js"), "main.js collides", "with Main.js;");
    expectCollision(byPath.get("a.txt"), "with A.txt and 1 other spelling;");
    expectCollision(byPath.get("res/Foo"), "res/Foo collides", "with res/foo;");
    expectCollision(
      byPath.get("res/foo/b.txt"),
      "res/foo/b.txt is under res/foo",
      "with res/Foo;",
    );
    expect(byPath.get("unrelated")).toEqual([]);
    for (const path of ["Main.js", "res/foo/b.txt"])
      expect(byPath.get(path)?.[0]).toMatch(
        /English.*case folding.*case-insensitive destination cannot store both.*not a filesystem observation/iu,
      );
  });

  it("retains every spelling in a high-cardinality folded sibling group", () => {
    const count = 8_192;
    const original = "abcdefghijklm";
    const { byPath } = annotate(caseVariants(original, count));
    const first = "ABCDEFGHIJKLM";
    const second = "ABCDEFGHIJKLm";
    expect(byPath.size).toBe(count);
    expectCollision(
      byPath.get(first),
      first,
      second,
      `${String(count - 2)} other spellings`,
    );
    expect(byPath.get(original)?.[0]).toContain(
      `with ${first} and ${String(count - 2)} other spellings;`,
    );
    expect(
      [...byPath.values()].every((limitations) => limitations.length === 1),
    ).toBe(true);
  });

  it("bounds diagnostic lengths for large case-variant subtrees", () => {
    const count = 5_000;
    const paths = Array.from({ length: count }, (_, index) => [
      `Foo/a${String(index)}.txt`,
      `foo/b${String(index)}.txt`,
    ]).flat();
    const { byPath } = annotate(paths);
    const incorrect = paths.find((path) => {
      const limitations = byPath.get(path);
      return (
        limitations?.length !== 1 || (limitations[0]?.length ?? 300) >= 300
      );
    });
    expect(incorrect).toBeUndefined();
  });

  it("walks names with more components than the call stack holds", () => {
    const deep = Array.from({ length: 30_000 }, () => "a").join("/");
    const { byPath } = annotate([deep, `${deep}/X`, `${deep}/x`]);
    expect(byPath.get(`${deep}/X`)).toHaveLength(1);
    expect(byPath.get(deep)).toEqual([]);
  });
});

const caseVariants = (lowercase: string, count: number): string[] => {
  const characters = [...lowercase];
  return Array.from({ length: count }, (_, mask) =>
    characters
      .map((character, index) =>
        (mask & (1 << index)) === 0 ? character : character.toUpperCase(),
      )
      .join(""),
  );
};

it("retains both source spellings and the native failure in a destination collision", () => {
  const cause = Object.assign(new Error("exclusive create refused"), {
    code: "EEXIST",
  });
  const collision = destinationCaseCollision("res/café.js", ["CAFÉ.js"], {
    cause,
  });
  expect(collision).toBeInstanceOf(DestinationCaseCollisionFailure);
  expect(collision).toMatchObject({
    reason: "path",
    requestedPath: "res/café.js",
    existingPath: "res/CAFÉ.js",
  });
  expect(collision?.cause).toBe(cause);
});

it.each([["app.js", "App.js"], ["other.js"]])(
  "does not invent a destination alias from listing %j",
  (...names) => {
    expect(destinationCaseCollision("res/app.js", names)).toBeUndefined();
  },
);

it("reserves prefix capacity atomically without declaring destination kinds", () => {
  const registry = new ArtifactPathRegistry({ maxParts: 4, maxNodes: 3 });
  registry.reservePath("a/b");
  expect(() => registry.reservePath("a/c/d")).toThrow();
  expect(() => registry.reservePath("z")).not.toThrow();
  expect(() => registry.reservePath("a/b")).not.toThrow();
  registry.add("a/b", "file");
  expect(() => registry.add("a/b", "directory")).toThrow();
});

it("reports a file prefix conflict without inserting the candidate", () => {
  const registry = new ArtifactPathRegistry({ maxParts: 4, maxNodes: 2 });
  registry.reservePath("a/b");
  expect(registry.conflicts("a/b")).toBe(true);
  expect(registry.conflicts("a")).toBe(true);
  expect(registry.conflicts("a/b/c")).toBe(true);
  expect(registry.conflicts("a/c")).toBe(false);
  expect(registry.conflicts("z")).toBe(false);
  expect(() => registry.reservePath("z")).toThrow();
});
