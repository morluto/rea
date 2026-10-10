import { expect, it } from "vitest";

import {
  analyzeParsedJavaScriptSemantics,
  analyzeParsedJavaScriptSemanticsSteps,
  classifyParsedJavaScriptElectronBindings,
  classifyParsedJavaScriptElectronBindingsSteps,
  classifyParsedJavaScriptOpenReceivers,
  classifyParsedJavaScriptOpenReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  traverseJavaScriptAst,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";

const source = `
import { readFile } from "node:fs";
const shared = { token: "TOKEN" };
export function load(path) {
  return new Promise((resolve) => setTimeout(() => resolve(readFile(path)), 1));
}
export const box = { get() { return shared; } };
box.get().value = process.env.MODE ?? "default";
`;

it("yields between semantic phases and returns the synchronous result (#1462)", () => {
  const parsed = parseJavaScriptSource(source, "main.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const steps = analyzeParsedJavaScriptSemanticsSteps(parsed);
  let yields = 0;
  let step = steps.next();
  while (step.done !== true) {
    yields += 1;
    step = steps.next();
  }
  expect(yields).toBeGreaterThan(0);
  const reparsed = parseJavaScriptSource(source, "main.js");
  if (reparsed === null) throw new Error("Expected parsed source");
  expect(step.value).toEqual(analyzeParsedJavaScriptSemantics(reparsed));
});

it("traverses a large tree in steps with the synchronous visit order (#1462)", () => {
  const parsed = parseJavaScriptSource(
    Array.from(
      { length: 400 },
      (_, index) => `const v${index} = [${index}];`,
    ).join("\n"),
    "large.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const visits = (record: string[]) => ({
    enter: (node: { readonly type: string }) => record.push(`+${node.type}`),
    exit: (node: { readonly type: string }) => record.push(`-${node.type}`),
  });
  const synchronous: string[] = [];
  traverseJavaScriptAst(parsed.program, visits(synchronous));
  const stepped: string[] = [];
  const steps = traverseJavaScriptAstSteps(parsed.program, visits(stepped));
  let yields = 0;
  while (steps.next().done !== true) yields += 1;
  expect(yields).toBeGreaterThan(0);
  expect(stepped).toEqual(synchronous);
});

it("preserves receiver and Electron alias scope across traversal pauses (#1462)", () => {
  const padding = Array.from(
    { length: 400 },
    (_, index) => `const v${index} = [${index}];`,
  ).join("\n");
  const text = `
import { BrowserWindow as NativeWindow } from "electron";
const ambient = window;
export function local(ambient, NativeWindow) {
  ${padding}
  ambient.open("/local");
  new NativeWindow();
}
ambient.open("/global");
new NativeWindow();
`;
  const parsed = parseJavaScriptSource(text, "receivers.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const openSteps = classifyParsedJavaScriptOpenReceiversSteps(parsed);
  let openStep = openSteps.next();
  expect(openStep.done).toBe(false);
  while (openStep.done !== true) openStep = openSteps.next();
  expect([...openStep.value]).toEqual([
    [text.indexOf('ambient.open("/local")'), "local"],
    [text.indexOf('ambient.open("/global")'), "window"],
  ]);
  expect(openStep.value).toEqual(classifyParsedJavaScriptOpenReceivers(parsed));

  const electronSteps = classifyParsedJavaScriptElectronBindingsSteps(parsed);
  let electronStep = electronSteps.next();
  expect(electronStep.done).toBe(false);
  while (electronStep.done !== true) electronStep = electronSteps.next();
  expect([...electronStep.value]).toEqual([
    [text.lastIndexOf("NativeWindow()"), "BrowserWindow"],
  ]);
  expect(electronStep.value).toEqual(
    classifyParsedJavaScriptElectronBindings(parsed),
  );
});
