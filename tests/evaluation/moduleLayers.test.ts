import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  UNIT_LAYERS,
  compareLayerBaseline,
  layerGraphFacts,
  sourceUnit,
} from "../../scripts/lib/module-layers.mjs";

const edge = (file: string, target: string) => ({ file, target });

describe("top-level module layers", () => {
  it("declares a layer for every top-level source unit", async () => {
    const entries = await readdir("src", { withFileTypes: true });
    const units = entries
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.name.endsWith(".ts") &&
            sourceUnit(`src/${entry.name}`) !== undefined),
      )
      .map(({ name }) => name);
    expect(units.filter((unit) => UNIT_LAYERS[unit] === undefined)).toEqual([]);
  });

  it("maps files, root files and built specifiers to units, ignoring tests", () => {
    expect(sourceUnit("src/native/elf/Reader.ts")).toBe("native");
    expect(sourceUnit("src/native/elf/Reader.js")).toBe("native");
    expect(sourceUnit("src/cli.js")).toBe("cli.ts");
    expect(sourceUnit("src/native/elf/Reader.test.ts")).toBeUndefined();
    expect(sourceUnit("tests/fixtures/x.ts")).toBeUndefined();
  });

  it("counts upward imports per unit pair and reports mutual imports", () => {
    const facts = layerGraphFacts([
      edge("src/native/A.ts", "src/application/B.js"),
      edge("src/native/C.ts", "src/application/D.js"),
      edge("src/application/B.ts", "src/native/A.js"),
      edge("src/application/B.ts", "src/domain/E.js"),
      edge("src/application/B.ts", "src/application/F.js"),
      edge("src/native/A.test.ts", "src/cli/G.js"),
    ]);
    expect(facts).toEqual({
      undeclared: [],
      upward: { "native -> application": 2 },
      cycles: ["application <-> native"],
    });
  });

  it("refuses an undeclared unit instead of leaving it unconstrained", () => {
    expect(
      layerGraphFacts([edge("src/newProvider/A.ts", "src/domain/B.js")])
        .undeclared,
    ).toEqual(["newProvider"]);
  });

  it("fails on growth and only reports shrinkage", () => {
    const baseline = {
      upward: { "native -> application": 2, "gdb -> application": 1 },
      cycles: ["application <-> native", "application <-> gdb"],
    };
    const grown = compareLayerBaseline(
      {
        undeclared: [],
        upward: { "native -> application": 3, "rizin -> application": 1 },
        cycles: ["application <-> native", "application <-> rizin"],
      },
      baseline,
    );
    expect(grown.failures).toEqual([
      "upward import native -> application: 3 imports, baseline 2",
      "upward import rizin -> application: 1 imports, baseline 0",
      "mutual import not in baseline: application <-> rizin",
    ]);
    expect(grown.lowerable).toEqual([
      "upward import gdb -> application: 0, baseline 1",
      "recorded mutual import no longer present: application <-> gdb",
    ]);
  });
});
