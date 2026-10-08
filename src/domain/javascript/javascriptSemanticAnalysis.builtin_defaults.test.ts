import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it("does not assign built-in APIs to unrelated or shadowed bindings", () => {
  const ir = analyzeJavaScriptSemantics(`
    import fs from "./fs.js";
    import { constants as constantsFs } from "node:fs";
    fs.createReadStream("config.json");
    constantsFs.createReadStream("config.json");
    function run(fs) { fs.createReadStream("config.json"); }
  `);

  expect(ir.resourceOperations).toEqual([]);
});
