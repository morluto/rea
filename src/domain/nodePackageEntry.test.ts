import { describe, expect, it } from "vitest";

import {
  resolveEntryPoint,
  resolveNodeFileEntry,
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
