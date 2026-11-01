import { describe, expect, it } from "vitest";

import {
  importSpecifier,
  readImportSpecifiers,
} from "../../scripts/lib/import-specifiers.mjs";

describe("import specifier reader", () => {
  it("reads side-effect imports and ignores import-like text", () => {
    expect(
      readImportSpecifiers(`
        // from "./commented.js"
        /* import "./block-comment.js"; */
        const text = "from './string.js'";
        import "./side-effect.js";
        import { value } from "./named.js";
        export { value as again } from "./reexported.js";
        const loaded = import("./dynamic.js");
      `).map(({ specifier }) => specifier),
    ).toEqual([
      "./side-effect.js",
      "./named.js",
      "./reexported.js",
      "./dynamic.js",
    ]);
  });

  it("reads type, namespace, and empty-template specifiers", () => {
    const facts = readImportSpecifiers(`import type { Fact } from "./types.js";
export * from "./all.js";
import name = require("./equals.js");
type Query = import("./query.js").Query;
const dynamic = import(\`./template.js\`);
const computed = import(name);
import "node:fs";
`);
    expect(facts).toEqual([
      { specifier: "./types.js", line: 1, typeOnly: true },
      { specifier: "./all.js", line: 2, typeOnly: false },
      { specifier: "./equals.js", line: 3, typeOnly: false },
      { specifier: "./query.js", line: 4, typeOnly: true },
      { specifier: "./template.js", line: 5, typeOnly: false },
      { specifier: "node:fs", line: 7, typeOnly: false },
    ]);
  });

  it.each([
    ['import type Default from "./owner.js";', true],
    ['import type * as Namespace from "./owner.js";', true],
    ['import { type Port, type Other as Alias } from "./owner.js";', true],
    ['import { type Port, Constructor as Alias } from "./owner.js";', false],
    ['import Default, { type Port } from "./owner.js";', false],
    ['import {} from "./owner.js";', false],
    ['import "./owner.js";', false],
    ['export type { Port } from "./owner.js";', true],
    ['export { type Port, type Other as Alias } from "./owner.js";', true],
    ['export { type Port, Constructor as Alias } from "./owner.js";', false],
    ['export {} from "./owner.js";', false],
    ['export type * from "./owner.js";', true],
    ['export type * as Namespace from "./owner.js";', true],
    ['export * as Namespace from "./owner.js";', false],
    ['import type Owner = require("./owner.js");', true],
    ['import Owner = require("./owner.js");', false],
    ['type Port = import("./owner.js").Port;', true],
    ['type Constructor = typeof import("./owner.js").Constructor;', true],
    ['const Owner = import("./owner.js");', false],
    ["const Owner = import(`./owner.js`);", false],
  ])("derives runtime ownership from %s", (source, typeOnly) => {
    expect(readImportSpecifiers(source)).toEqual([
      { specifier: "./owner.js", line: 1, typeOnly },
    ]);
  });

  it("ignores nodes that are not static imports", () => {
    expect(importSpecifier({ type: "Identifier" })).toBeUndefined();
  });
});
