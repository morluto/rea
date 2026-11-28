import { describe, expect, it } from "vitest";

import {
  isSubpathExportsObject,
  isWildcardPackageTarget,
  resolveEntryPoint,
  resolveNodeFileEntry,
  selectableConditionKeys,
  NODE_FILE_CANDIDATES,
  NODE_INDEX_CANDIDATES,
} from "./nodePackageEntry.js";

describe("resolveEntryPoint", () => {
  it("returns the first candidate present among the members", () => {
    const members = new Set(["a.json", "a.node"]);
    expect(resolveEntryPoint("a", NODE_FILE_CANDIDATES, members)).toEqual({
      path: "a.json",
      present: true,
    });
  });

  it("reports the declared path unresolved when no candidate matches", () => {
    expect(resolveEntryPoint("a", NODE_INDEX_CANDIDATES, new Set())).toEqual({
      path: "a",
      present: false,
    });
  });
});

describe("resolveNodeFileEntry", () => {
  it("prefers an exact file over an extension or an index", () => {
    const members = new Set(["lib", "lib.js", "lib/index.js"]);
    expect(resolveNodeFileEntry("lib", members)).toEqual({
      path: "lib",
      present: true,
    });
  });

  it("adds an extension before trying a directory index", () => {
    expect(
      resolveNodeFileEntry("app", new Set(["app.js", "app/index.js"])),
    ).toEqual({ path: "app.js", present: true });
  });

  it("falls back to the directory index when the file is absent", () => {
    expect(resolveNodeFileEntry("lib", new Set(["lib/index.node"]))).toEqual({
      path: "lib/index.node",
      present: true,
    });
  });

  it("returns the declared path unresolved when the member is absent", () => {
    expect(resolveNodeFileEntry("missing", new Set(["other.js"]))).toEqual({
      path: "missing",
      present: false,
    });
  });
});

describe("isSubpathExportsObject", () => {
  it("classifies a leading subpath key as a subpath map", () => {
    expect(isSubpathExportsObject(["."])).toBe(true);
    expect(isSubpathExportsObject(["./feature", "./other"])).toBe(true);
  });

  it("classifies a leading condition name as a conditions object", () => {
    expect(isSubpathExportsObject(["import", "require"])).toBe(false);
    expect(isSubpathExportsObject(["default", "node"])).toBe(false);
  });

  it("treats an empty object as a subpath map that exposes nothing", () => {
    expect(isSubpathExportsObject([])).toBe(true);
  });
});

describe("selectableConditionKeys", () => {
  it("stops at the first default, since no later branch can be selected", () => {
    expect(selectableConditionKeys(["import", "default", "node"])).toEqual([
      "import",
      "default",
    ]);
  });

  it("keeps every key when there is no default", () => {
    expect(selectableConditionKeys(["import", "require"])).toEqual([
      "import",
      "require",
    ]);
  });

  it("drops conditions that follow a leading default", () => {
    expect(selectableConditionKeys(["default", "node"])).toEqual(["default"]);
  });
});

describe("isWildcardPackageTarget", () => {
  it("marks a subpath pattern target as a wildcard", () => {
    expect(isWildcardPackageTarget("./dist/*.js")).toBe(true);
  });

  it("treats a fully specified target as concrete", () => {
    expect(isWildcardPackageTarget("./dist/index.js")).toBe(false);
  });
});
