import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { semanticModuleCallees } from "./javascriptSemanticModuleCallee.js";

const callees = (source: string) =>
  [...semanticModuleCallees(analyzeJavaScriptSemantics(source)).values()].map(
    ({ specifier, path }) => `${specifier}:${path.join(".")}`,
  );
const REGISTER = "vscode:commands.registerCommand";

describe("module-rooted callees", () => {
  it.each([
    [
      "a required namespace",
      'const vscode = require("vscode"); vscode.commands.registerCommand("a", f);',
    ],
    [
      "an import namespace",
      'import * as vscode from "vscode"; vscode.commands.registerCommand("a", f);',
    ],
    [
      "a default import",
      'import vscode from "vscode"; vscode.commands.registerCommand("a", f);',
    ],
    [
      "a named import",
      'import { commands as c } from "vscode"; c.registerCommand("a", f);',
    ],
    [
      "a destructured require",
      'const { commands } = require("vscode"); commands.registerCommand("a", f);',
    ],
    [
      "an alias",
      'const v = require("vscode"); const w = v; w.commands.registerCommand("a", f);',
    ],
    [
      "a sequence callee",
      'const v = require("vscode"); (0, v.commands.registerCommand)("a", f);',
    ],
    [
      "optional access",
      'const v = require("vscode"); v?.commands?.registerCommand("a", f);',
    ],
  ])("resolves %s", (_, source) => {
    expect(callees(source)).toContain(REGISTER);
  });

  it.each([
    [
      "a selected fallback",
      'const v = false || require("vscode"); v.commands.registerCommand("a");',
    ],
    [
      "two branches requiring the same module",
      'const v = flag ? require("vscode") : require("vscode"); v.commands.registerCommand("a");',
    ],
  ])("resolves %s", (_, source) => {
    expect(callees(source)).toContain(REGISTER);
  });

  it("labels a require-based origin as a candidate", () => {
    const [callee] = semanticModuleCallees(
      analyzeJavaScriptSemantics('const v = require("vscode"); v.f();'),
    ).values();
    expect(callee?.loader_authority).toBe("candidate");
  });

  it.each([
    [
      "a conditional import",
      'const v = flag ? require("vscode") : fake; v.commands.registerCommand("a");',
    ],
    [
      "a fallback import",
      'const v = flag || require("vscode"); v.commands.registerCommand("a");',
    ],
    [
      "a conditional alias",
      'const v = require("vscode"); const w = flag ? v : fake; w.commands.registerCommand("a");',
    ],
    [
      "a local require",
      'function g(require) { const v = require("vscode"); v.commands.registerCommand("a"); }',
    ],
    [
      "a local object of the same name",
      'const vscode = { commands: { registerCommand() {} } }; vscode.commands.registerCommand("a");',
    ],
    [
      "a parameter shadowing the import",
      'const vscode = require("vscode"); function g(vscode) { vscode.commands.registerCommand("a"); }',
    ],
    [
      "a reassigned binding",
      'let vscode = require("vscode"); vscode = fake; vscode.commands.registerCommand("a");',
    ],
    [
      "a computed member",
      'const v = require("vscode"); v.commands[name]("a");',
    ],
    ["an unbound global", 'vscode.commands.registerCommand("a");'],
  ])("does not resolve %s", (_, source) => {
    expect(callees(source)).not.toContain(REGISTER);
  });

  it.each([
    [
      "a namespace helper",
      'var o = __toESM(require("vscode")); o.commands.registerCommand("a", f);',
    ],
    [
      "a minified helper with a mode flag",
      'var o = l(require("vscode"), 1); o.commands.registerCommand("a", f);',
    ],
    [
      "a TypeScript import star",
      'const v = __importStar(require("vscode")); v.commands.registerCommand("a", f);',
    ],
    [
      "a default import through a helper",
      'const v = __importDefault(require("vscode")); v.default.commands.registerCommand("a", f);',
    ],
    [
      "a two-step conversion",
      'let v = require("vscode"); v = __toESM(v); v.commands.registerCommand("a", f);',
    ],
  ])("resolves %s as a wrapped candidate", (_, source) => {
    const found = [
      ...semanticModuleCallees(analyzeJavaScriptSemantics(source)).values(),
    ].filter(({ path }) => path.join(".") === "commands.registerCommand");
    expect(found).toEqual([
      {
        specifier: "vscode",
        path: ["commands", "registerCommand"],
        loader_authority: "candidate",
        wrapper: "unverified",
      },
    ]);
  });

  it.each([
    [
      "a wrapper taking two modules",
      'const v = join(require("vscode"), require("other")); v.commands.registerCommand("a");',
    ],
    [
      "a member of the wrapper result input",
      'const v = pick(require("vscode").window); v.commands.registerCommand("a");',
    ],
    [
      "a wrapped binding assigned again",
      'let v = __toESM(require("vscode")); v = fake; v.commands.registerCommand("a");',
    ],
    [
      "a method wrapping the module",
      'const v = registry.wrap(require("vscode")); v.commands.registerCommand("a");',
    ],
  ])("does not resolve %s", (_, source) => {
    expect(callees(source)).not.toContain(REGISTER);
  });
});

describe("module members that are not the imported ones", () => {
  it.each([
    [
      "an explicit default member of a require",
      'const v = require("vscode"); v.default.commands.registerCommand("a", f);',
    ],
    [
      "a replaced member",
      'const v = require("vscode"); v.commands.registerCommand = noop; v.commands.registerCommand("a", f);',
    ],
    [
      "a member replaced through an alias",
      'const v = require("vscode"); const c = v.commands; c.registerCommand = noop; v.commands.registerCommand("a", f);',
    ],
    [
      "a replaced parent object",
      'const v = require("vscode"); v.commands = fake; v.commands.registerCommand("a", f);',
    ],
    [
      "a replaced member of a wrapped require",
      'var i = toESM(require("vscode")); i.commands.registerCommand = noop; i.commands.registerCommand("a", f);',
    ],
  ])("does not resolve %s", (_, source) => {
    expect(callees(source)).not.toContain(REGISTER);
  });

  it("keeps a member when only a sibling is written", () => {
    expect(
      callees(
        'const v = require("vscode"); v.commands.other = noop; v.commands.registerCommand("a", f);',
      ),
    ).toContain(REGISTER);
  });
});
