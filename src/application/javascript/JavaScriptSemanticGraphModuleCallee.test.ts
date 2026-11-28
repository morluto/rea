import { describe, expect, it } from "vitest";

import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

const calls = (source: string) =>
  graphForJavaScript(source).nodes.filter(({ kind }) => kind === "call-site");

describe("VS Code callee facts", () => {
  it("records the vscode member beside the literal arguments", () => {
    const [call] = calls(
      'const v = require("vscode"); v.commands.registerCommand("demo.hello", f);',
    ).filter(({ properties }) => "module_callee" in properties);
    expect(call?.properties).toMatchObject({
      module_callee: {
        specifier: "vscode",
        path: ["commands", "registerCommand"],
        loader_authority: "candidate",
      },
      arguments: [{ index: 0, value: "demo.hello" }],
    });
  });

  it("records the fact for a call without literal arguments", () => {
    const found = calls(
      'import * as v from "vscode"; v.commands.registerCommand(id, f);',
    );
    expect(found.map(({ properties }) => properties.module_callee)).toEqual([
      { specifier: "vscode", path: ["commands", "registerCommand"] },
    ]);
  });

  it("leaves calls into other modules unchanged", () => {
    const found = calls('const fs = require("fs"); fs.readFile(p);');
    expect(found.every(({ properties }) => !properties.module_callee)).toBe(
      true,
    );
  });
});
