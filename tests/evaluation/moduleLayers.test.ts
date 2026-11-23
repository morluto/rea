import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  ENTRY_FILES,
  PROVIDER_DEPENDENCIES,
  UNIT_LAYERS,
  compareLayerBaseline,
  layerGraphFacts,
  lowerLayerBaseline,
  providerBoundaryFacts,
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
      crossProvider: {},
      entry: { "application -> native": 1 },
    });
  });

  it("refuses an undeclared unit instead of leaving it unconstrained", () => {
    expect(
      layerGraphFacts([edge("src/newProvider/A.ts", "src/domain/B.js")])
        .undeclared,
    ).toEqual(["newProvider"]);
    expect(layerGraphFacts([], ["src/isolated/A.ts"]).undeclared).toEqual([
      "isolated",
    ]);
    expect(
      layerGraphFacts(
        [edge("src/isolated/A.ts", "src/isolated/B.js")],
        ["src/isolated/A.ts"],
      ).undeclared,
    ).toEqual(["isolated"]);
  });

  it("separates growth from shrinkage", () => {
    const baseline = {
      upward: { "native -> application": 2, "gdb -> application": 1 },
      cycles: ["application <-> native", "application <-> gdb"],
    };
    const grown = compareLayerBaseline(
      {
        undeclared: [],
        upward: { "native -> application": 3, "rizin -> application": 1 },
        cycles: ["application <-> native", "application <-> rizin"],
        crossProvider: { "gpu -> native": 2 },
        entry: {},
      },
      { ...baseline, entry: { "composition -> ghidra": 1 } },
    );
    expect(grown.failures).toEqual([
      "upward import native -> application: 3 imports, baseline 2",
      "upward import rizin -> application: 1 imports, baseline 0",
      "cross-provider import gpu -> native: 2 imports, baseline 0",
      "mutual import not in baseline: application <-> rizin",
    ]);
    expect(grown.lowerable).toEqual([
      "upward import gdb -> application: 0, baseline 1",
      "import past the entry file composition -> ghidra: 0, baseline 1",
      "recorded mutual import no longer present: application <-> gdb",
    ]);
  });

  it("lowers a baseline to the observed facts without admitting growth", () => {
    expect(
      lowerLayerBaseline(
        {
          undeclared: [],
          upward: {
            "native -> application": 1,
            "gdb -> application": 3,
            "rizin -> application": 1,
          },
          cycles: ["application <-> native", "application <-> rizin"],
          crossProvider: { "gpu -> native": 1, "go -> native": 4 },
          entry: {},
        },
        {
          crossProvider: { "gpu -> native": 3 },
          entry: { "composition -> ghidra": 2 },
          upward: {
            "native -> application": 2,
            "gdb -> application": 2,
            "kuna -> application": 1,
          },
          cycles: ["application <-> native", "application <-> gdb"],
        },
      ),
    ).toEqual({
      upward: { "native -> application": 1, "gdb -> application": 2 },
      cycles: ["application <-> native"],
      crossProvider: { "gpu -> native": 1 },
      entry: {},
    });
  });
});

describe("provider boundaries", () => {
  it("counts cross-provider imports and imports past a provider's entry files", () => {
    expect(
      providerBoundaryFacts([
        edge("src/gpu/A.ts", "src/native/B.js"),
        edge("src/gpu/A.ts", "src/native/NativeMacOSProvider.js"),
        edge("src/gpu/A.ts", "src/providers/Core.js"),
        edge("src/gpu/A.ts", "src/resources/index.js"),
        edge("src/gpu/A.ts", "src/gpu/C.js"),
        edge("src/composition/D.ts", "src/ghidra/E.js"),
        edge("src/composition/D.ts", "src/ghidra/GhidraDoctor.js"),
        edge("src/composition/D.ts", "src/ghidra/index.js"),
        edge("src/application/G.ts", "src/ghidra/GhidraProvider.js"),
        edge("src/server/F.ts", "src/ghidra/E.js"),
        edge("src/providers/Core.ts", "src/ghidra/E.js"),
        edge("src/composition/D.test.ts", "src/ghidra/E.js"),
      ]),
    ).toEqual({
      crossProvider: { "gpu -> native": 2 },
      entry: { "composition -> ghidra": 2, "server -> ghidra": 1 },
    });
  });

  it("names only existing files as entry files and declared dependencies", () => {
    const declared = [
      ...Object.entries(ENTRY_FILES),
      ...PROVIDER_DEPENDENCIES.map(({ to, files }) => [to, files] as const),
    ];
    const missing = declared.flatMap(([unit, files]) =>
      files
        .map((file) => `src/${unit}/${file}`)
        .filter((path) => !existsSync(path)),
    );
    expect(missing).toEqual([]);
  });

  it("skips only declared provider dependency files for their pair", () => {
    expect(
      providerBoundaryFacts([
        edge("src/inspector/A.ts", "src/browser/CdpConnection.js"),
        edge("src/inspector/A.ts", "src/browser/protocol/CdpEvents.js"),
        edge("src/inspector/A.ts", "src/browser/CdpBrowserProvider.js"),
        edge("src/electron/B.ts", "src/browser/CdpConnection.js"),
      ]).crossProvider,
    ).toEqual({ "electron -> browser": 1, "inspector -> browser": 1 });
  });

  it("counts every outside import of a toolkit file past src/resources/index.ts", () => {
    expect(
      providerBoundaryFacts([
        edge("src/gpu/A.ts", "src/resources/Reader.js"),
        edge("src/gpu/A.ts", "src/resources/index.js"),
        edge("src/process/B.ts", "src/resources/Scope.js"),
        edge("src/application/C.ts", "src/resources/Scope.js"),
        edge("src/resources/Scope.ts", "src/resources/Reader.js"),
        edge("src/gpu/A.test.ts", "src/resources/Reader.js"),
      ]).entry,
    ).toEqual({
      "application -> resources": 1,
      "gpu -> resources": 1,
      "process -> resources": 1,
    });
  });

  it("keeps the shared provider core below every provider folder", () => {
    expect(UNIT_LAYERS.providers).toBe("providerCore");
    expect(
      layerGraphFacts([
        edge("src/ghidra/A.ts", "src/providers/Core.js"),
        edge("src/providers/Core.ts", "src/ghidra/A.js"),
      ]).upward,
    ).toEqual({ "providers -> ghidra": 1 });
  });

  it("counts domain-to-platform imports without a local-path exception", () => {
    expect(
      layerGraphFacts([
        edge("src/domain/localPath.ts", "src/platform/HostPlatform.js"),
      ]).upward,
    ).toEqual({ "domain -> platform": 1 });
    expect(
      layerGraphFacts([
        edge("src/domain/localPath.ts", "src/platform/HostPlatform.js"),
        edge("src/domain/other.ts", "src/platform/HostPlatform.js"),
        edge("src/domain/localPath.ts", "src/platform/Other.js"),
      ]).upward,
    ).toEqual({ "domain -> platform": 3 });
  });
});
