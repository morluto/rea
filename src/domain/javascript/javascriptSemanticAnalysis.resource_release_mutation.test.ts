import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const operations = (source: string) =>
  analyzeJavaScriptSemantics(source).resourceOperations;

const releaseOf = (source: string) =>
  operations(source).find(({ kind }) => kind === "release");

const fixture = (replace: string | null, tail = "s.destroy();\n") =>
  `const fs = require("fs");\nconst s = fs.createReadStream("/x");\n${replace ?? ""}${tail}`;

describe("release resolution treats replaced receiver methods as partial", () => {
  it("treats a direct assignment to the released method as replacing it", () => {
    const release = releaseOf(fixture("s.destroy = () => s;\n"));
    expect(release?.resolution).toBe("partial");
    expect(release?.linkedResourceIds).toHaveLength(1);
  });

  it("treats an alias assignment to the released method as replacing it", () => {
    const release = releaseOf(fixture("const u = s;\nu.destroy = () => s;\n"));
    expect(release?.resolution).toBe("partial");
  });

  it("keeps complete resolution when the acquisition's own method is intact", () => {
    const release = releaseOf(fixture(null));
    expect(release?.resolution).toBe("complete");
  });

  it("keeps complete resolution for an unrelated property write", () => {
    const release = releaseOf(fixture("s.property = 1;\n"));
    expect(release?.resolution).toBe("complete");
  });

  it("keeps complete resolution when the write happens after the release", () => {
    const release = releaseOf(
      `const fs = require("fs");\nconst s = fs.createReadStream("/x");\ns.destroy();\ns.destroy = () => s;\n`,
    );
    expect(release?.resolution).toBe("complete");
  });

  it("treats a computed write to the released method as replacing it", () => {
    const release = releaseOf(fixture('s["destroy"] = () => s;\n'));
    expect(release?.resolution).toBe("partial");
  });

  it("treats deleting the released method as replacing it", () => {
    const release = releaseOf(fixture("delete s.destroy;\n"));
    expect(release?.resolution).toBe("partial");
  });

  // Known coverage gap, recorded honestly: the analyzer does not record
  // member writes performed through Object.assign(...) today, so this stays
  // imprecise in the same direction as before (#10163). Do not remove this
  // expectation until the analyzer retains assignment/defineProperty call-
  // member effects; update it to "partial" then.
  it("documents the current gap: Object.assign is not observed (stays complete)", () => {
    const release = releaseOf(
      fixture("Object.assign(s, { destroy: () => s });\n"),
    );
    expect(release?.resolution).toBe("complete");
  });

  // Same gap class: computed keys the analyzer does not fold ("de" + "stroy")
  // are not observed, so this stays imprecise too.
  it("documents the current gap: dynamic computed keys are not observed (stays complete)", () => {
    const release = releaseOf(fixture('s["de" + "stroy"] = () => s;\n'));
    expect(release?.resolution).toBe("complete");
  });
});
