import { createHash } from "node:crypto";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import type { JavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const defaultCall = "__vite__mapDeps([0])";

interface ViteScenario {
  readonly file: string;
  readonly source: string;
  readonly resolved: readonly string[];
  readonly unknown: boolean;
  readonly callSource?: string;
  readonly callSources?: readonly string[];
  readonly callOccurrences?: readonly number[];
  readonly unknownCallOccurrences?: readonly number[];
}

interface ExpectedCallRange {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

const expectedCallRanges = (scenario: ViteScenario): ExpectedCallRange[] => {
  const occurrences =
    scenario.callOccurrences ??
    (scenario.resolved.length === 0 && !scenario.unknown ? [] : [0]);
  const starts: { readonly offset: number; readonly callSource: string }[] = [];
  for (const callSource of scenario.callSources ?? [
    scenario.callSource ?? defaultCall,
  ]) {
    let cursor = 0;
    for (;;) {
      const offset = scenario.source.indexOf(callSource, cursor);
      if (offset === -1) break;
      starts.push({ offset, callSource });
      cursor = offset + callSource.length;
    }
  }
  starts.sort((left, right) => left.offset - right.offset);
  return occurrences.map((occurrence) => {
    const match = starts[occurrence];
    if (match === undefined)
      throw new Error(
        `fixture ${scenario.file} omitted authored call ${occurrence}`,
      );
    const before = scenario.source.slice(0, match.offset).split("\n");
    const column = before.at(-1)?.length ?? 0;
    return {
      start: { line: before.length, column },
      end: { line: before.length, column: column + match.callSource.length },
    };
  });
};

const expectedUnknownCallRanges = (
  scenario: ViteScenario,
  callRanges: readonly ExpectedCallRange[],
): readonly ExpectedCallRange[] =>
  scenario.unknownCallOccurrences?.map((index) => {
    const range = callRanges[index];
    if (range === undefined)
      throw new Error(`fixture ${scenario.file} omitted unknown call ${index}`);
    return range;
  }) ?? (scenario.unknown ? callRanges : []);

const mapDependencies = (table: string, indexes: string): string =>
  "const __vite__mapDeps = (i, m = __vite__mapDeps, d = " +
  "(m.f || (m.f = " +
  table +
  "))) => i.map(i => d[i]);\n" +
  "__vite__mapDeps(" +
  indexes +
  ");";

const expectUnknownImportExpression = (
  scenario: ViteScenario,
  properties: Readonly<Record<string, unknown>>,
): void => {
  expect.soft(properties, scenario.file).toMatchObject({
    specifier: null,
    expression: expect.any(String),
  });
  const expression = properties.expression;
  expect
    .soft(
      (scenario.callSources ?? [scenario.callSource ?? defaultCall]).some(
        (call) => typeof expression === "string" && expression.includes(call),
      ),
      scenario.file,
    )
    .toBe(true);
};

// captured with Babel core 8.0.7 and transform-arrow-functions 8.0.1.
const babelArrows = String.raw`const __vite__mapDeps = function (i, m = __vite__mapDeps, d = m.f || (m.f = ["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"])) {
  return i.map(function (i) {
    return d[i];
  });
};
__vite__mapDeps([0, 1, 2]);`;

// transform-parameters 8.0.5 and transform-block-scoping 8.0.7 added to the same producer.
const babelEs5 = String.raw`var __vite__mapDeps = function (i) {
  var m = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : __vite__mapDeps;
  var d = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : m.f || (m.f = ["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"]);
  return i.map(function (i) {
    return d[i];
  });
};
__vite__mapDeps([0, 1, 2]);`;

const typescriptEs5 = String.raw`var __vite__mapDeps = function (i, m, d) {
  if (m === void 0) m = __vite__mapDeps;
  if (d === void 0) d = m.f || (m.f = ["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"]);
  return i.map(function (i) {
    return d[i];
  });
};
__vite__mapDeps([0, 1, 2]);`;

const typescriptEs5Minified = typescriptEs5
  .replace(
    "if (m === void 0) m = __vite__mapDeps;",
    "m === void 0 && (m = __vite__mapDeps);",
  )
  .replace(
    'if (d === void 0) d = m.f || (m.f = ["./caf\\u00e9.js", \'./nested\\/dep.js\', "./bracket].js"]);',
    'd === void 0 && (d = m.f || (m.f = ["./caf\\u00e9.js", \'./nested\\/dep.js\', "./bracket].js"]));',
  );

const typescriptEs5ReversedGuard = typescriptEs5Minified
  .replace(
    "m === void 0 && (m = __vite__mapDeps);",
    "void 0 === m && (m = __vite__mapDeps);",
  )
  .replace(
    "d === void 0 && (d = m.f || (m.f =",
    "void 0 === d && (d = m.f || (m.f =",
  );

const typescriptSequence =
  'const __vite__mapDeps = function(i, m, d) { return void 0 === m && (m = __vite__mapDeps), void 0 === d && (d = m.f || (m.f = ["./first.js"])), i.map(j => d[j]); }; __vite__mapDeps([0]);';

const mapDependenciesWithEffects = (
  body: string,
  table = '["./first.js"]',
): string => mapDependencies(table, "[0]").replace(defaultCall + ";", body);

const initializeCache = "const initialize = __vite__mapDeps; initialize([]); ";

const allScenarios: readonly ViteScenario[] = [
  ...["constructor", "__proto__"].map((key): ViteScenario => {
    const call = `__vite__mapDeps([${JSON.stringify(key)}], void 0, {[${JSON.stringify(key)}]: {}})`;
    return {
      file: `owned-computed-${key}-value.js`,
      source: mapDependenciesWithEffects(
        `const values = ${call}; opaque(values); ${defaultCall};`,
      ),
      callSources: [call, defaultCall],
      callOccurrences: [0, 1],
      unknownCallOccurrences: [0],
      resolved: ["first.js"],
      unknown: true,
    };
  }),
  ...[
    "Array.name",
    "Object.name",
    "Array.length",
    "Object.length",
    "Array.prototype.length",
    "Array.prototype.constructor.name",
  ].map((value): ViteScenario => ({
    file: `intrinsic-primitive-${value.replaceAll(".", "-")}.js`,
    source: mapDependenciesWithEffects(
      `console.log(${value}); ${defaultCall};`,
    ),
    resolved: ["first.js"],
    unknown: false,
  })),
  {
    file: "changed-intrinsic-name-escape.js",
    source: mapDependenciesWithEffects(
      `Object.defineProperty(Array, "name", {value: Array.prototype}); console.log(Array.name); ${defaultCall};`,
    ),
    resolved: [],
    unknown: true,
  },
  ...[
    ["label", "__vite__mapDeps.f.label = 1;", true],
    [
      "unselected-prototype",
      "__vite__mapDeps.f.label = Array.prototype;",
      true,
    ],
    ["selected-prototype", "__vite__mapDeps.f[0] = Array.prototype;", false],
    ["unknown-property", "__vite__mapDeps.f[key] = Array.prototype;", false],
  ].map(([name, write, kept]): ViteScenario => ({
    file: `mapped-cache-${name}-escape.js`,
    source: mapDependenciesWithEffects(
      `${initializeCache}${write} opaque(${defaultCall}); ${defaultCall};`,
    ),
    callOccurrences: [0, 1],
    resolved: kept ? ["first.js", "first.js"] : [],
    unknown: !kept,
  })),
  {
    file: "independent-inherited-prototype-copy.js",
    source: mapDependenciesWithEffects(
      'const proto=__vite__mapDeps(["__proto__"])[0]; const copy={...proto}; opaque(copy); __vite__mapDeps([0]);',
    ),
    callSources: ['__vite__mapDeps(["__proto__"])', defaultCall],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "conditional-inherited-prototype-copy.js",
    source: mapDependenciesWithEffects(
      'const proto=__vite__mapDeps(["__proto__"])[0]; if (flag) proto.extra=proto; const copy={...proto}; opaque(copy); __vite__mapDeps([0]);',
    ),
    callSources: ['__vite__mapDeps(["__proto__"])', defaultCall],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  },
  {
    file: "unknown-prototype-descriptor.js",
    source: mapDependenciesWithEffects(
      'Object.defineProperty(Array.prototype, "foo", externalDescriptor); __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "intrinsic-prototype-escapes.js",
    source: mapDependenciesWithEffects(
      "const box = {value: Array.prototype}; opaque(box); __vite__mapDeps([0]);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "owned-independent-constructor.js",
    source: mapDependenciesWithEffects(
      'const values = __vite__mapDeps(["constructor"], void 0, {constructor: {}}); opaque(values); __vite__mapDeps([0]);',
    ),
    callSources: [
      '__vite__mapDeps(["constructor"], void 0, {constructor: {}})',
      defaultCall,
    ],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "own-arbitrary-prototype-value.js",
    source: mapDependenciesWithEffects(
      'const values = __vite__mapDeps(["foo"], void 0, {foo: Array.prototype}); opaque(values); __vite__mapDeps([0]);',
    ),
    callSources: [
      '__vite__mapDeps(["foo"], void 0, {foo: Array.prototype})',
      defaultCall,
    ],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  },
  {
    file: "harmless-parameter-property-keys.js",
    source: mapDependencies('["./first.js", {i: 0, arguments: 1}]', "[0]"),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "inherited-prototype-map-write.js",
    source: mapDependenciesWithEffects(
      'const key = "__proto__"; const proto = __vite__mapDeps([key])[0]; proto.map = () => ["./last.js"]; __vite__mapDeps([0]);',
      '["./first.js", "./last.js"]',
    ),
    callSources: ["__vite__mapDeps([key])", "__vite__mapDeps([0])"],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  },
  {
    file: "array-spread-omits-named-cache.js",
    source: mapDependenciesWithEffects(
      initializeCache +
        'const items = ["text"]; items.extra = __vite__mapDeps.f; const copy = [...items]; opaque(copy); __vite__mapDeps([0]);',
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "object-spread-copies-named-cache.js",
    source: mapDependenciesWithEffects(
      initializeCache +
        'const items = ["text"]; items.extra = __vite__mapDeps.f; const copy = {...items}; opaque(copy); __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "babel-default-reassigns-index.js",
    source: `function __vite__mapDeps(i) {
      var m = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : __vite__mapDeps;
      var d = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : (m.f || (m.f = [(i = []), "./first.js"]));
      return i.map(function (n) { return d[n]; });
    } __vite__mapDeps([1]);`,
    callSource: "__vite__mapDeps([1])",
    resolved: [],
    unknown: true,
  },
  {
    file: "for-of-cache-object-value-escape.js",
    callOccurrences: [0, 1],
    source:
      mapDependencies('["./first.js", m]', "[0]") +
      "\nfor (const value of __vite__mapDeps.f) { opaque(value); } __vite__mapDeps([0]);",
    resolved: [],
    unknown: true,
  },
  {
    file: "escaped.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: mapDependencies(
      String.raw`["./caf\u00e9.js", './nested\/dep.js', "./bracket].js"]`,
      "[0, 1, 2]",
    ),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-es5.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: typescriptEs5,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-es5-minified.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: typescriptEs5Minified,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-es5-reversed-guards.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: typescriptEs5ReversedGuard,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-sequence.js",
    source: typescriptSequence,
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "typescript-sequence-reversed.js",
    source: typescriptSequence
      .replace("void 0 === m", "m === void 0")
      .replace("void 0 === d", "d === void 0"),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "typescript-return-sequence.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: typescriptEs5ReversedGuard.replace(
      /void 0 === m && \(m = __vite__mapDeps\);\s*void 0 === d && \(d = ([\s\S]*?)\);\s*return ([^;]+);/u,
      "return void 0 === m && (m = __vite__mapDeps), void 0 === d && (d = $1), $2;",
    ),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "typescript-hybrid-guards.js",
    source:
      'const __vite__mapDeps = function(i, m, d) { if (void 0 === m) m = __vite__mapDeps; return void 0 === d && (d = m.f || (m.f = ["./first.js"])), i.map(j => d[j]); }; __vite__mapDeps([0]);',
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "typescript-comma-joined-guards.js",
    source:
      'function __vite__mapDeps(i, m, d) { m === void 0 && (m = __vite__mapDeps), d === void 0 && (d = m.f || (m.f = ["./first.js"])); return i.map(j => d[j]); } __vite__mapDeps([0]);',
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "typescript-nested-return-sequence.js",
    source:
      'const __vite__mapDeps = (i, m, d) => ((m === void 0 && (m = __vite__mapDeps), d === void 0 && (d = m.f || (m.f = ["./first.js"]))), i.map(j => d[j])); __vite__mapDeps([0]);',
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "typescript-extra-guard-operation.js",
    source:
      'function __vite__mapDeps(i, m, d) { runtimeEffect(), m === void 0 && (m = __vite__mapDeps), d === void 0 && (d = m.f || (m.f = ["./first.js"])); return i.map(j => d[j]); } __vite__mapDeps([0]);',
    resolved: [],
    unknown: false,
  },
  {
    file: "template-literal-table-slots.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: mapDependencies(
      "[`./caf\\u00e9.js`, `./${runtimeName}.js`, `./last.js`]",
      "[0, 1, 2]",
    ),
    resolved: ["café.js", "last.js"],
    unknown: true,
  },
  {
    file: "dynamic.js",
    callSource: "__vite__mapDeps([1, 2])",
    source: mapDependencies(
      '["./first.js", runtimeUrl("./decoy.js"), "./last.js"]',
      "[1, 2]",
    ),
    resolved: ["last.js"],
    unknown: true,
  },
  ...[
    {
      file: "returned-table-helper-escape.js",
      entry: "m",
      mutation: 'alias.f[0] = "./last.js";',
    },
    {
      file: "returned-table-wrapper-helper-escape.js",
      entry: "{helper: m}",
      mutation: 'alias.helper.f[0] = "./last.js";',
    },
    {
      file: "returned-table-nested-wrapper-helper-escape.js",
      entry: "{box: {helper: m}}",
      mutation: 'alias.box.helper.f[0] = "./last.js";',
    },
    {
      file: "returned-table-getter-helper-escape.js",
      entry: "{get helper() { return m; }}",
      mutation:
        'function mutate(box) { box.helper.f[0] = "./last.js"; } mutate(alias);',
    },
    {
      file: "returned-table-function-helper-escape.js",
      entry: "() => m",
      mutation: 'alias().f[0] = "./last.js";',
    },
    {
      file: "returned-table-call-helper-escape.js",
      entry: "runtimeObject(m)",
      mutation: 'alias.f[0] = "./last.js";',
    },
  ].map(({ file, entry, mutation }): ViteScenario => ({
    file,
    callSources: ["__vite__mapDeps([1])", defaultCall],
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", ' + entry + "]", "[1]").replace(
      "__vite__mapDeps([1]);",
      "const alias = __vite__mapDeps([1])[0]; " +
        mutation +
        " " +
        defaultCall +
        ";",
    ),
    resolved: [],
    unknown: true,
  })),
  {
    file: "returned-assigned-table-helper-escape.js",
    callSources: [defaultCall, "__vite__mapDeps([1])"],
    callOccurrences: [0, 1, 2],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      '\n__vite__mapDeps.f[1] = __vite__mapDeps; const alias = __vite__mapDeps([1])[0]; alias.f[0] = "./last.js"; __vite__mapDeps([0]);',
    resolved: [],
    unknown: true,
  },
  ...[
    {
      file: "returned-variable-index-string-log.js",
      setup: "const index = 0;",
      indexes: "[index]",
      after: "",
      kept: true,
    },
    {
      file: "returned-spread-index-string-log.js",
      setup: "const indexes = [0];",
      indexes: "[...indexes]",
      after: "",
      kept: true,
    },
    {
      file: "returned-variable-index-string-log-before-copy.js",
      setup: "const index = 0;",
      indexes: "[index]",
      after: "Object.assign({}, __vite__mapDeps);",
      kept: true,
    },
    {
      file: "returned-variable-index-named-cache-log.js",
      setup:
        '__vite__mapDeps.f.owned = __vite__mapDeps.f; const index = "owned";',
      indexes: "[index]",
      after: "",
      kept: false,
    },
    {
      file: "returned-variable-index-written-cache-log.js",
      setup: "__vite__mapDeps.f[1] = __vite__mapDeps.f; const index = 1;",
      indexes: "[index]",
      after: "",
      kept: false,
    },
  ].map(({ file, setup, indexes, after, kept }): ViteScenario => {
    const call = `__vite__mapDeps(${indexes})`;
    return {
      file,
      callSources: [defaultCall, call],
      callOccurrences: [0, 1, 2],
      ...(kept ? { unknownCallOccurrences: [1] } : {}),
      source:
        mapDependencies('["./first.js"]', "[0]") +
        `\n${setup} const paths = ${call}; for (const path of paths) console.log(path); ${after} ${defaultCall};`,
      resolved: kept ? ["first.js", "first.js"] : [],
      unknown: true,
    };
  }),
  {
    file: "returned-named-cache-property-helper-escape.js",
    callSources: [defaultCall, '__vite__mapDeps(["owned"])'],
    callOccurrences: [0, 1, 2],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      '\n__vite__mapDeps.f.owned = __vite__mapDeps; const alias = __vite__mapDeps(["owned"])[0]; alias.f[0] = "./last.js"; __vite__mapDeps([0]);',
    resolved: [],
    unknown: true,
  },
  {
    file: "returned-independent-named-cache-property.js",
    callSources: [defaultCall, '__vite__mapDeps(["owned"])'],
    callOccurrences: [0, 1, 2],
    unknownCallOccurrences: [1],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      '\n__vite__mapDeps.f.owned = {}; const alias = __vite__mapDeps(["owned"])[0]; alias.value = "./last.js"; __vite__mapDeps([0]);',
    resolved: ["first.js", "first.js"],
    unknown: true,
  },
  {
    file: "returned-custom-table-helper-escape.js",
    callSources: [defaultCall, "__vite__mapDeps([1], void 0, table)"],
    callOccurrences: [0, 1, 2],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      '\nconst table = [null, __vite__mapDeps]; const alias = __vite__mapDeps([1], void 0, table)[0]; alias.f[0] = "./last.js"; __vite__mapDeps([0]);',
    resolved: [],
    unknown: true,
  },
  ...[
    {
      file: "returned-explicit-independent-table.js",
      setup: "",
      call: "__vite__mapDeps([1], void 0, [null, {}])",
      kept: true,
    },
    {
      file: "returned-explicit-independent-table-alias.js",
      setup: "const table = [null, {}];",
      call: "__vite__mapDeps([1], void 0, table)",
      kept: true,
    },
    {
      file: "returned-explicit-shared-helper-table.js",
      setup: "",
      call: "__vite__mapDeps([1], void 0, [null, __vite__mapDeps])",
      kept: false,
    },
    {
      file: "returned-shadowed-undefined-table.js",
      setup: "const undefined = runtimeTable;",
      call: "__vite__mapDeps([1], void 0, undefined)",
      kept: false,
    },
    {
      file: "returned-conditional-default-table.js",
      setup: "const table = runtimeChoice ? void 0 : [null, {}];",
      call: "__vite__mapDeps([1], void 0, table)",
      kept: false,
    },
    {
      file: "returned-explicit-mapper-independent-table.js",
      setup: "",
      call: "__vite__mapDeps([1], {}, [null, {}])",
      kept: true,
    },
    {
      file: "returned-explicit-independent-mapper-cache.js",
      setup: "const mapper = {f: [null, {}]};",
      call: "__vite__mapDeps([1], mapper)",
      kept: true,
    },
    {
      file: "returned-unproven-mapper-cache.js",
      setup: "",
      call: "__vite__mapDeps([1], runtimeMapper)",
      kept: false,
    },
  ].map(({ file, setup, call, kept }): ViteScenario => ({
    file,
    callSources: [call, defaultCall],
    callOccurrences: [0, 1],
    ...(kept ? { unknownCallOccurrences: [0] } : {}),
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      setup +
        " const alias = " +
        call +
        "[0]; alias.f = []; " +
        defaultCall +
        ";",
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: true,
  })),
  {
    file: "returned-supplied-table-getter-slot.js",
    callSources: ["__vite__mapDeps([0], void 0, table)", defaultCall],
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      'const table = {cache: __vite__mapDeps.f,\n  get 0() { this.cache[0] = "./last.js"; return 0; }};\n__vite__mapDeps([0], void 0, table); ' +
        defaultCall +
        ";",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "returned-mapper-getter-slot.js",
    callSources: ["__vite__mapDeps([0], mapper)", defaultCall],
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      'const mapper = {cache: __vite__mapDeps.f,\n  get f() { this.cache[0] = "./last.js"; return [null, {}]; }};\n__vite__mapDeps([0], mapper); ' +
        defaultCall +
        ";",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "custom-index-map-callback-cache-mutation.js",
    callSources: [
      '__vite__mapDeps({map(read) { read(1).f[0] = "./last.js"; return []; }})',
      defaultCall,
    ],
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      '__vite__mapDeps({map(read) { read(1).f[0] = "./last.js"; return []; }}); ' +
        defaultCall +
        ";",
    ),
    resolved: [],
    unknown: true,
  },
  ...[
    ["uninitialized", "let table;"],
    ["conditional", "const table = runtimeFlag ? [null, {}] : undefined;"],
    ["cyclic", "var table = other, other = table;"],
  ].map(([name, declaration]): ViteScenario => ({
    file: `custom-index-map-${name}-table.js`,
    callSources: [
      '__vite__mapDeps({map(read) { read(1).f[0] = "./last.js"; return []; }}, void 0, table)',
      defaultCall,
    ],
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      declaration +
        '\n__vite__mapDeps({map(read) { read(1).f[0] = "./last.js"; return []; }}, void 0, table); ' +
        defaultCall +
        ";",
    ),
    resolved: [],
    unknown: true,
  })),
  ...[false, true].map((independent): ViteScenario => {
    const call =
      '__vite__mapDeps({map(read) { Object.defineProperty(read("__proto__"), "cache", {get() { return this; }}); read("cache")[0] = "./last.js"; return []; }}' +
      (independent ? ', void 0, ["./other.js"]' : "") +
      ")";
    return {
      file: `custom-index-map-inherited-${independent ? "independent" : "default"}-table.js`,
      callSources: [defaultCall, call],
      callOccurrences: [0, 1, 2],
      ...(independent ? { unknownCallOccurrences: [1] } : {}),
      source:
        mapDependencies('["./first.js"]', "[0]") +
        "\n" +
        call +
        "; " +
        defaultCall +
        ";",
      resolved: independent ? ["first.js", "first.js"] : [],
      unknown: true,
    };
  }),
  {
    file: "custom-index-map-independent-later-slot-write.js",
    callSources: [
      defaultCall,
      "__vite__mapDeps({map(read) { return []; }}, void 0, table)",
    ],
    callOccurrences: [0, 1, 2],
    unknownCallOccurrences: [1],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      "\nconst table = [null, {}]; __vite__mapDeps({map(read) { return []; }}, void 0, table); table[1].x = 1; __vite__mapDeps([0]);",
    resolved: ["first.js", "first.js"],
    unknown: true,
  },
  {
    file: "opaque-independent-later-slot-write.js",
    callSource: defaultCall,
    callOccurrences: [0, 1],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      "\nconst table = [null, {}]; opaque(table); table[1].x = 1; __vite__mapDeps([0]);",
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  {
    file: "custom-index-map-shared-later-slot-write-owner-scope.js",
    callSources: [
      defaultCall,
      "__vite__mapDeps({map(read) { return []; }}, void 0, table)",
    ],
    callOccurrences: [0, 1, 2],
    unknownCallOccurrences: [0, 1],
    source:
      mapDependencies('["./first.js"]', "[0]") +
      "\nconst table = [null, __vite__mapDeps]; __vite__mapDeps({map(read) { return []; }}, void 0, table); table[1].x = 1;\n{\n" +
      mapDependencies('["./last.js"]', "[0]") +
      "\n}",
    resolved: ["last.js"],
    unknown: true,
  },
  {
    file: "custom-index-map-independent-table.js",
    callSources: [
      "__vite__mapDeps({map(read) { return []; }}, void 0, [null, {}])",
      defaultCall,
    ],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      "__vite__mapDeps({map(read) { return []; }}, void 0, [null, {}]); " +
        defaultCall +
        ";",
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "custom-index-map-independent-mapper.js",
    callSources: [
      "__vite__mapDeps({map(read) { return []; }}, {f: [null, {}]})",
      defaultCall,
    ],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      "__vite__mapDeps({map(read) { return []; }}, {f: [null, {}]}); " +
        defaultCall +
        ";",
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "inert-negative-index-entry.js",
    callSource: "__vite__mapDeps([0, -1, 1])",
    source: mapDependencies('["./first.js", "./last.js"]', "[0, -1, 1]"),
    resolved: ["first.js", "last.js"],
    unknown: true,
  },
  {
    file: "returned-cyclic-table-default.js",
    callSources: ["__vite__mapDeps([1], void 0, a)", defaultCall],
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      'var a = b, b = a; const alias = __vite__mapDeps([1], void 0, a)[0]; alias.f[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "custom-index-map-override-table-cache-mutation.js",
    callSources: [
      defaultCall,
      '__vite__mapDeps({map(fn) { fn(1).f[0] = "./last.js"; return []; }}, void 0, [null, __vite__mapDeps])',
    ],
    callOccurrences: [0, 1, 2],
    source:
      mapDependencies('["./first.js", m]', "[0]") +
      '\n__vite__mapDeps({map(fn) { fn(1).f[0] = "./last.js"; return []; }}, void 0, [null, __vite__mapDeps]); __vite__mapDeps([0]);',
    resolved: [],
    unknown: true,
  },
  {
    file: "returned-independent-table-object.js",
    callSources: ["__vite__mapDeps([1])", defaultCall],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    source: mapDependencies('["./first.js", {data: []}]', "[1]").replace(
      "__vite__mapDeps([1]);",
      'const alias = __vite__mapDeps([1])[0]; alias.data[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "returned-table-string-container-replacement.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      defaultCall + ";",
      'const box = {value: __vite__mapDeps([0])[0]}; box.value = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  {
    file: "returned-table-string-with-unselected-helper-escape.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      "const path = __vite__mapDeps([0])[0]; opaque(path); __vite__mapDeps([0]);",
    ),
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  {
    file: "returned-table-array-with-unselected-helper-replacement.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", m]', "[0]").replace(
      defaultCall + ";",
      'const paths = __vite__mapDeps([0]); paths[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  {
    file: "returned-mixed-table-array-selected-string-escape.js",
    callSources: ["__vite__mapDeps([0, 1])", defaultCall],
    callOccurrences: [0, 0, 1],
    unknownCallOccurrences: [1],
    source: mapDependencies('["./first.js", m]', "[0, 1]").replace(
      "__vite__mapDeps([0, 1]);",
      "const values = __vite__mapDeps([0, 1]); opaque(values[0]); __vite__mapDeps([0]);",
    ),
    resolved: ["first.js", "first.js"],
    unknown: true,
  },
  {
    file: "returned-table-array-helper-detachment.js",
    callSources: ["__vite__mapDeps([1])", defaultCall],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    source: mapDependencies('["./first.js", m]', "[1]").replace(
      "__vite__mapDeps([1]);",
      'const values = __vite__mapDeps([1]); values[0] = {}; values[0].f = []; values[0].f[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "sparse.js",
    callSource: "__vite__mapDeps([1, 2])",
    source: mapDependencies('["./first.js", , "./last.js"]', "[1, 2]"),
    resolved: ["last.js"],
    unknown: true,
  },
  {
    file: "spread.js",
    callSource: "__vite__mapDeps([0, 2])",
    source: mapDependencies(
      '["./first.js", ...runtimeUrls, "./last.js"]',
      "[0, 2]",
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "scoped.js",
    callOccurrences: [0, 1],
    source:
      "{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\n}",
    resolved: ["left.js", "right.js"],
    unknown: false,
  },
  {
    file: "comment.js",
    source:
      '// decoy.f || (decoy.f = ["./decoy.js"])\n' +
      mapDependencies('["./last.js"]', "[0]"),
    resolved: ["last.js"],
    unknown: false,
  },
  {
    file: "shadowed.js",
    source:
      mapDependencies('["./left.js"]', "[0]") +
      "\nfunction unrelated(__vite__mapDeps) { __vite__mapDeps([0]); }",
    resolved: ["left.js"],
    unknown: false,
  },
  {
    file: "cache.js",
    source: mapDependencies('["./left.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps.f = runtimeUrls;\n__vite__mapDeps([0]);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "overridden.js",
    callSource: "__vite__mapDeps([0], runtimeMapper)",
    source: mapDependencies('["./left.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], runtimeMapper);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "indices.js",
    callSource: "__vite__mapDeps([0, runtimeIndex])",
    source: mapDependencies('["./first.js", "./last.js"]', "[0, runtimeIndex]"),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "unrelated.js",
    source: mapDependencies('["./decoy.js"]', "[0]").replace(
      "i.map(i => d[i])",
      '["./first.js"]',
    ),
    resolved: [],
    unknown: false,
  },
  {
    file: "reassigned.js",
    source: mapDependencies('["./left.js"]', "[0]")
      .replace("const __vite__mapDeps", "let __vite__mapDeps")
      .replace(
        "__vite__mapDeps([0]);",
        "__vite__mapDeps = runtimeMapper;\n__vite__mapDeps([0]);",
      ),
    resolved: [],
    unknown: true,
  },
  {
    file: "self-shadowed.js",
    source: mapDependencies('["./decoy.js"]', "[0]")
      .replace("d = (m.f", "__vite__mapDeps = (m.f")
      .replace("d[i]", "__vite__mapDeps[i]"),
    resolved: [],
    unknown: false,
  },
  {
    file: "chained-filter.js",
    source: mapDependencies('["./first.js", "./last.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0]).filter(Boolean);",
    ),
    resolved: ["first.js"],
    unknown: false,
    callSource: "__vite__mapDeps([0])",
  },
  {
    file: "chained-concat.js",
    source: mapDependencies('["./first.js", "./last.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0]).concat([1]);",
    ),
    resolved: ["first.js"],
    unknown: false,
    callSource: "__vite__mapDeps([0])",
  },
  {
    file: "void-default.js",
    callSource: "__vite__mapDeps([0], void 0)",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], void 0);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "undefined-defaults.js",
    callSource: "__vite__mapDeps([0], undefined, void 0)",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], undefined, void 0);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "shadowed-undefined.js",
    callSource: "__vite__mapDeps([0], undefined)",
    source:
      "{\nconst undefined = runtimeMapper;\n" +
      mapDependencies('["./first.js"]', "[0]").replace(
        "__vite__mapDeps([0]);",
        "__vite__mapDeps([0], undefined);",
      ) +
      "\n}",
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-void.js",
    callSource: "__vite__mapDeps([0], void mutateCache(__vite__mapDeps))",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      'function mutateCache(target) { target.f = ["./last.js"]; }\n' +
        "__vite__mapDeps([0], void mutateCache(__vite__mapDeps));",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "table-override.js",
    callSource: "__vite__mapDeps([0], void 0, runtimeUrls)",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0], void 0, runtimeUrls);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-extra.js",
    callSource:
      "__vite__mapDeps([0], void 0, void 0, mutateCache(__vite__mapDeps))",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      'function mutateCache(target) { target.f = ["./last.js"]; }\n' +
        "__vite__mapDeps([0], void 0, void 0, mutateCache(__vite__mapDeps));",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "babel-arrows.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelArrows,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "babel-es5.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5,
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "babel-es5-reversed-sentinel.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5
      .replace("arguments[1] !== undefined", "void 0 !== arguments[1]")
      .replace("arguments[2] !== undefined", "void 0 !== arguments[2]"),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "babel-es5-reversed-undefined.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5
      .replace("arguments[1] !== undefined", "undefined !== arguments[1]")
      .replace("arguments[2] !== undefined", "undefined !== arguments[2]"),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  {
    file: "babel-es5-reversed-length.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5
      .replace(
        "arguments.length > 1 && arguments[1] !== undefined",
        "1 < arguments.length && void 0 !== arguments[1]",
      )
      .replace(
        "arguments.length > 2 && arguments[2] !== undefined",
        "2 < arguments.length && void 0 !== arguments[2]",
      ),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  },
  ...[
    {
      file: "babel-es5-reversed-length-undefined-right.js",
      sentinel: "arguments[$index] !== undefined",
    },
    {
      file: "babel-es5-reversed-length-undefined-left.js",
      sentinel: "undefined !== arguments[$index]",
    },
    {
      file: "babel-es5-reversed-length-void-right.js",
      sentinel: "arguments[$index] !== void 0",
    },
  ].map(({ file, sentinel }): ViteScenario => ({
    file,
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5
      .replace(
        "arguments.length > 1 && arguments[1] !== undefined",
        "1 < arguments.length && " + sentinel.replace("$index", "1"),
      )
      .replace(
        "arguments.length > 2 && arguments[2] !== undefined",
        "2 < arguments.length && " + sentinel.replace("$index", "2"),
      ),
    resolved: ["café.js", "nested/dep.js", "bracket].js"],
    unknown: false,
  })),
  ...[
    {
      file: "babel-es5-off-by-one-length.js",
      guard: "arguments.length >= $index",
    },
    {
      file: "babel-es5-reversed-off-by-one-length.js",
      guard: "$index >= arguments.length",
    },
  ].map(({ file, guard }): ViteScenario => ({
    file,
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5
      .replace("arguments.length > 1", guard.replace("$index", "1"))
      .replace("arguments.length > 2", guard.replace("$index", "2")),
    resolved: [],
    unknown: false,
  })),
  {
    file: "babel-shadowed-guard.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: "{\nconst undefined = runtimeSentinel;\n" + babelEs5 + "\n}",
    resolved: [],
    unknown: true,
  },
  {
    file: "babel-shadowed-arguments.js",
    callSource: "__vite__mapDeps([0, 1, 2])",
    source: babelEs5
      .replace("function (i)", "function (arguments)")
      .replace("return i.map", "return arguments.map"),
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-index.js",
    callSource: "__vite__mapDeps([0, mutateCache(__vite__mapDeps)])",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      'function mutateCache(target) { target.f = ["./last.js"]; return 0; }\n' +
        "__vite__mapDeps([0, mutateCache(__vite__mapDeps)]);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "index-getter.js",
    callSource: "__vite__mapDeps([0, runtimeIndices.next])",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "__vite__mapDeps([0, runtimeIndices.next]);",
    ),
    resolved: [],
    unknown: true,
  },
  ...[
    {
      file: "readonly-descriptor-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperty(box, "f", {value: __vite__mapDeps.f}); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "explicit-readonly-descriptor-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperty(box, "f", {value: __vite__mapDeps.f, writable: false, configurable: true}); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "readonly-descriptors-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperties(box, {f: {value: __vite__mapDeps.f}}); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "frozen-holder-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; Object.freeze(box); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "frozen-deferred-receiver-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const inner = {cache: __vite__mapDeps.f}; const box = {}; box.object = inner; Object.freeze(box.object); inner.cache = []; inner.cache[0] = "./last.js";',
    },
    {
      file: "frozen-returned-holder-cache.js",
      mutation:
        '__vite__mapDeps([0]); const box = Object.freeze({f: __vite__mapDeps.f}); box.f[0] = "./last.js";',
    },
    {
      file: "sealed-inherited-cache-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const prototype = {f: __vite__mapDeps.f}; const box = Object.create(prototype); Object.seal(box); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "nonextensible-inherited-cache-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const prototype = {f: __vite__mapDeps.f}; const box = Object.create(prototype); Object.preventExtensions(box); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "readonly-prototype-cache-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const prototype = {}; Object.defineProperty(prototype, "f", {value: __vite__mapDeps.f}); const box = Object.create(prototype); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "writable-data-property-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; const alias = box; alias.cache = []; box.cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "writable-descriptor-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperty(box, "f", {value: __vite__mapDeps.f, writable: true}); box.f = []; box.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "sealed-writable-data-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; Object.seal(box); box.f = []; box.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "nonextensible-writable-data-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; Object.preventExtensions(box); box.f = []; box.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "writable-data-earlier-capture.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; const retained = box.cache; const alias = box; alias.cache = []; retained[0] = "./last.js";',
    },
    {
      file: "object-destructuring-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; ({cache: box.cache} = {cache: __vite__mapDeps.f}); box.cache[0] = "./last.js";',
    },
    {
      file: "array-destructuring-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; [box.cache] = [__vite__mapDeps.f]; box.cache[0] = "./last.js";',
    },
    {
      file: "nested-destructuring-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; ({nested: {cache: box.cache}} = {nested: {cache: __vite__mapDeps.f}}); box.cache[0] = "./last.js";',
    },
    {
      file: "default-destructuring-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; ({cache: box.cache = __vite__mapDeps.f} = {}); box.cache[0] = "./last.js";',
    },
    {
      file: "conditional-destructuring-member-source.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const source = runtimeCondition ? {cache: __vite__mapDeps.f} : {}; ({cache: box.cache} = source); box.cache[0] = "./last.js";',
    },
    {
      file: "for-of-destructuring-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; for ({cache: box.cache} of [{cache: __vite__mapDeps.f}]) {} box.cache[0] = "./last.js";',
    },
    {
      file: "for-of-cache-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; for (box.cache of [__vite__mapDeps.f]) {} box.cache[0] = "./last.js";',
    },
    {
      file: "object-rest-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; ({...box.rest} = {cache: __vite__mapDeps.f}); box.rest.cache[0] = "./last.js";',
    },
    {
      file: "independent-destructuring-member-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; ({cache: box.cache} = {cache: []}); box.cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "object-destructuring-cache-assignment.js",
      mutation:
        '__vite__mapDeps([0]); let cache; ({cache} = {cache: __vite__mapDeps.f}); cache[0] = "./last.js";',
    },
    {
      file: "array-destructuring-cache-assignment.js",
      mutation:
        '__vite__mapDeps([0]); let cache; [cache] = [__vite__mapDeps.f]; cache[0] = "./last.js";',
    },
    {
      file: "deferred-function-cache-restoration.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; function restore() { copy.f = __vite__mapDeps.f; } copy.f = []; restore(); copy.f[0] = "./last.js";',
    },
    {
      file: "deferred-arrow-cache-restoration.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const restore = () => { copy.f = __vite__mapDeps.f; }; copy.f = []; restore(); copy.f[0] = "./last.js";',
    },
    {
      file: "deferred-method-cache-restoration.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const actions = {restore() { copy.f = __vite__mapDeps.f; }}; copy.f = []; actions.restore(); copy.f[0] = "./last.js";',
    },
    {
      file: "ordinary-wrapper-returned-cache.js",
      mutation:
        '__vite__mapDeps([0]); function expose() { return __vite__mapDeps.f; } const cache = expose(); cache[0] = "./last.js";',
    },
    {
      file: "arrow-wrapper-returned-cache.js",
      mutation:
        '__vite__mapDeps([0]); const expose = () => __vite__mapDeps.f; const cache = expose(); cache[0] = "./last.js";',
    },
    {
      file: "getter-returned-cache.js",
      mutation:
        '__vite__mapDeps([0]); const box = {get cache() { return __vite__mapDeps.f; }}; const cache = box.cache; cache[0] = "./last.js";',
    },
    {
      file: "ordinary-wrapper-returned-container.js",
      mutation:
        '__vite__mapDeps([0]); function expose() { return {cache: __vite__mapDeps.f}; } const box = expose(); box.cache[0] = "./last.js";',
    },
    {
      file: "independent-wrapper-return.js",
      mutation:
        '__vite__mapDeps([0]); const expose = () => []; const cache = expose(); cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "tagged-template-cache-argument.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(_strings, cache) { cache[0] = "./last.js"; } mutate`cache: ${__vite__mapDeps.f}`;',
    },
    {
      file: "tagged-template-cache-receiver.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.tag = function() { this[0] = "./last.js"; }; cache.tag`literal`;',
    },
    {
      file: "tagged-template-cache-container.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(_strings, box) { box.cache[0] = "./last.js"; } mutate`${{cache: __vite__mapDeps.f}}`;',
    },
    {
      file: "tagged-template-spread-container.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(_strings, box) { box.f[0] = "./last.js"; } mutate`${{...__vite__mapDeps}}`;',
    },
    {
      file: "spread-cache-call-argument.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(cache) { cache[0] = "./last.js"; } mutate(...[__vite__mapDeps.f]);',
    },
    {
      file: "assigned-spread-argument-positions.js",
      mutation:
        '__vite__mapDeps([0]); const args = [{}, __vite__mapDeps]; const copy = Object.assign(...args); copy.f[0] = "./last.js";',
    },
    {
      file: "assigned-trailing-spread-source.js",
      mutation:
        '__vite__mapDeps([0]); const args = [__vite__mapDeps]; const copy = Object.assign({}, ...args); copy.f[0] = "./last.js";',
    },
    {
      file: "frozen-spread-returned-helper.js",
      mutation:
        '__vite__mapDeps([0]); const alias = Object.freeze(...[__vite__mapDeps]); alias.f[0] = "./last.js";',
    },
    {
      file: "reflect-delete-spread-key-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const key = {cache: __vite__mapDeps.f, toString() { this.cache[0] = "./last.js"; return "unused"; }}; const args = [{}, key]; Reflect.deleteProperty(...args);',
    },
    {
      file: "created-spread-prototype.js",
      mutation:
        '__vite__mapDeps([0]); const child = Object.create(...[__vite__mapDeps]); child.f[0] = "./last.js";',
    },
    {
      file: "independent-assigned-spread-arguments.js",
      mutation:
        '__vite__mapDeps([0]); const copy = Object.assign(...[{}, {f: []}]); copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "independent-tagged-template-argument.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(_strings, cache) { cache[0] = "./last.js"; } mutate`${[]}`;',
      kept: true,
    },
    {
      file: "await-thenable-cache.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.then = function(resolve) { this[0] = "./last.js"; resolve(); }; await cache;',
    },
    {
      file: "await-thenable-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, then(resolve) { this.cache[0] = "./last.js"; resolve(); }}; await box;',
    },
    {
      file: "template-cache-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.toString = function() { this[0] = "./last.js"; return ""; }; `${cache}`;',
    },
    {
      file: "binary-cache-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.valueOf = function() { this[0] = "./last.js"; return 1; }; cache + 1;',
    },
    {
      file: "unary-cache-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.valueOf = function() { this[0] = "./last.js"; return 1; }; +cache;',
    },
    {
      file: "update-valueof-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.self = cache; cache.valueOf = function () { this[0] = "./last.js"; return 0; }; cache.self++;',
    },
    {
      file: "decrement-valueof-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.self = cache; cache.valueOf = function () { this[0] = "./last.js"; return 0; }; cache.self--;',
    },
    {
      file: "compound-addition-valueof-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.self = cache; cache.valueOf = function () { this[0] = "./last.js"; return 0; }; cache.self += 1;',
    },
    {
      file: "compound-arithmetic-valueof-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.self = cache; cache.valueOf = function () { this[0] = "./last.js"; return 1; }; cache.self *= 2;',
    },
    {
      file: "compound-right-hand-container-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, valueOf() { this.cache[0] = "./last.js"; return 1; }}; let count = 0; count += box;',
    },
    {
      file: "logical-assignment-cache-storage.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; box.cache ||= __vite__mapDeps.f; box.cache[0] = "./last.js";',
    },
    {
      file: "compound-slot-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache[0] += "";',
    },
    {
      file: "thrown-cache-escape.js",
      mutation:
        '__vite__mapDeps([0]); try { throw __vite__mapDeps.f; } catch (cache) { cache[0] = "./last.js"; }',
    },
    {
      file: "thrown-helper-escape.js",
      mutation:
        '__vite__mapDeps([0]); try { throw __vite__mapDeps; } catch (helper) { helper.f[0] = "./last.js"; }',
    },
    {
      file: "thrown-cache-wrapper-escape.js",
      mutation:
        '__vite__mapDeps([0]); try { throw {cache: __vite__mapDeps.f}; } catch (box) { box.cache[0] = "./last.js"; }',
    },
    {
      file: "independent-thrown-value.js",
      mutation:
        '__vite__mapDeps([0]); try { throw []; } catch (cache) { cache[0] = "./last.js"; }',
      kept: true,
    },
    {
      file: "class-field-cache-storage.js",
      mutation:
        '__vite__mapDeps([0]); const Box = class { static cache = __vite__mapDeps.f }; Box.cache[0] = "./last.js";',
    },
    {
      file: "instance-class-field-cache-storage.js",
      mutation:
        '__vite__mapDeps([0]); class Box { cache = __vite__mapDeps.f; } const box = new Box(); box.cache[0] = "./last.js";',
    },
    {
      file: "private-instance-class-field-cache-storage.js",
      mutation:
        '__vite__mapDeps([0]); class Box { #cache = __vite__mapDeps.f; mutate() { this.#cache[0] = "./last.js"; } } new Box().mutate();',
    },
    {
      file: "private-static-class-field-cache-storage.js",
      mutation:
        '__vite__mapDeps([0]); class Box { static #cache = __vite__mapDeps.f; static mutate() { this.#cache[0] = "./last.js"; } } Box.mutate();',
    },
    {
      file: "independent-private-class-field.js",
      mutation:
        '__vite__mapDeps([0]); class Box { #cache = []; mutate() { this.#cache[0] = "./last.js"; } } new Box().mutate();',
      kept: true,
    },
    {
      file: "independent-class-field.js",
      mutation:
        '__vite__mapDeps([0]); const Box = class { static cache = [] }; Box.cache[0] = "./last.js";',
      kept: true,
    },
    ...["field = 0", "method() {}"].map((member) => ({
      file: `class-computed-${member.startsWith("field") ? "field" : "method"}-key-coercion.js`,
      mutation:
        '__vite__mapDeps([0]); const key = {cache: __vite__mapDeps.f, toString() { this.cache[0] = "./last.js"; return "slot"; }}; class Box { [key]' +
        (member.startsWith("field") ? " = 0;" : "() {}") +
        " }",
    })),
    {
      file: "independent-counter-update.js",
      mutation: "__vite__mapDeps([0]); const box = {count: 0}; box.count++;",
      kept: true,
    },
    {
      file: "cache-metadata-counter-update.js",
      mutation:
        "__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.count = 0; cache.count++;",
      kept: true,
    },
    {
      file: "computed-key-container-coercion.js",
      mutation:
        '__vite__mapDeps([0]); const key = {cache: __vite__mapDeps.f, toString() { this.cache[0] = "./last.js"; return "key"; }}; ({})[key];',
    },
    {
      file: "independent-primitive-coercions.js",
      mutation:
        "__vite__mapDeps([0]); const first = __vite__mapDeps.f[0]; await first; `${first}`; first + 1; +first; ({})[first];",
      kept: true,
    },
    {
      file: "getter-receiver-cache-effect.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, get trigger() { this.cache[0] = "./last.js"; return 1; }}; box.trigger;',
    },
    {
      file: "array-spread-iterator-cache-effect.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, *[Symbol.iterator]() { this.cache[0] = "./last.js"; yield 0; }}; [...box];',
    },
    {
      file: "object-spread-getter-cache-effect.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, get trigger() { this.cache[0] = "./last.js"; return 1; }}; ({...box});',
    },
    {
      file: "ordinary-cache-iteration.js",
      mutation:
        "__vite__mapDeps([0]); const cache = __vite__mapDeps.f; [...cache]; for (const slot of cache) {} const {0: first} = cache;",
      kept: true,
    },
    {
      file: "detached-through-container-alias.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const alias = copy; alias.f = []; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "restored-through-assigned-alias.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const alias = Object.assign(copy, {}); copy.f = []; alias.f = __vite__mapDeps.f; copy.f[0] = "./last.js";',
    },
    {
      file: "restored-through-nested-alias.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const box = {copy}; copy.f = []; box.copy.f = __vite__mapDeps.f; copy.f[0] = "./last.js";',
    },
    {
      file: "restored-through-reflect.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const alias = copy; copy.f = []; Reflect.set(alias, "f", __vite__mapDeps.f); copy.f[0] = "./last.js";',
    },
    {
      file: "assigned-container-fresh-override.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.assign(box, __vite__mapDeps, {f: []}); box.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "assigned-through-existing-alias.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const alias = box; Object.assign(alias, __vite__mapDeps); box.f[0] = "./last.js";',
    },
    {
      file: "restored-through-assigned-target.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const alias = Object.assign(copy, {f: []}); Object.assign(copy, __vite__mapDeps); alias.f[0] = "./last.js";',
    },
    {
      file: "custom-container-method.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.custom = function () { this.f[0] = "./last.js"; }; copy.custom();',
    },
    {
      file: "borrowed-custom-cache-method.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.custom = function () { this[0] = "./last.js"; }; cache.custom.call(cache);',
    },
    {
      file: "readonly-cache-method.js",
      mutation:
        "__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.slice(0, 1);",
      kept: true,
    },
    {
      file: "copied-explicit-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; const copy = {...box}; copy.f[0] = "./last.js";',
    },
    {
      file: "rest-copied-explicit-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; const {...copy} = box; copy.f[0] = "./last.js";',
    },
    {
      file: "assigned-explicit-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; const copy = Object.assign({}, box); copy.f[0] = "./last.js";',
    },
    {
      file: "copied-named-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; const copy = {...box}; copy.cache[0] = "./last.js";',
    },
    {
      file: "copied-named-fresh-override.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; const copy = {...box, cache: []}; copy.cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "rest-keeps-named-cache.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: [], cache: __vite__mapDeps.f}; const {f, ...copy} = box; copy.cache[0] = "./last.js";',
    },
    {
      file: "detached-explicit-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; box.f = []; box.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "detached-explicit-capture.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; box.f = []; const cache = box.f; cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "captured-explicit-before-detach.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; const cache = box.f; box.f = []; cache[0] = "./last.js";',
    },
    {
      file: "restored-explicit-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; const alias = box; box.f = []; alias.f = __vite__mapDeps.f; box.f[0] = "./last.js";',
    },
    {
      file: "detached-named-container.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; box.cache = []; box.cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "introduced-through-alias.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const alias = box; alias.cache = __vite__mapDeps.f; box.cache[0] = "./last.js";',
    },
    {
      file: "introduced-through-sibling-alias.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const left = box; const right = box; left.cache = __vite__mapDeps.f; right.cache[0] = "./last.js";',
    },
    {
      file: "defined-cache-children.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperties(box, {cache: {value: __vite__mapDeps.f}}); box.cache[0] = "./last.js";',
    },
    {
      file: "defined-through-alias.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const alias = box; Object.defineProperty(alias, "cache", {value: __vite__mapDeps.f}); box.cache[0] = "./last.js";',
    },
    {
      file: "defined-returned-target.js",
      mutation:
        '__vite__mapDeps([0]); const box = Object.defineProperty({}, "cache", {value: __vite__mapDeps.f}); box.cache[0] = "./last.js";',
    },
    {
      file: "defined-stable-descriptor.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const descriptor = {value: __vite__mapDeps.f}; Object.defineProperty(box, "cache", descriptor); box.cache[0] = "./last.js";',
    },
    {
      file: "reflect-defined-cache-child.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Reflect.defineProperty(box, "cache", {value: __vite__mapDeps.f}); box.cache[0] = "./last.js";',
    },
    {
      file: "created-cache-descriptor.js",
      mutation:
        '__vite__mapDeps([0]); const box = Object.create(null, {cache: {value: __vite__mapDeps.f}}); box.cache[0] = "./last.js";',
    },
    {
      file: "defined-readonly-child.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperty(box, "cache", {value: __vite__mapDeps.f});',
      kept: true,
    },
    {
      file: "copied-array-independent.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; const copy = {...cache}; copy[0] = "./last.js";',
      kept: true,
    },
    {
      file: "copied-explicit-fresh-override.js",
      mutation:
        '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; const copy = {...box, f: []}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "rest-array-shared-child.js",
      mutation:
        '__vite__mapDeps([0]); const box = [__vite__mapDeps.f]; const [...copy] = box; copy[0][0] = "./last.js";',
    },
    {
      file: "rest-array-shifted-child.js",
      mutation:
        '__vite__mapDeps([0]); const box = [[], __vite__mapDeps.f]; const [ignored, ...copy] = box; copy[0][0] = "./last.js";',
    },
    {
      file: "rest-array-excluded-child.js",
      mutation:
        '__vite__mapDeps([0]); const box = [__vite__mapDeps.f]; const [ignored, ...copy] = box; copy[0] = "./last.js";',
      kept: true,
    },
    {
      file: "introduced-through-conditional-alias.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const alias = runtimeCondition ? box : {}; alias.cache = __vite__mapDeps.f; box.cache[0] = "./last.js";',
    },
    {
      file: "introduced-through-rest-alias.js",
      mutation:
        '__vite__mapDeps([0]); const {...box} = {}; const alias = box; alias.cache = __vite__mapDeps.f; box.cache[0] = "./last.js";',
    },
    {
      file: "defined-through-conditional-alias.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; const alias = runtimeCondition ? box : {}; Object.defineProperty(alias, "cache", {value: __vite__mapDeps.f}); box.cache[0] = "./last.js";',
    },
    {
      file: "detached-copy-captured-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f = []; const cache = copy.f; cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "conditional-detach.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; if (runtimeCondition) copy.f = []; copy.f[0] = "./last.js";',
    },
    {
      file: "non-index-cache-property.js",
      mutation:
        '__vite__mapDeps([0]); Object.defineProperty(__vite__mapDeps.f, "metadata", {value: true});',
      kept: true,
    },
    {
      file: "cache-surrogate-key.js",
      mutation: String.raw`const unrelated = {"\uD800": 0};`,
      kept: true,
    },
    {
      file: "mutated-spread-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; replacement[0] = __vite__mapDeps.f; const copy = {...__vite__mapDeps, f: replacement}; copy.f[0][0] = "./last.js";',
    },
    {
      file: "restored-copy-cache.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f = []; copy.f = __vite__mapDeps.f; copy.f[0] = "./last.js";',
    },
    {
      file: "conditional-restored-copy.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f = []; if (runtimeCondition) copy.f = __vite__mapDeps.f; copy.f[0] = "./last.js";',
    },
    {
      file: "copied-container-escape.js",
      mutation:
        "__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; mutate(copy);",
    },
    {
      file: "array-container-escape.js",
      mutation:
        "__vite__mapDeps([0]); const box = [__vite__mapDeps.f]; mutate(box);",
    },
    {
      file: "overridden-cache-property-with-method.js",
      mutation:
        '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, cache() {}}; box.cache[0] = "./last.js";',
      kept: true,
    },
    {
      file: "inline-object-cache-escape.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(box) { box.cache[0] = "./last.js"; } mutate({cache: __vite__mapDeps.f});',
    },
    {
      file: "inline-array-cache-escape.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(box) { box[0][0] = "./last.js"; } mutate([__vite__mapDeps.f]);',
    },
    {
      file: "reflect-applied-cache-escape.js",
      mutation:
        '__vite__mapDeps([0]); function mutate(cache) { cache[0] = "./last.js"; } Reflect.apply(mutate, null, [__vite__mapDeps.f]);',
    },
    {
      file: "bound-assign-applied-shared-cache.js",
      mutation:
        '__vite__mapDeps([0]); const args = [{}, __vite__mapDeps]; const copy = Object.assign.bind(null).apply(null, args); copy.f[0] = "./last.js";',
    },
    {
      file: "bound-assign-reflect-applied-shared-cache.js",
      mutation:
        '__vite__mapDeps([0]); const args = [__vite__mapDeps]; const copy = Reflect.apply(Object.assign.bind(null, {}), null, args); copy.f[0] = "./last.js";',
    },
    {
      file: "independent-bound-assign-apply.js",
      mutation:
        '__vite__mapDeps([0]); const args = [{}, {f: []}]; const copy = Object.assign.bind(null).apply(null, args); copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "assigned-target-cache.js",
      mutation:
        '__vite__mapDeps([0]); const box = {...__vite__mapDeps}; const alias = Object.assign(box, {}); alias.f[0] = "./last.js";',
    },
    {
      file: "assigned-target-override.js",
      mutation:
        '__vite__mapDeps([0]); const box = {...__vite__mapDeps}; const alias = Object.assign(box, {f: []}); alias.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "sparse-independent-replacement.js",
      mutation:
        "__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: [" +
        ",".repeat(2048) +
        ']}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "assigned-cache-alias.js",
      mutation:
        '__vite__mapDeps([0]); const alias = Object.assign(__vite__mapDeps.f, {}); alias[0] = "./last.js";',
    },
    {
      file: "assigned-holder-cache.js",
      mutation:
        '__vite__mapDeps([0]); const holder = {}; Object.assign(holder, {cache: __vite__mapDeps.f}); holder.cache[0] = "./last.js";',
    },
    {
      file: "assigned-cache-setter.js",
      mutation:
        '__vite__mapDeps([0]); const box = {set cache(value) { value[0] = "./last.js"; }}; Object.assign(box, {cache: __vite__mapDeps.f});',
    },
    {
      file: "assigned-source-getter.js",
      mutation:
        '__vite__mapDeps([0]); const source = {cache: __vite__mapDeps.f, get x() { this.cache[0] = "./last.js"; return 0; }}; Object.assign({}, source);',
    },
    {
      file: "set-prototype-cache-child.js",
      mutation:
        '__vite__mapDeps([0]); const view = Object.setPrototypeOf({}, __vite__mapDeps); view.f[0] = "./last.js";',
    },
    {
      file: "constructor-cache-escape.js",
      mutation:
        '__vite__mapDeps([0]); function Mutator(cache) { cache[0] = "./last.js"; } new Mutator(__vite__mapDeps.f);',
    },
    {
      file: "reflect-set-holder-cache.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Reflect.set(box, "cache", __vite__mapDeps.f); box.cache[0] = "./last.js";',
    },
    {
      file: "defined-holder-cache.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.defineProperty(box, "cache", {value: __vite__mapDeps.f}); box.cache[0] = "./last.js";',
    },
    {
      file: "aliased-copy-restored-cache.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const alias = copy; copy.f = []; alias.f = __vite__mapDeps.f; copy.f[0] = "./last.js";',
    },
    {
      file: "assigned-helper-statement.js",
      mutation:
        '__vite__mapDeps([0]); const box = {}; Object.assign(box, __vite__mapDeps); box.f[0] = "./last.js";',
    },
    {
      file: "custom-cache-method.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.custom = function () { this[0] = "./last.js"; }; cache.custom();',
    },
    {
      file: "own-cache-slice.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.slice = function () { this[0] = "./last.js"; }; cache.slice();',
    },
    {
      file: "defined-cache-slice.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; Object.defineProperty(cache, "slice", {value: function () { this[0] = "./last.js"; }}); cache.slice();',
    },
    {
      file: "helper-alias.js",
      mutation: 'const alias = __vite__mapDeps; alias.f = ["./last.js"];',
    },
    {
      file: "cache-alias.js",
      mutation: 'const cache = __vite__mapDeps.f; cache[0] = "./last.js";',
    },
    {
      file: "cache-splice.js",
      mutation: '__vite__mapDeps.f.splice(0, 1, "./last.js");',
    },
    {
      file: "alias-splice.js",
      mutation:
        'const cache = __vite__mapDeps.f; cache.splice(0, 1, "./last.js");',
    },
    {
      file: "computed-splice.js",
      mutation: '__vite__mapDeps["f"]["splice"](0, 1, "./last.js");',
    },
    {
      file: "borrowed-splice.js",
      mutation:
        '__vite__mapDeps([0]); Array.prototype.splice.call(__vite__mapDeps.f, 0, 1, "./last.js");',
    },
    {
      file: "borrowed-apply.js",
      mutation:
        '__vite__mapDeps([0]); Array.prototype.fill.apply(__vite__mapDeps.f, ["./last.js"]);',
    },
    {
      file: "replaced-borrowed-slice.js",
      mutation:
        '__vite__mapDeps([0]); Array.prototype.slice = function () { this[0] = "./last.js"; }; Array.prototype.slice.call(__vite__mapDeps.f, 0, 1);',
    },
    {
      file: "captured-borrowed-slice.js",
      mutation:
        '__vite__mapDeps([0]); const slice = Array.prototype.slice; Array.prototype.slice = function () { this[0] = "./last.js"; }; slice.call(__vite__mapDeps.f, 0, 1);',
      kept: true,
    },
    {
      file: "borrowed-for-each-callback.js",
      mutation:
        '__vite__mapDeps([0]); Array.prototype.forEach.call(__vite__mapDeps.f, (_value, _index, cache) => { cache[0] = "./last.js"; });',
    },
    {
      file: "ordinary-cache-escape.js",
      mutation:
        '__vite__mapDeps([0]); function mutateCache(cache) { cache[0] = "./last.js"; } mutateCache(__vite__mapDeps.f);',
    },
    {
      file: "spread-child-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f[0] = "./last.js";',
    },
    {
      file: "spread-projected-child.js",
      mutation:
        '__vite__mapDeps([0]); const cache = ({...__vite__mapDeps}).f; cache[0] = "./last.js";',
    },
    {
      file: "spread-projected-splice.js",
      mutation:
        '__vite__mapDeps([0]); const cache = ({...__vite__mapDeps}).f; cache.splice(0, 1, "./last.js");',
    },
    {
      file: "spread-uncertain-override.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, [runtimeKey]: []}; copy.f[0] = "./last.js";',
    },
    {
      file: "spread-literal-override.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{f: []}}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "spread-stable-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; const copy = {...__vite__mapDeps, f: replacement}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "rest-copied-array.js",
      mutation:
        '__vite__mapDeps([0]); const {f: {...copy}} = __vite__mapDeps; copy[0] = "./last.js";',
      kept: true,
    },
    {
      file: "spread-nested-literal-override.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{...{f: []}}}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "spread-property-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f = ["./last.js"];',
      kept: true,
    },
    {
      file: "mutated-replacement-alias.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; replacement[0] = __vite__mapDeps.f; const copy = {f: replacement}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "mutated-replacement-child.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; replacement[0] = __vite__mapDeps.f; const copy = {f: replacement}; copy.f[0][0] = "./last.js";',
    },
    {
      file: "recursive-fresh-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; replacement[0] = replacement; const copy = {...__vite__mapDeps, f: replacement}; copy.f[0][0] = "./last.js";',
      kept: true,
    },
    {
      file: "recursive-shared-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const replacement = []; replacement[0] = replacement; replacement[1] = __vite__mapDeps.f; const copy = {...__vite__mapDeps, f: replacement}; copy.f[0][1][0] = "./last.js";',
    },
    {
      file: "escaped-replacement.js",
      mutation:
        '__vite__mapDeps([0]); function shareCache(target) { target[0] = __vite__mapDeps.f; } const replacement = []; shareCache(replacement); const copy = {...__vite__mapDeps, f: replacement}; copy.f[0][0] = "./last.js";',
    },
    {
      file: "spread-overridden-child.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: []}; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "nested-cache-array-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{f: [__vite__mapDeps.f]}}; copy.f[0][0] = "./last.js";',
    },
    {
      file: "getter-cache-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, get f() { return __vite__mapDeps.f; }}; copy.f[0] = "./last.js";',
    },
    {
      file: "nested-getter-cache-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: {get cache() { return __vite__mapDeps.f; }}}; copy.f.cache[0] = "./last.js";',
    },
    {
      file: "regexp-override.js",
      mutation:
        "__vite__mapDeps([0]); const copy = {...__vite__mapDeps, f: /x/g}; copy.f.lastIndex = 1;",
      kept: true,
    },
    {
      file: "nested-fresh-array-write.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps, ...{f: [["./other.js"]]}}; copy.f[0][0] = "./last.js";',
      kept: true,
    },
    {
      file: "array-container-child.js",
      mutation:
        '__vite__mapDeps([0]); const container = [__vite__mapDeps.f]; container[0][0] = "./last.js";',
    },
    {
      file: "detached-copy-child.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; copy.f = []; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "retained-copy-child.js",
      mutation:
        '__vite__mapDeps([0]); const copy = {...__vite__mapDeps}; const retained = copy.f; copy.f = []; retained[0] = "./last.js";',
    },
    {
      file: "for-of-cache-string-log.js",
      mutation:
        "__vite__mapDeps([0]); for (const path of __vite__mapDeps.f) { console.log(path); }",
      kept: true,
    },
    {
      file: "for-of-cache-string-log-with-metadata.js",
      mutation:
        "__vite__mapDeps([0]); __vite__mapDeps.f.extra = __vite__mapDeps.f; for (const path of __vite__mapDeps.f) { console.log(path); }",
      kept: true,
    },
    {
      file: "for-of-cache-string-log-before-copy.js",
      mutation:
        "__vite__mapDeps([0]); for (const path of __vite__mapDeps.f) { console.log(path); } Object.assign({}, __vite__mapDeps);",
      kept: true,
    },
    {
      file: "for-of-indexed-cache-binding-write.js",
      mutation:
        '__vite__mapDeps([0]); const items = []; items[0] = __vite__mapDeps.f; for (const cache of items) { cache[0] = "./last.js"; }',
    },
    {
      file: "for-of-cache-binding-write.js",
      mutation:
        '__vite__mapDeps([0]); for (const cache of [__vite__mapDeps.f]) { cache[0] = "./last.js"; }',
    },
    {
      file: "for-of-cache-assignment-write.js",
      mutation:
        '__vite__mapDeps([0]); let cache; for (cache of [__vite__mapDeps.f]) { cache[0] = "./last.js"; }',
    },
    {
      file: "for-of-destructured-cache-write.js",
      mutation:
        '__vite__mapDeps([0]); for (const {cache} of [{cache: __vite__mapDeps.f}]) { cache[0] = "./last.js"; }',
    },
    {
      file: "for-of-independent-binding-write.js",
      mutation:
        "__vite__mapDeps([0]); for (const item of [{}]) { item.value = 1; }",
      kept: true,
    },
    {
      file: "for-in-cache-key-write.js",
      mutation:
        '__vite__mapDeps([0]); for (const key in [__vite__mapDeps.f]) { key[0] = "./last.js"; }',
      kept: true,
    },
    {
      file: "object-create-cache-prototype-escape.js",
      mutation:
        "__vite__mapDeps([0]); const child = Object.create(__vite__mapDeps.f); opaque(child);",
    },
    {
      file: "nested-object-create-cache-prototype-escape.js",
      mutation:
        "__vite__mapDeps([0]); const child = Object.create(Object.create(__vite__mapDeps.f)); opaque(child);",
    },
    {
      file: "spread-cache-copy-escape.js",
      mutation:
        "__vite__mapDeps([0]); const copy = [...__vite__mapDeps.f]; opaque(copy);",
      kept: true,
    },
    {
      file: "object-create-child.js",
      mutation:
        '__vite__mapDeps([0]); const copy = Object.create(__vite__mapDeps); copy.f[0] = "./last.js";',
    },
    {
      file: "object-create-replacement.js",
      mutation:
        '__vite__mapDeps([0]); const copy = Object.create(__vite__mapDeps); copy.f = []; copy.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "frozen-helper-prototype-replacement.js",
      mutation:
        '__vite__mapDeps([0]); Object.freeze(__vite__mapDeps); const box = Object.create(__vite__mapDeps); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "readonly-helper-prototype-replacement.js",
      mutation:
        '__vite__mapDeps([0]); Object.defineProperty(__vite__mapDeps, "f", {value: __vite__mapDeps.f, writable: false}); const box = Object.create(__vite__mapDeps); box.f = []; box.f[0] = "./last.js";',
    },
    {
      file: "sealed-helper-prototype-replacement.js",
      mutation:
        '__vite__mapDeps([0]); Object.seal(__vite__mapDeps); const box = Object.create(__vite__mapDeps); box.f = []; box.f[0] = "./last.js";',
      kept: true,
    },
    {
      file: "cache-metadata.js",
      mutation:
        '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; cache.tag = "metadata";',
      kept: true,
    },
    {
      file: "inherited-function-cache.js",
      mutation: 'Function.prototype.f = ["./last.js"];',
    },
    {
      file: "inherited-object-cache.js",
      mutation: 'Object.prototype.f = ["./last.js"];',
    },
    {
      file: "reassigned-alias.js",
      mutation:
        'let alias = __vite__mapDeps; alias = runtimeMapper; alias.f = ["./last.js"];',
    },
    {
      file: "unrelated-property.js",
      mutation: 'const alias = __vite__mapDeps; alias.other = ["./last.js"];',
      kept: true,
    },
    {
      file: "cache-read.js",
      mutation: "const cache = __vite__mapDeps.f; cache.slice(0, 1);",
      kept: true,
    },
  ].map(({ file, mutation, kept }) => {
    const calls = mutation.includes(defaultCall) ? [0, 1] : [0];
    return {
      file,
      source: mapDependencies('["./first.js"]', "[0]").replace(
        defaultCall + ";",
        mutation + "\n" + defaultCall + ";",
      ),
      callSource: defaultCall,
      callOccurrences: calls,
      resolved: kept ? calls.map(() => "first.js") : [],
      unknown: !kept,
    };
  }),
  {
    file: "copied-cache-splice.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]);\nconst {...copy} = __vite__mapDeps; copy.f.splice(0, 1, "./last.js");\n__vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "explicit-cache-property.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]); const box = {f: __vite__mapDeps.f}; box.f[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "cache-non-f-property.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f}; box.cache[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "cache-non-f-unrelated-method.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      defaultCall + ";",
      '__vite__mapDeps([0]); const box = {cache: __vite__mapDeps.f, unrelated() { return 1; }}; box.cache[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "cache-surrogate-property.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      defaultCall + ";",
      String.raw`__vite__mapDeps([0]); const box = {"\uD800": __vite__mapDeps.f}; box["\uD800"][0] = "./last.js"; __vite__mapDeps([0]);`,
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "mutated-array-map.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "const __vite__mapDeps",
      'Array.prototype.map = function () { return ["./last.js"]; };\nconst __vite__mapDeps',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "object-assign-cache.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]); const copy = Object.assign({}, __vite__mapDeps); copy.f[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "copied-cache-replacement.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      '__vite__mapDeps([0]);\nconst {...copy} = __vite__mapDeps; copy.f = ["./last.js"];\n__vite__mapDeps([0]);',
    ),
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  {
    file: "ambiguous-helper-alias.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "let alias = __vite__mapDeps;\n{\n" +
        mapDependencies('["./last.js"]', "[0]").replace(
          "__vite__mapDeps([0]);",
          "alias = __vite__mapDeps;\n__vite__mapDeps([0]);",
        ) +
        '\n}\nalias.f.splice(0, 1, "./last.js");\n__vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "reassigned-helper-box.js",
    callOccurrences: [0, 1, 2],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      defaultCall + ";",
      "__vite__mapDeps([0]); let box = {cache: __vite__mapDeps.f};\n{\n" +
        mapDependencies('["./last.js"]', "[0]").replace(
          defaultCall + ";",
          "__vite__mapDeps([0]); box = {cache: __vite__mapDeps.f};",
        ) +
        '\n}\nbox.cache[0] = "./last.js"; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "reassigned-cache-container.js",
    callOccurrences: [0, 1],
    source:
      "let leftHelper, rightHelper;\n{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\nleftHelper = __vite__mapDeps;\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\nrightHelper = __vite__mapDeps;\n}\n" +
      'let box = {f: leftHelper.f}; box = rightHelper; box.f[0] = "./last.js";',
    resolved: [],
    unknown: true,
  },
  {
    file: "nested-container-multiple-owners.js",
    callOccurrences: [0, 1],
    source:
      "let leftHelper, rightHelper;\n{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\nleftHelper = __vite__mapDeps;\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\nrightHelper = __vite__mapDeps;\n}\n" +
      'const box = {cache: leftHelper.f}; const alias = box; alias.cache.nested = rightHelper.f; box.cache.nested[0] = "./last.js";',
    resolved: [],
    unknown: true,
  },
  {
    file: "replaced-helper-cache-owner.js",
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    source:
      "let leftHelper, rightHelper;\n{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\nleftHelper = __vite__mapDeps;\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\nrightHelper = __vite__mapDeps;\n}\n" +
      "leftHelper.f = rightHelper.f;",
    resolved: ["right.js"],
    unknown: true,
  },
  {
    file: "replaced-helper-cache-write.js",
    callOccurrences: [0, 1],
    source:
      "let leftHelper, rightHelper;\n{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\nleftHelper = __vite__mapDeps;\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\nrightHelper = __vite__mapDeps;\n}\n" +
      'leftHelper.f = rightHelper.f; leftHelper.f[0] = "./last.js";',
    resolved: [],
    unknown: true,
  },
  {
    file: "replaced-helper-cache-escape.js",
    callOccurrences: [0, 1],
    source:
      "let leftHelper, rightHelper;\n{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\nleftHelper = __vite__mapDeps;\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\nrightHelper = __vite__mapDeps;\n}\n" +
      'leftHelper.f = rightHelper.f; function mutate(helper) { helper.f[0] = "./last.js"; } mutate(leftHelper);',
    resolved: [],
    unknown: true,
  },
  {
    file: "helper-metadata-cache-owner.js",
    callOccurrences: [0, 1],
    source:
      "let leftHelper, rightHelper;\n{\n" +
      mapDependencies('["./left.js"]', "[0]") +
      "\nleftHelper = __vite__mapDeps;\n}\n{\n" +
      mapDependencies('["./right.js"]', "[0]") +
      "\nrightHelper = __vite__mapDeps;\n}\n" +
      "leftHelper.metadata = rightHelper.f;",
    resolved: ["left.js", "right.js"],
    unknown: false,
  },
  {
    file: "shared-cache-metadata.js",
    callOccurrences: [0, 1, 2, 3],
    source: mapDependencies('["./first.js"]', "[0]").replace(
      defaultCall + ";",
      "__vite__mapDeps([0]); const cache = __vite__mapDeps.f;\n{\n" +
        mapDependencies('["./last.js"]', "[0]").replace(
          defaultCall + ";",
          '__vite__mapDeps([0]); cache.metadata = __vite__mapDeps.f; cache.metadata[0] = "./last.js"; __vite__mapDeps([0]);',
        ) +
        "\n}\n__vite__mapDeps([0]);",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "copied-cache-metadata-escape.js",
    callOccurrences: [0, 1, 2],
    source: mapDependencies('["./left.js"]', "[0]").replace(
      defaultCall + ";",
      "__vite__mapDeps([0]); const leftHelper = __vite__mapDeps;\n{\n" +
        mapDependencies('["./right.js"]', "[0]").replace(
          defaultCall + ";",
          '__vite__mapDeps([0]); const rightHelper = __vite__mapDeps; leftHelper.f.tag = rightHelper.f; const copy = {...leftHelper.f}; function mutate(box) { box.tag[0] = "./last.js"; } mutate(copy); __vite__mapDeps([0]);',
        ) +
        "\n}",
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "join-separator-cache-escape.js",
    callOccurrences: [0, 1],
    source: mapDependencies('["./first.js", "./last.js"]', "[0]").replace(
      defaultCall + ";",
      '__vite__mapDeps([0]); const separator = {cache: __vite__mapDeps.f, toString() { this.cache[0] = "./last.js"; return ","; }}; __vite__mapDeps.f.join(separator); __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  ...(
    [
      [
        "export-cache-declaration.js",
        "export const cache = __vite__mapDeps.f;",
      ],
      [
        "export-cache-specifier.js",
        "const cache = __vite__mapDeps.f; export {cache as dependencies};",
      ],
      [
        "export-cache-default-expression.js",
        "export default {cache: __vite__mapDeps.f};",
      ],
      [
        "export-cache-default-capture.js",
        "let cache = __vite__mapDeps.f; export default cache; cache = [];",
      ],
      [
        "export-cache-destructure.js",
        "export const {f: cache} = __vite__mapDeps;",
      ],
    ] as const
  ).map(([file, exposure]) => ({
    file,
    source: mapDependenciesWithEffects(
      `__vite__mapDeps([0]); ${exposure} export function load() { return __vite__mapDeps([0]); }`,
    ),
    callOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  })),
  ...(
    [
      ["export-independent-table.js", 'export const cache = ["./other.js"];'],
      [
        "export-foreign-binding.js",
        'const cache = __vite__mapDeps.f; export {cache} from "./other.js";',
      ],
    ] as const
  ).map(([file, exposure]) => ({
    file,
    source: mapDependenciesWithEffects(
      `__vite__mapDeps([0]); ${exposure} export function load() { return __vite__mapDeps([0]); }`,
    ),
    callOccurrences: [0, 1],
    resolved: ["first.js", "first.js"],
    unknown: false,
  })),
  ...(
    [
      ["sparse-array-inherited-index.js", "Array.prototype[0] = 1;", true],
      ["sparse-object-inherited-index.js", "Object.prototype[0] = 1;", true],
      ["sparse-unrelated-inherited-index.js", "Array.prototype[2] = 1;", false],
      ["sparse-unmodified-index.js", "", false],
    ] as const
  ).map(([file, mutation, unknown]) => ({
    file,
    source: `${mutation}\n${mapDependencies('["./first.js", "./last.js"]', "[, 0]")}`,
    callSource: "__vite__mapDeps([, 0])",
    resolved: unknown ? [] : ["first.js"],
    unknown,
  })),
  ...(
    [
      ["cache-prototype-replaced-method.js", "cache.__proto__"],
      [
        "cache-object-prototype-replaced-method.js",
        "Object.getPrototypeOf(cache)",
      ],
      [
        "cache-reflect-prototype-replaced-method.js",
        "Reflect.getPrototypeOf(cache)",
      ],
    ] as const
  ).map(([file, prototype]) => ({
    file,
    source: mapDependenciesWithEffects(
      `__vite__mapDeps([0]); const cache = __vite__mapDeps.f; const proto = ${prototype}; proto.slice = function () { this[0] = "./last.js"; return []; }; cache.slice(); __vite__mapDeps([0]);`,
    ),
    callOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  })),
  {
    file: "cache-prototype-unmodified.js",
    source: mapDependenciesWithEffects(
      "__vite__mapDeps([0]); const cache = __vite__mapDeps.f; const proto = cache.__proto__; __vite__mapDeps([0]);",
    ),
    callOccurrences: [0, 1],
    resolved: ["first.js", "first.js"],
    unknown: false,
  },
  ...(
    [
      [
        "named-helper-cache-mutation.js",
        'const alias = __vite__mapDeps([1])[0]; alias.f[0] = "./last.js";',
      ],
      [
        "named-helper-nested-cache-mutation.js",
        'const box = {helper: __vite__mapDeps([1])[0]}; box.helper.f[0] = "./last.js";',
      ],
      ["named-helper-export.js", "export default __vite__mapDeps([1])[0];"],
    ] as const
  ).map(([file, mutation]) => ({
    file,
    source: mapDependenciesWithEffects(
      `${mutation} __vite__mapDeps([0]);`,
      '["./first.js", m]',
    )
      .replace("(i, m =", "function __vite__mapDeps(i, m =")
      .replace("=> i.map(i => d[i]);", "{ return i.map(i => d[i]); };"),
    callSources: ["__vite__mapDeps([1])", defaultCall],
    callOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  })),
  {
    file: "named-helper-unmodified.js",
    source: mapDependencies('["./first.js", m]', "[0]")
      .replace("(i, m =", "function __vite__mapDeps(i, m =")
      .replace("=> i.map(i => d[i]);", "{ return i.map(i => d[i]); };"),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "cache-shared-prototype-replaced-method.js",
    source: mapDependenciesWithEffects(
      '__vite__mapDeps([0]); const cache = __vite__mapDeps.f; const proto = cache.__proto__; proto.slice = function () { this[0] = "./last.js"; return []; }; {\n' +
        mapDependenciesWithEffects(
          "__vite__mapDeps([0]); __vite__mapDeps.f.slice(); __vite__mapDeps([0]);",
          '["./second.js"]',
        ) +
        "\n}",
    ),
    callOccurrences: [0, 1, 2],
    resolved: [],
    unknown: true,
  },
  {
    file: "sparse-inherited-helper-cache-mutation.js",
    source:
      "Array.prototype[0] = 1;\n" +
      mapDependenciesWithEffects(
        'const alias = __vite__mapDeps([,])[0]; alias.f[0] = "./last.js"; __vite__mapDeps([0]);',
        '["./first.js", m]',
      ),
    callSources: ["__vite__mapDeps([,])", defaultCall],
    callOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  },
  ...(["Object", "Reflect"] as const).map((namespace) => ({
    file: `independent-${namespace.toLowerCase()}-prototype-write.js`,
    source: mapDependenciesWithEffects(
      `const proto = {}; const object = Object.create(proto); ${namespace}.getPrototypeOf(object).label = 1; __vite__mapDeps([0]);`,
    ),
    resolved: ["first.js"],
    unknown: false,
  })),
  {
    file: "independent-prototype-alias-write.js",
    source: mapDependenciesWithEffects(
      "const proto = {}; const object = Object.create(proto); const alias = Object.getPrototypeOf(object); alias.label = 1; __vite__mapDeps([0]);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  ...(["Object", "Reflect"] as const).map((namespace) => ({
    file: `owned-${namespace.toLowerCase()}-prototype-cache-write.js`,
    source: mapDependenciesWithEffects(
      `__vite__mapDeps([0]); const proto = {cache: __vite__mapDeps.f}; const object = Object.create(proto); ${namespace}.getPrototypeOf(object).cache[0] = "./last.js"; __vite__mapDeps([0]);`,
    ),
    callOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  })),
  ...(
    [
      [
        "replaced-created-prototype.js",
        "Object.setPrototypeOf(object, Array.prototype);",
      ],
      ["escaped-created-prototype.js", "mutate(object);"],
    ] as const
  ).map(([file, effect]) => ({
    file,
    source: mapDependenciesWithEffects(
      `const proto = {}; const object = Object.create(proto); ${effect} Object.getPrototypeOf(object).map = function () { return ["./last.js"]; }; __vite__mapDeps([0]);`,
    ),
    resolved: [],
    unknown: true,
  })),
  ...(
    [
      [
        "spread-table-at-cache-write.js",
        'const alias = __vite__mapDeps.f.at(1); alias.f[0] = "./last.js";',
      ],
      [
        "spread-table-slice-cache-write.js",
        'const alias = __vite__mapDeps.f.slice(1)[0]; alias.f[0] = "./last.js";',
      ],
      [
        "spread-table-borrowed-at-cache-write.js",
        'const alias = Array.prototype.at.call(__vite__mapDeps.f, 1); alias.f[0] = "./last.js";',
      ],
    ] as const
  ).map(([file, mutation]) => ({
    file,
    source: mapDependenciesWithEffects(
      `__vite__mapDeps([0]); ${mutation} __vite__mapDeps([0]);`,
      '["./first.js", ...[m]]',
    ),
    callOccurrences: [0, 1],
    resolved: [],
    unknown: true,
  })),
  {
    file: "spread-table-known-prefix.js",
    source: mapDependencies('["./first.js", ...[m]]', "[0]"),
    resolved: ["first.js"],
    unknown: false,
  },
  ...(["Object", "Reflect"] as const).map((namespace) => ({
    file: `late-${namespace.toLowerCase()}-prototype-replacement.js`,
    source: mapDependenciesWithEffects(
      `const getProto = ${namespace}.getPrototypeOf; const proto = {}; const box = {}; box.object = Object.create(proto); Object.setPrototypeOf(box.object, Array.prototype); getProto(box.object).map = function () { return ["./last.js"]; }; __vite__mapDeps([0]);`,
    ),
    resolved: [],
    unknown: true,
  })),
  {
    file: "late-created-object-escape.js",
    source: mapDependenciesWithEffects(
      'const getProto = Object.getPrototypeOf; const proto = {}; const box = {}; box.object = Object.create(proto); mutate(box.object); getProto(box.object).map = function () { return ["./last.js"]; }; __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "late-independent-prototype-write.js",
    source: mapDependenciesWithEffects(
      "const getProto = Object.getPrototypeOf; const proto = {}; const box = {}; box.object = Object.create(proto); getProto(box.object).label = 1; __vite__mapDeps([0]);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  {
    file: "late-captured-prototype-before-replacement.js",
    source: mapDependenciesWithEffects(
      "const getProto = Object.getPrototypeOf; const proto = {}; const box = {}; box.object = Object.create(proto); const captured = getProto(box.object); Object.setPrototypeOf(box.object, Array.prototype); captured.label = 1; __vite__mapDeps([0]);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  ...([false, true] as const).map((prefix) => ({
    file: `coercing-index-${prefix ? "after-prefix" : "first"}.js`,
    callSource: `__vite__mapDeps([${prefix ? "0," : ""}key,0])`,
    source: mapDependenciesWithEffects(
      prefix
        ? "const key = runtimeKey; __vite__mapDeps([0,key,0]);"
        : 'const initialize = __vite__mapDeps; initialize([]); const key = {cache: __vite__mapDeps.f, [Symbol.toPrimitive]() { this.cache[0] = "./last.js"; return 1; }}; __vite__mapDeps([key,0]);',
    ),
    resolved: prefix ? ["first.js"] : [],
    unknown: true,
  })),
  ...(
    [
      ["sparse", 1, '["./first.js", , "./last.js"]'],
      ["out-of-bounds", 5, '["./first.js"]'],
      ["negative", -1, '["./first.js"]'],
      ["named", "named", '["./first.js"]'],
    ] as const
  ).map(([name, key, table]) => {
    const callSource = `__vite__mapDeps([${JSON.stringify(key)},0])`;
    return {
      file: `effectful-${name}-table-read.js`,
      callSource,
      source: mapDependenciesWithEffects(
        `Object.defineProperty(Array.prototype, ${JSON.stringify(String(key))}, {get() { this[0] = "./last.js"; return 1; }, configurable: true}); ${callSource};`,
        table,
      ),
      resolved: [],
      unknown: true,
    };
  }),
  {
    file: "owned-unknown-table-slot-before-known.js",
    callSource: "__vite__mapDeps([1,2])",
    source: mapDependenciesWithEffects(
      'Object.defineProperty(Array.prototype, "1", {get() { return 1; }, configurable: true}); __vite__mapDeps([1,2]);',
      '["./first.js", null, "./last.js"]',
    ),
    resolved: ["last.js"],
    unknown: true,
  },
  {
    file: "inert-unknown-key-before-known.js",
    callSource: "__vite__mapDeps([null,0])",
    source: mapDependencies('["./first.js"]', "[null,0]"),
    resolved: ["first.js"],
    unknown: true,
  },
  {
    file: "effectful-input-elision-before-known.js",
    callSource: "__vite__mapDeps([,0])",
    source: mapDependenciesWithEffects(
      'Object.defineProperty(Array.prototype, "0", {get() { this[1] = 1; return 0; }, configurable: true}); __vite__mapDeps([,0]);',
      '["./first.js", "./last.js"]',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "inherited-table-read-widens-the-shared-cache.js",
    callSource: "__vite__mapDeps([2,1,0])",
    source: mapDependenciesWithEffects(
      'Object.defineProperty(Array.prototype, "1", {get() { return 1; }, configurable: true}); __vite__mapDeps([2,1,0]);',
      '["./first.js", , "./last.js"]',
    ),
    resolved: [],
    unknown: true,
  },
  {
    file: "effectful-late-index-expression-before-map.js",
    callSource: "__vite__mapDeps([0,key,external()])",
    source: mapDependenciesWithEffects(
      "const key = runtimeKey; __vite__mapDeps([0,key,external()]);",
    ),
    resolved: [],
    unknown: true,
  },
  ...(
    [
      ["numeric", "1", "1"],
      ["named", '"named"', "named"],
      ["unknown", "runtimeIndex", "1"],
    ] as const
  ).map(([name, index, property]) => ({
    file: `inherited-${name}-read-invalidates-later-calls.js`,
    callSources: [`__vite__mapDeps([${index}])`, defaultCall],
    callOccurrences: [0, 1],
    source: mapDependenciesWithEffects(
      `Object.defineProperty(Array.prototype, ${JSON.stringify(property)}, {get() { this[0] = "./last.js"; return 1; }, configurable: true}); __vite__mapDeps([${index}]); __vite__mapDeps([0]);`,
      '["./first.js", , "./last.js"]',
    ),
    resolved: [],
    unknown: true,
  })),
  {
    file: "independent-supplied-table-inherited-read.js",
    callSources: ["__vite__mapDeps([1], void 0, [])", defaultCall],
    callOccurrences: [0, 1],
    unknownCallOccurrences: [0],
    source: mapDependenciesWithEffects(
      'Object.defineProperty(Array.prototype, "1", {get() { this[0] = "./last.js"; return 1; }, configurable: true}); __vite__mapDeps([1], void 0, []); __vite__mapDeps([0]);',
    ),
    resolved: ["first.js"],
    unknown: true,
  },
  ...(
    [
      ["direct-eval-cache", "eval(\"__vite__mapDeps.f[0] = './last.js'\");"],
      [
        "eval-shadowed-cache-alias",
        "const cache = __vite__mapDeps.f; { const __vite__mapDeps = null; eval(\"cache[0] = './last.js'\"); }",
      ],
    ] as const
  ).map(([name, effect]) => ({
    file: `${name}.js`,
    source: mapDependenciesWithEffects(
      initializeCache + effect + " __vite__mapDeps([0]);",
    ),
    resolved: [],
    unknown: true,
  })),
  {
    file: "eval-in-independent-activation.js",
    source:
      `function isolated() { ${mapDependencies('["./first.js"]', "[0]")} }` +
      'function unrelated() { const value = {}; eval("value.x = 1"); }',
    resolved: ["first.js"],
    unknown: false,
  },
  ...([false, true] as const).map((awaited) => ({
    file: `${awaited ? "async" : "sync"}-iteration-thenable-cache.js`,
    source: mapDependenciesWithEffects(
      initializeCache +
        `const values = [{cache: __vite__mapDeps.f, then(resolve) { this.cache[0] = "./last.js"; resolve(); }}]; for ${awaited ? "await " : ""}(const value of values) {} __vite__mapDeps([0]);`,
    ),
    resolved: awaited ? [] : ["first.js"],
    unknown: awaited,
  })),
  ...(
    [
      ["cache-strings", "__vite__mapDeps.f"],
      [
        "independent-thenable",
        '[{values: [], then(resolve) { this.values.push("x"); resolve(); }}]',
      ],
    ] as const
  ).map(([name, values]) => ({
    file: `async-iteration-${name}.js`,
    source: mapDependenciesWithEffects(
      initializeCache +
        `for await (const value of ${values}) {} __vite__mapDeps([0]);`,
    ),
    resolved: ["first.js"],
    unknown: false,
  })),
  ...([false, true] as const).map((awaited) => ({
    file: `${awaited ? "async" : "sync"}-disposable-cache.js`,
    source: mapDependenciesWithEffects(
      initializeCache +
        `{ ${awaited ? "await " : ""}using box = {cache: __vite__mapDeps.f, [Symbol.${awaited ? "asyncDispose" : "dispose"}]() { this.cache[0] = "./last.js"; }}; } __vite__mapDeps([0]);`,
    ),
    resolved: [],
    unknown: true,
  })),
  {
    file: "independent-disposable-resource.js",
    source: mapDependenciesWithEffects(
      initializeCache +
        '{ using box = {values: [], [Symbol.dispose]() { this.values.push("x"); }}; } __vite__mapDeps([0]);',
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  ...([false, true] as const).map((shared) => {
    const imported = shared
      ? 'import("./other.js", {cache: __vite__mapDeps.f, get with() { this.cache[0] = "./last.js"; return {}; }})'
      : 'import("./other.js", {values: [], get with() { this.values.push("x"); return {}; }})';
    return {
      file: `${shared ? "shared" : "independent"}-dynamic-import-options.js`,
      callSources: [imported, defaultCall],
      callOccurrences: [0, 1],
      ...(shared ? { unknownCallOccurrences: [1] } : {}),
      source: mapDependenciesWithEffects(
        initializeCache + imported + "; __vite__mapDeps([0]);",
      ),
      resolved: shared ? ["other.js"] : ["other.js", "first.js"],
      unknown: shared,
    };
  }),
  {
    file: "dynamic-import-source-coercion.js",
    callSources: [
      'import({cache: __vite__mapDeps.f, toString() { this.cache[0] = "./last.js"; return "./other.js"; }})',
      defaultCall,
    ],
    callOccurrences: [0, 1],
    source: mapDependenciesWithEffects(
      initializeCache +
        'import({cache: __vite__mapDeps.f, toString() { this.cache[0] = "./last.js"; return "./other.js"; }}); __vite__mapDeps([0]);',
    ),
    resolved: [],
    unknown: true,
  },
  ...[
    'declare class Erased { [__vite__mapDeps.f[0] = "./last.js"]: string; }',
    "declare class Erased { [opaque(__vite__mapDeps.f)]: string; }",
    "type Erased = typeof __vite__mapDeps;",
  ].map((erased, index) => ({
    file: `erased-typescript-cache-effect-${index}.ts`,
    source: mapDependenciesWithEffects(
      initializeCache + erased + " __vite__mapDeps([0]);",
    ),
    resolved: ["first.js"],
    unknown: false,
  })),
  {
    file: "harmless-read-copy.js",
    source: mapDependencies('["./first.js"]', "[0]").replace(
      "__vite__mapDeps([0]);",
      "const cache = __vite__mapDeps.f;\nconsole.log(cache[0]);\nObject.assign({}, __vite__mapDeps);\n__vite__mapDeps([0]);",
    ),
    resolved: ["first.js"],
    unknown: false,
  },
  ...(
    [
      [
        "default-hidden-scalar",
        'Object.defineProperty(Array.prototype, "tag", {value: 1}); const copy = {...Array.prototype};',
        true,
      ],
      [
        "explicit-hidden-unknown",
        'Object.defineProperty(Array.prototype, "tag", {value: runtimeValue, enumerable: false}); const copy = {...Array.prototype};',
        true,
      ],
      [
        "visible-scalar",
        "Array.prototype.tag = 1; const copy = {...Array.prototype};",
        true,
      ],
      [
        "visible-reference",
        'Object.defineProperty(Array.prototype, "tag", {value: Array.prototype, enumerable: true}); const copy = {...Array.prototype};',
        false,
      ],
      [
        "preserved-enumerability",
        'Array.prototype.tag = 1; Object.defineProperty(Array.prototype, "tag", {value: runtimeValue}); const copy = {...Array.prototype};',
        false,
      ],
      [
        "rest-hidden-unknown",
        'Object.defineProperty(Array.prototype, "tag", {value: runtimeValue, enumerable: false}); const {...copy} = Array.prototype;',
        true,
      ],
      [
        "iteration-hidden-index",
        'Object.defineProperty(Array.prototype, "0", {value: Array.prototype, enumerable: false}); const copy = [...Array.prototype];',
        false,
      ],
      [
        "reflect-hidden-unknown",
        'Reflect.defineProperty(Array.prototype, "tag", {value: runtimeValue, enumerable: false}); const copy = {...Array.prototype};',
        true,
      ],
    ] as const
  ).map(([name, effect, kept]) => ({
    file: `prototype-copy-descriptor-${name}.js`,
    source: mapDependenciesWithEffects(
      effect + " opaque(copy); __vite__mapDeps([0]);",
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
  ...["call", "apply", "reflect"].map((mode) => ({
    file: `borrowed-object-receiver-${mode}.js`,
    source: mapDependenciesWithEffects(
      initializeCache +
        'const box = {cache: __vite__mapDeps.f, get [Symbol.toStringTag]() { this.cache[0] = "./last.js"; return "Object"; }}; ' +
        (mode === "call"
          ? "Object.prototype.toString.call(box); "
          : mode === "apply"
            ? "Object.prototype.toString.apply(box, []); "
            : "Reflect.apply(Object.prototype.toString, box, []); ") +
        "__vite__mapDeps([0]);",
    ),
    resolved: [],
    unknown: true,
  })),
  ...[
    ["cache", "__vite__mapDeps.f", false],
    ["mapped", "__vite__mapDeps([])", false],
    ["own-override", "__vite__mapDeps.f", true],
  ].map(([name, receiver, kept]) => ({
    file: `inherited-array-constructor-${String(name)}.js`,
    ...(name === "mapped"
      ? {
          callSources: ["__vite__mapDeps([])", defaultCall],
          callOccurrences: [0, 1],
        }
      : {}),
    source: mapDependenciesWithEffects(
      initializeCache +
        (kept ? "__vite__mapDeps.f.constructor = {prototype: {}}; " : "") +
        `const C = ${String(receiver)}.constructor; C.prototype.map = () => ["./last.js"]; __vite__mapDeps([0]);`,
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
  ...[
    ["own-write", "holder.tag = Array.prototype;", true],
    [
      "descriptor",
      'Object.defineProperty(holder, "tag", {value: Array.prototype, enumerable: true});',
      true,
    ],
    ["other-prototype", "Object.prototype.tag = Array.prototype;", false],
    ["constructor", "Array.tag = Array.prototype;", false],
  ].map(([name, write, kept]) => ({
    file: `prototype-copy-receiver-${String(name)}.js`,
    source: mapDependenciesWithEffects(
      `const holder = {}; ${write} const copy = {...Array.prototype}; opaque(copy); __vite__mapDeps([0]);`,
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
  ...[
    ["replacement", "box.cache = []; opaque(box.cache);", true],
    [
      "declarators",
      "const first = (box.cache = []), selected = box.cache; opaque(selected);",
      true,
    ],
    ["branch", "if (flag) box.cache = []; opaque(box.cache);", false],
    [
      "function",
      "function replace() { box.cache = []; } opaque(box.cache);",
      false,
    ],
    ["compound", "box.cache ||= []; opaque(box.cache);", false],
    [
      "repeated",
      Array.from(
        { length: 48 },
        () => 'box.cache = []; box.cache[0] = "x";',
      ).join(" ") + " opaque(box.cache);",
      true,
    ],
  ].map(([name, effects, kept]) => ({
    file: `indexed-slot-snapshot-${String(name)}.js`,
    source: mapDependenciesWithEffects(
      initializeCache +
        `const box = {cache: __vite__mapDeps.f}; ${String(effects)} __vite__mapDeps([0]);`,
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
  ...[
    [
      "construct",
      "Reflect.construct = mutate; Reflect.construct(Object.freeze, [__vite__mapDeps]);",
      false,
    ],
    [
      "construct-call",
      "Reflect.construct = mutate; Reflect.construct.call(null, Object.freeze, [__vite__mapDeps]);",
      false,
    ],
    [
      "construct-alias-write",
      "const reflection = Reflect; reflection.construct = mutate; Reflect.construct(Object.freeze, [__vite__mapDeps]);",
      false,
    ],
    [
      "apply",
      "Reflect.apply = (_fn, _receiver, args) => mutate(_fn, args); Reflect.apply(Object.freeze, null, [__vite__mapDeps]);",
      false,
    ],
    [
      "unchanged-apply",
      "Reflect.apply(Object.freeze, null, [__vite__mapDeps]);",
      true,
    ],
  ].map(([name, effect, kept]) => ({
    file: `reflect-invocation-authority-${String(name)}.js`,
    source: mapDependenciesWithEffects(
      initializeCache +
        'const mutate = (_fn, args) => { args[0].f[0] = "./last.js"; return {}; }; ' +
        `${String(effect)} __vite__mapDeps([0]);`,
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
  ...[
    [
      "ownerless-constructor",
      'const C = [].constructor; C.prototype.map = () => ["./last.js"];',
      false,
    ],
    [
      "ownerless-destructured-constructor",
      'const {constructor: C} = []; C.prototype.map = () => ["./last.js"];',
      false,
    ],
    [
      "captured-changed-call",
      'Function.prototype.call = function (_, m) { m.f[0] = "./last.js"; }; const change = Object.freeze.call; Reflect.apply(change, Object.freeze, [null, __vite__mapDeps]);',
      false,
    ],
    [
      "captured-changed-apply",
      'Function.prototype.apply = function (_, args) { args[0].f[0] = "./last.js"; }; const change = Object.freeze.apply; Reflect.apply(change, Object.freeze, [null, [__vite__mapDeps]]);',
      false,
    ],
    [
      "call-changed-after-capture",
      'const change = Object.freeze.call; Function.prototype.call = function (_, m) { m.f[0] = "./last.js"; }; Reflect.apply(change, Object.freeze, [null, __vite__mapDeps]);',
      true,
    ],
    [
      "assign-replaced-source-getter",
      'const holder = {source: {}}; holder.source = {cache: __vite__mapDeps.f, get x() { this.cache[0] = "./last.js"; return 0; }}; Object.assign({}, holder.source);',
      false,
    ],
    [
      "assign-replaced-source-data",
      "const holder = {source: {}}; holder.source = {cache: __vite__mapDeps.f}; Object.assign({}, holder.source);",
      true,
    ],
    [
      "assign-captured-source",
      'const holder = {source: {}}; const captured = holder.source; holder.source = {cache: __vite__mapDeps.f, get x() { this.cache[0] = "./last.js"; return 0; }}; Object.assign({}, captured);',
      true,
    ],
  ].map(([name, effect, kept]) => ({
    file: `snapshot-and-wrapper-authority-${String(name)}.js`,
    source: mapDependenciesWithEffects(
      initializeCache + `${String(effect)} __vite__mapDeps([0]);`,
    ),
    resolved: kept ? ["first.js"] : [],
    unknown: !kept,
  })),
];

const batches = Array.from(
  { length: Math.ceil(allScenarios.length / 16) },
  (_, index) => allScenarios.slice(index * 16, (index + 1) * 16),
);

const assertScenarioGraph = (
  graph: JavaScriptApplicationGraph,
  scenario: ViteScenario,
  source: string,
): void => {
  const callRanges = expectedCallRanges(scenario);
  const unknownRanges = expectedUnknownCallRanges(scenario, callRanges);
  const knownRanges = callRanges.filter(
    (_, index) => !scenario.unknownCallOccurrences?.includes(index),
  );
  const directImports = graph.edges.filter(
    ({ relation, properties, evidence }) =>
      relation === "imports" &&
      properties.kind === "dynamic-import" &&
      evidence.location.available &&
      evidence.location.value.kind === "source-range" &&
      evidence.location.value.source === scenario.file,
  );
  const candidates = graph.nodes
    .filter(({ kind }) => kind === "unknown")
    .flatMap(({ observations }) => observations)
    .filter(
      ({ properties, evidence }) =>
        properties.vite_table_candidate === true &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === scenario.file,
    );
  // A selected table value is only a candidate. Imported edges here must
  // come from actual import syntax, not from the table call itself.
  for (const edge of directImports) {
    const location = edge.evidence.location;
    if (location.available && location.value.kind === "source-range") {
      const { line, column } = location.value.start;
      const sourceLine = scenario.source.split("\n")[line - 1] ?? "";
      expect
        .soft(sourceLine.slice(column), scenario.file)
        .toMatch(/^import\s*\(/u);
    }
  }
  const imports = [...directImports, ...candidates];
  expect
    .soft(imports, scenario.file)
    .toHaveLength(scenario.resolved.length + unknownRanges.length);
  if (callRanges.length > 1)
    expect
      .soft(
        imports
          .flatMap(({ evidence }) => {
            const location = evidence.location;
            return location.available && location.value.kind === "source-range"
              ? [
                  JSON.stringify({
                    start: location.value.start,
                    end: location.value.end,
                  }),
                ]
              : [];
          })
          .sort(),
        scenario.file,
      )
      .toEqual(callRanges.map((range) => JSON.stringify(range)).sort());
  expect
    .soft(
      imports
        .flatMap(({ properties }) => {
          const path =
            properties.vite_table_candidate === true
              ? properties.candidate_path
              : properties.resolved_path;
          return typeof path === "string" ? [path] : [];
        })
        .sort(),
      scenario.file,
    )
    .toEqual([...scenario.resolved].sort());
  expect
    .soft(
      imports.some(({ properties }) => properties.specifier === null),
      scenario.file,
    )
    .toBe(scenario.unknown);
  for (const edge of imports) {
    const resolved =
      edge.properties.vite_table_candidate === true
        ? edge.properties.candidate_path
        : edge.properties.resolved_path;
    if (typeof resolved === "string") {
      expect.soft(edge.properties, scenario.file).toMatchObject({
        specifier: "./" + resolved,
      });
      if (edge.properties.vite_table_candidate === true)
        expect
          .soft(edge.properties.resolution_status, scenario.file)
          .toBe("unavailable");
      else
        expect.soft(edge.properties, scenario.file).toMatchObject({
          resolved_path: resolved,
          resolution_status: "resolved",
        });
    } else {
      expectUnknownImportExpression(scenario, edge.properties);
      expect.soft(edge.evidence.coverage.status, scenario.file).toBe("partial");
      const location = edge.evidence.location;
      if (location.available && location.value.kind === "source-range")
        expect.soft(unknownRanges, scenario.file).toContainEqual({
          start: location.value.start,
          end: location.value.end,
        });
    }
    const location = edge.evidence.location;
    expect.soft(edge.evidence.artifact, scenario.file).toMatchObject({
      available: true,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    if (location.available && location.value.kind === "source-range") {
      expect.soft(callRanges, scenario.file).toContainEqual({
        start: location.value.start,
        end: location.value.end,
      });
      if (
        scenario.unknownCallOccurrences !== undefined &&
        edge.properties.specifier !== null
      )
        expect.soft(knownRanges, scenario.file).toContainEqual({
          start: location.value.start,
          end: location.value.end,
        });
      if (edge.properties.vite_table_candidate === true)
        expect
          .soft(edge.evidence.coverage.status, scenario.file)
          .toBe("partial");
    }
  }
};

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    batches.map((scenarios, batch) => [surface, batch + 1, scenarios] as const),
  ),
)(
  "retains Vite dependency values without inventing paths through %s (batch %i)",
  { timeout: 120_000 },
  async ([surface, , scenarios], { cli }) => {
    const root = await createTestTempDirectory("rea-vite-dependencies-");
    const sources = Object.fromEntries(
      scenarios.map(({ file, source }) => [
        file,
        source + '\nthrow new Error("fixture source must never execute");\n',
      ]),
    );
    await writeFixtureFiles(root, {
      ...sources,
      ...Object.fromEntries(
        [
          "café.js",
          "nested/dep.js",
          "bracket].js",
          "first.js",
          "last.js",
          "left.js",
          "right.js",
          "decoy.js",
          "other.js",
        ].map((path) => [path, "export const dependency = true;\n"]),
      ),
    });
    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--json"],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(document).normalized_result,
    );
    for (const scenario of scenarios)
      assertScenarioGraph(graph, scenario, sources[scenario.file] ?? "");
  },
);
