import { describe, expect, it } from "vitest";

import {
  analyzeParsedJavaScriptSemanticsSteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "./javascriptStaticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

const sources = {
  module: `
    import fs, { readFile as read } from "node:fs";
    import * as path from "node:path";
    const shared = { x: 1, nested: { y: 2 } };
    const get = () => shared;
    export function touch(value) { get().x = value; shared.nested.y += 1; return shared; }
    export const load = async (name) => read(path.join(process.env.ROOT ?? ".", name));
    globalThis.registry = { fetch: (url) => fetch(url, { method: "POST" }) };
    export default class Box { #inner = shared; get value() { return this.#inner; } }
  `,
  commonJs: `
    const child = require("child_process");
    const { EventEmitter } = require("events");
    const bus = new EventEmitter();
    function run(command) { return child.spawn(command, [], { shell: true }); }
    module.exports = { run, bus };
    exports.later = () => new Promise((resolve) => setTimeout(resolve, 1));
    Object.prototype.extra = 1;
    for (const key in module.exports) bus.emit(key);
  `,
  wide: `export function wide(){const shared={x:1};const box={wide(){return {${Array.from(
    { length: 400 },
    (_, index) => `p${String(index)}:0`,
  ).join(",")},last:shared}},noop(){}};box.noop();return {x:shared.x,keep:7};}`,
};

const parse = (source: string) => {
  const parsed = parseJavaScriptSource(source, "app.js");
  if (parsed === null) throw new Error("Expected the fixture to parse");
  return parsed;
};

/** Both phases as the analysis worker runs them: one index, then each phase. */
const analyzeSharingIndex = (
  source: string,
  beforeSemantic?: (
    index: ReturnType<typeof indexFor>,
    parsed: ReturnType<typeof parse>,
  ) => void,
) => {
  const parsed = parse(source);
  const index = indexFor(parsed);
  const staticFacts = completeSemanticSteps(
    analyzeParsedJavaScriptStaticSourceSteps(
      source,
      parsed,
      undefined,
      undefined,
      index,
    ),
  );
  beforeSemantic?.(index, parsed);
  const semantic = completeSemanticSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      "import",
      undefined,
      undefined,
      undefined,
      index,
    ),
  );
  return { staticFacts, semantic };
};

const indexFor = (parsed: ReturnType<typeof parse>) =>
  completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );

/** Each phase builds a private index, as before the index was shared. */
const analyzeWithPrivateIndexes = (source: string) => {
  const parsed = parse(source);
  return {
    staticFacts: completeSemanticSteps(
      analyzeParsedJavaScriptStaticSourceSteps(source, parsed),
    ),
    semantic: completeSemanticSteps(
      analyzeParsedJavaScriptSemanticsSteps(parsed, "import"),
    ),
  };
};

describe("a lexical index shared by the static and semantic phases", () => {
  it.each(Object.entries(sources))(
    "yields the facts private indexes yield for the %s source",
    (_name, source) => {
      expect(analyzeSharingIndex(source)).toEqual(
        analyzeWithPrivateIndexes(source),
      );
    },
  );

  it("keeps an earlier consumer's observations out of the semantic phase", () => {
    const source = sources.module;
    const shared = analyzeSharingIndex(source, (index, parsed) => {
      // What a static-phase query records qualifies only static results.
      index.bindings.observations.valueResourceLimits.add("alias-selections");
      index.bindings.observations.getterResourceLimits.add("getter-expansion");
      index.bindings.observations.returnedReferenceWidenings.add(
        parsed.program,
      );
    });
    expect(shared.semantic).toEqual(analyzeWithPrivateIndexes(source).semantic);
  });

  it("gives the semantic phase what the index steps themselves observed", () => {
    const parsed = parse(sources.module);
    const index = indexFor(parsed);
    // An index step's observation belongs to the index, not to one consumer.
    index.bindings.indexObservations.valueResourceLimits.add(
      "alias-selections",
    );
    const semantic = completeSemanticSteps(
      analyzeParsedJavaScriptSemanticsSteps(
        parsed,
        "import",
        undefined,
        undefined,
        undefined,
        index,
      ),
    );
    expect(semantic.coverage.status).toBe("partial");
    expect(semantic.limitations.join(" ")).toMatch(/alias selection/iu);
  });

  it("continues one semantic phase and rejects a second", () => {
    // The phase appends its module links to the shared state; a second run
    // from the same index reported each link twice.
    const source = `import { x } from "pkg"; export const y = x;`;
    const parsed = parse(source);
    const index = indexFor(parsed);
    const continueFrom = () =>
      completeSemanticSteps(
        analyzeParsedJavaScriptSemanticsSteps(
          parsed,
          "import",
          undefined,
          undefined,
          undefined,
          index,
        ),
      );
    expect(continueFrom().moduleLinks).toEqual(
      analyzeWithPrivateIndexes(source).semantic.moduleLinks,
    );
    expect(continueFrom).toThrow(TypeError);
  });

  it("rejects an index built from different inputs", () => {
    const parsed = parse(sources.commonJs);
    const semanticFrom = (
      index: ReturnType<typeof indexFor>,
      mode: "import" | "require" = "import",
      precision?: Parameters<typeof analyzeParsedJavaScriptSemanticsSteps>[3],
    ) =>
      completeSemanticSteps(
        analyzeParsedJavaScriptSemanticsSteps(
          parsed,
          mode,
          undefined,
          precision,
          undefined,
          index,
        ),
      );
    // Another program, even one with identical text.
    expect(() => semanticFrom(indexFor(parse(sources.commonJs)))).toThrow(
      TypeError,
    );
    // Another resolution mode changes the definitions themselves.
    expect(() => semanticFrom(indexFor(parsed), "require")).toThrow(TypeError);
    // Another precision bounds evaluation differently.
    expect(() => semanticFrom(indexFor(parsed), "import", {})).toThrow(
      TypeError,
    );
    // A host-context index declares a binding the semantic phase does not.
    expect(() =>
      semanticFrom(
        completeSemanticSteps(
          indexJavaScriptBindingsWithReceiversSteps(
            parsed.program,
            "commonjs-wrapper",
          ),
        ),
      ),
    ).toThrow(TypeError);
    expect(semanticFrom(indexFor(parsed)).schema).toBe("JavaScriptSemanticIR");
  });
});
