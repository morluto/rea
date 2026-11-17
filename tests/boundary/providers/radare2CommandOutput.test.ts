import { describe, expect, it } from "vitest";

import { projectRadare2JsonOutput } from "../../../src/radare2/radare2CommandOutput.js";

describe("projectRadare2JsonOutput", () => {
  it("projects valid JSON objects", () => {
    expect(projectRadare2JsonOutput('{"functions":[{"name":"main"}]}')).toEqual(
      { parsed: { functions: [{ name: "main" }] } },
    );
  });

  it("projects arrays and bare scalars", () => {
    expect(projectRadare2JsonOutput("[1,2,3]")).toEqual({
      parsed: [1, 2, 3],
    });
    expect(projectRadare2JsonOutput("42\n")).toEqual({ parsed: 42 });
  });

  it("returns undefined for invalid JSON, prose, and empty output", () => {
    expect(projectRadare2JsonOutput("not json")).toBeUndefined();
    expect(projectRadare2JsonOutput("{unterminated")).toBeUndefined();
    expect(projectRadare2JsonOutput("")).toBeUndefined();
    expect(projectRadare2JsonOutput("   \n  ")).toBeUndefined();
  });
});

describe("projectRadare2Summary", () => {
  it("reduces aflj entries to name, addr, and size", async () => {
    const { projectRadare2Summary } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    const parsed = [
      {
        name: "main",
        addr: 4294984340,
        size: 16,
        signature: "int main(int argc, char **argv)",
        nbbs: 12,
      },
    ];
    expect(projectRadare2Summary("aflj", parsed)).toEqual([
      { name: "main", addr: 4294984340, size: 16 },
    ]);
  });

  it("reduces producer-shaped izzj entries to string, vaddr, paddr, and length", async () => {
    const { projectRadare2Summary } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    expect(
      projectRadare2Summary("izzj", [
        {
          vaddr: 4294984340,
          paddr: 12288,
          string: "/lib/ld.so",
          length: 10,
          section: ".rodata",
          type: "ascii",
          ordinal: 1,
          size: 11,
        },
      ]),
    ).toEqual([
      { string: "/lib/ld.so", vaddr: 4294984340, paddr: 12288, length: 10 },
    ]);
  });

  it("returns undefined for other commands and non-array output", async () => {
    const { projectRadare2Summary } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    expect(projectRadare2Summary("pdg @ main", { code: 1 })).toBeUndefined();
    expect(projectRadare2Summary("aflj", { not: "array" })).toBeUndefined();
  });
});

describe("projectRadare2DeliveryViews", () => {
  it("degrades to raw output when parsed JSON holds non-finite numbers", async () => {
    const { projectRadare2DeliveryViews } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    expect(projectRadare2DeliveryViews("aflj", "1e400")).toEqual({});
    expect(
      projectRadare2DeliveryViews("aflj", '[{"name":"main","addr":1e400}]'),
    ).toEqual({});
    // Integers beyond Number.MAX_SAFE_INTEGER round silently; the projection
    // must degrade instead of shipping the rounded value.
    expect(
      projectRadare2DeliveryViews(
        "aflj",
        '[{"name":"main","addr":9007199254740993}]',
      ),
    ).toEqual({});
    // Faithful alternate spellings keep the projection: 1.0, 1e3, and
    // trailing-zero decimals are exactly representable even though their
    // canonical spelling differs.
    expect(
      projectRadare2DeliveryViews("aflj", '[{"name":"main","size":1.0}]'),
    ).toEqual({
      parsed: [{ name: "main", size: 1 }],
      summary: [{ name: "main", size: 1 }],
    });
    expect(
      projectRadare2DeliveryViews("aflj", '[{"name":"main","addr":1e3}]'),
    ).toEqual({
      parsed: [{ name: "main", addr: 1000 }],
      summary: [{ name: "main", addr: 1000 }],
    });
  });

  it("degrades to raw output at the Evidence depth limit", async () => {
    const { projectRadare2DeliveryViews } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    const nest = (levels: number): unknown => {
      let value: unknown = 1;
      for (let index = 0; index < levels; index += 1) value = [value];
      return value;
    };
    // Evidence validates `raw_result` one level below the projection, so 999
    // nested levels still fit and 1000 must degrade instead of throwing.
    expect(
      Object.hasOwn(
        projectRadare2DeliveryViews("ij", JSON.stringify(nest(999))),
        "parsed",
      ),
    ).toBe(true);
    expect(
      projectRadare2DeliveryViews("ij", JSON.stringify(nest(1000))),
    ).toEqual({});
  });

  it("keeps views for finite JSON values", async () => {
    const { projectRadare2DeliveryViews } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    expect(projectRadare2DeliveryViews("aflj", '[{"name":"main"}]')).toEqual({
      parsed: [{ name: "main" }],
      summary: [{ name: "main" }],
    });
  });
});
