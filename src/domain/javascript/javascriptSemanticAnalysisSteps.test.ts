import { expect, it } from "vitest";

import {
  analyzeParsedJavaScriptSemantics,
  analyzeParsedJavaScriptSemanticsSteps,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

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
  // Every top-level phase and derived collector is a separate step.
  expect(yields).toBeGreaterThanOrEqual(13);
  const reparsed = parseJavaScriptSource(source, "main.js");
  if (reparsed === null) throw new Error("Expected parsed source");
  expect(step.value).toEqual(analyzeParsedJavaScriptSemantics(reparsed));
});
