import { describe, expect, it } from "vitest";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

describe("Vite preload dependency recovery", () => {
  it("decodes helper table values and preserves sparse and dynamic slots", () => {
    const source = String.raw`
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["./caf\u00e9.js", , getDependency(), "./last.js"]))) =>
        indexes.map((index) => dependencies[index]);
      const dynamicIndex = chooseIndex();
      __vite__mapDeps([0, , 3, dynamicIndex]);
    `;
    const analysis = analyzeJavaScriptStaticSource(source);
    const references = analysis.references.filter(
      ({ kind }) => kind === "dynamic-import",
    );

    expect(references.map(({ specifier }) => specifier).sort()).toEqual([
      "./café.js",
      "./last.js",
      null,
    ]);
    expect(references.every(({ location }) => location.start.line === 6)).toBe(
      true,
    );
    expect(references.filter(({ specifier }) => specifier === null)).toEqual([
      expect.objectContaining({
        expression: expect.stringContaining(
          "__vite__mapDeps([0, , 3, dynamicIndex])",
        ),
      }),
    ]);
  });

  it("does not take dependency strings from comments or unrelated helpers", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      // cache.f = ["./comment.js"]
      const unrelated = (cache) => cache.f || (cache.f = ["./unrelated.js"]);
      __vite__mapDeps([0]);
    `);

    expect(
      analysis.references.filter(({ kind }) => kind === "dynamic-import"),
    ).toEqual([]);
  });

  it("keeps cache escapes and explicit cache overrides unknown", () => {
    const helper = `
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["./original.js"]))) =>
        indexes.map((index) => dependencies[index]);
    `;
    const escaped = analyzeJavaScriptStaticSource(`
      ${helper}
      const dependencies = __vite__mapDeps.f;
      dependencies[0] = "./changed.js";
      __vite__mapDeps([0]);
    `);
    expect(
      escaped.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual([null]);

    const overridden = analyzeJavaScriptStaticSource(`
      ${helper}
      __vite__mapDeps([0], customMap);
    `);
    expect(
      overridden.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual([null]);

    const defaulted = analyzeJavaScriptStaticSource(`
      ${helper}
      __vite__mapDeps([0], undefined, void 0);
    `);
    expect(
      defaulted.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual(["./original.js"]);
  });

  it.each([
    ["type DependencyHelper = typeof __vite__mapDeps;", "./original.js"],
    ["const labels = { __vite__mapDeps() {} };", "./original.js"],
    ["const labels = { [__vite__mapDeps]: true };", null],
    ["const dependencyTable = __vite__mapDeps.f;", null],
  ])(
    "distinguishes an erased type query from a runtime helper escape: %s",
    (read, expected) => {
      const analysis = analyzeJavaScriptStaticSource(`
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["./original.js"]))) =>
        indexes.map((index) => dependencies[index]);
      ${read}
      __vite__mapDeps([0]);
    `);
      expect(
        analysis.references
          .filter(({ kind }) => kind === "dynamic-import")
          .map(({ specifier }) => specifier),
      ).toEqual([expected]);
    },
  );

  it("keeps table slots from a spread onward unknown", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["./first.js", ...["./middle-a.js", "./middle-b.js"], "./last.js"]))) =>
        indexes.map((index) => dependencies[index]);
      __vite__mapDeps([0, 2]);
    `);

    expect(
      analysis.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual(["./first.js", null]);
  });

  it("marks build-output paths apart from importer-relative module URLs", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
        (map.f || (map.f = ["assets/lazy.js", "./near.js", "https://cdn.example/x.js", "/abs.js"]))) =>
        indexes.map((index) => dependencies[index]);
      __vite__mapDeps([0, 1, 2, 3]);
    `);

    expect(
      analysis.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier)
        .sort(),
    ).toEqual([
      "./near.js",
      "/abs.js",
      "https://cdn.example/x.js",
      "vite-output:assets/lazy.js",
    ]);
  });
});

it.each([
  {
    name: "canonical declaration",
    prefix: "",
    suffix: "__vite__mapDeps([0]);",
    specifiers: ["./canonical.js"],
  },
  {
    name: "captured outer binding",
    prefix: "",
    suffix: "function load(){return __vite__mapDeps([0]);}load();",
    specifiers: ["./canonical.js"],
  },
  {
    name: "shadowed parameter",
    prefix: "",
    suffix:
      "function load(__vite__mapDeps){return __vite__mapDeps([0]);}load(()=>[]);",
    specifiers: [],
  },
  {
    name: "out-of-scope declaration",
    prefix: "function setup(){",
    suffix: "}__vite__mapDeps([0]);",
    specifiers: [],
  },
  {
    name: "unrelated shadowed cache mutation",
    prefix: "",
    suffix:
      "function change(__vite__mapDeps){__vite__mapDeps.f=['./other.js'];}__vite__mapDeps([0]);",
    specifiers: ["./canonical.js"],
  },
  {
    name: "uncertain with receiver",
    prefix: "",
    suffix: "with(unknown){__vite__mapDeps([0]);}",
    specifiers: [null],
  },
  {
    name: "uncertain with mutation",
    prefix: "",
    suffix:
      "with(unknown){__vite__mapDeps.f=['./other.js'];}__vite__mapDeps([0]);",
    specifiers: [null],
  },
])(
  "uses the canonical helper's lexical identity for $name",
  ({ prefix, suffix, specifiers }) => {
    const source = `${prefix}
    const __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
      (map.f || (map.f = ["./canonical.js"]))) => indexes.map((index) => dependencies[index]);
    ${suffix}
  `;
    const parsed = parseJavaScriptSource(source, "preload.cjs");
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("preload fixture did not parse");
    const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);
    expect(analysis.parse_error_count).toBe(0);
    expect(
      analysis.references
        .filter(({ kind }) => kind === "dynamic-import")
        .map(({ specifier }) => specifier),
    ).toEqual(specifiers);
  },
);

it("keeps a preload call that precedes a later helper reassignment", () => {
  const specifiers = (source: string) =>
    analyzeJavaScriptStaticSource(source)
      .references.filter(({ kind }) => kind === "dynamic-import")
      .map(({ specifier }) => specifier);
  const helper = `let __vite__mapDeps = (indexes, map = __vite__mapDeps, dependencies =
      (map.f || (map.f = ["./canonical.js"]))) => indexes.map((index) => dependencies[index]);`;
  expect(
    specifiers(`${helper} __vite__mapDeps([0]); __vite__mapDeps = () => [];`),
  ).toEqual(["./canonical.js"]);
  expect(
    specifiers(`${helper} __vite__mapDeps = () => []; __vite__mapDeps([0]);`),
  ).toEqual([]);
  expect(
    specifiers(
      `${helper} __vite__mapDeps.f = ["./changed.js"]; __vite__mapDeps([0]); __vite__mapDeps = other;`,
    ),
  ).toEqual([null]);
  expect(
    specifiers(
      `${helper} __vite__mapDeps([0]); __vite__mapDeps = other; __vite__mapDeps.f = ["./changed.js"];`,
    ),
  ).toEqual(["./canonical.js"]);
});

it("retains the identity of a function-declared preload helper", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    function __vite__mapDeps(indexes, map = __vite__mapDeps, dependencies =
      (map.f || (map.f = ["./canonical.js"]))) { return indexes.map((index) => dependencies[index]); }
    __vite__mapDeps([0]);
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(
    analysis.references
      .filter(({ kind }) => kind === "dynamic-import")
      .map(({ specifier }) => specifier),
  ).toEqual(["./canonical.js"]);
});
