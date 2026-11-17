import { afterEach, expect, it, vi } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { JavaScriptSemanticWorkMeter } from "./javascriptSemanticWorkAllowance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** One member write after a few self-selections: one alias query. */
const query = (name: string): string =>
  [
    `function ${name}(input, env) { var m; if (env.first) m = env.first.info;`,
    ...Array.from(
      { length: 3 },
      (_, index) =>
        `if (/case${String(index)}/.test(input)) m = m[${String(index % 2)}];`,
    ),
    "m[1] = input.length; return m; }",
  ].join(" ");

const source = (count: number): string =>
  `${Array.from({ length: count }, (_, index) => query(`probe${String(index)}`)).join("\n")}\nmodule.exports = probe0;`;

/** The meters charged while analyzing each source, in order. */
const chargedMeters = (sources: readonly string[]) => {
  const meters: JavaScriptSemanticWorkMeter[] = [];
  const charge = JavaScriptSemanticWorkMeter.prototype.charge;
  vi.spyOn(JavaScriptSemanticWorkMeter.prototype, "charge").mockImplementation(
    function (this: JavaScriptSemanticWorkMeter, units?: number) {
      if (!meters.includes(this)) meters.push(this);
      charge.call(this, units);
    },
  );
  return sources.map((text) => {
    const before = meters.length;
    analyzeJavaScriptSemantics(text);
    return meters.slice(before);
  });
};

it("charges separate queries in one source against one meter", () => {
  const [meters] = chargedMeters([source(3)]);
  expect(meters).toHaveLength(1);
});

it("gives each source a fresh meter", () => {
  const [first, second] = chargedMeters([source(1), source(1)]);
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(second?.[0]).not.toBe(first?.[0]);
});
