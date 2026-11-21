import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const indexedBindings = (body: string) => {
  const parsed = parseJavaScriptSource(
    `const shared={};const get=()=>shared;${body}`,
  );
  if (parsed === null) throw new Error("Expected callback escape fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return [...index.bindings.bindingsById.values()];
};

it.each([
  ["consume(get);", true],
  ["consume(()=>shared);", true],
  ["const alias=get;consume(alias);", true],
  ["consume(()=>({}));", false],
  ["const local=()=>({});consume(local);", false],
  ["const local=()=>({});const alias=local;consume(alias);", false],
  ["get.own=1;", false],
  ["const local=()=>({});get.call=local;consume(get);", true],
  ["const local=()=>({});get.call=local;consume(get.call);", false],
  ["const local=()=>({});get.apply=local;consume(get.apply);", false],
  ["consume(get.name);", false],
  ["consume(get.length);", false],
])("preserves callback result escape sources through %s", (body, escaped) => {
  const bindings = indexedBindings(body);
  const shared = bindings.find(({ name }) => name === "shared");
  expect(shared).toBeDefined();
  expect((shared?.escapedPaths.length ?? 0) > 0).toBe(escaped);
});

it.each(["call", "apply", "other"])(
  "keeps a function's own %s write separate from its returned object",
  (member) => {
    const bindings = indexedBindings(`get.${member}=()=>({});`);
    const get = bindings.find(({ name }) => name === "get");
    const shared = bindings.find(({ name }) => name === "shared");
    expect(get?.memberWrites.map(({ path }) => path)).toContainEqual([member]);
    expect(shared?.memberWrites).toEqual([]);
    expect(shared?.escapedPaths).toEqual([]);
  },
);

it.each([
  ["let select=Object.keys.bind(null,shared);eval(source);select();", true],

  ["const holder={};holder.select=Object.keys.bind(null,shared);", false],
  [
    "const holder={};holder.select=Object.keys.bind(null,shared);consume(holder);",
    true,
  ],
  [
    "const holder={};holder.select=Object.keys.bind(null,shared);consume(holder.select);",
    true,
  ],
  [
    "const holder={};holder.select=Object.keys.bind(null,shared);holder.select=()=>0;consume(holder.select);",
    false,
  ],
  [
    "const holder={};holder.select=Object.keys.bind(null,shared);consume(holder.other);",
    false,
  ],
  [
    "let cell=shared;const select=Object.keys.bind(null,cell);cell={};consume(select);",
    true,
  ],
  [
    "let cell={};const select=Object.keys.bind(null,cell);cell=shared;consume(select);",
    false,
  ],

  ["const select=Object.keys.bind(null,shared);", false],
  ["const select=Object.keys.bind(null,shared);consume(select);", true],
  [
    "const holder={select:Object.keys.bind(null,shared)};holder.select();",
    true,
  ],
  [
    "const holder={};holder.select=Object.keys.bind(null,shared);holder.select();",
    true,
  ],
  ["const select=Object.keys.bind(null,shared);consume(select.name);", false],
  [
    "const select=Object.keys.bind(null,shared);consume(select.bind(null));",
    true,
  ],
  ["const select=Object.prototype.valueOf.bind(shared);consume(select);", true],
])(
  "tracks bound callback inputs when the callable escapes: %s",
  (body, escaped) => {
    const shared = indexedBindings(body).find(({ name }) => name === "shared");
    expect(shared).toBeDefined();
    expect((shared?.escapedPaths.length ?? 0) > 0).toBe(escaped);
  },
);

it.each([
  [
    "let value=shared;const {pick}={pick:Object.keys.bind(null,value)};value={};pick();",
    true,
  ],
  [
    "let value={};const {pick}={pick:Object.keys.bind(null,value)};value=shared;pick();",
    false,
  ],
  [
    "const box=flag?{pick:Object.keys.bind(null,shared)}:{pick:()=>0};const {pick}=box;pick();",
    true,
  ],

  [
    "const box={pick:Object.keys.bind(null,shared)};const {pick}=box;pick();",
    true,
  ],
  [
    "const pair=[Object.keys.bind(null,shared)];const [pick]=pair;pick();",
    true,
  ],
  ["const pick=flag?Object.keys.bind(null,shared):external;pick();", true],
  [
    "const box={child:{pick:Object.keys.bind(null,shared)}};const {child:{pick}}=box;pick();",
    true,
  ],
  [
    "const box={pick:()=>0,unused:Object.keys.bind(null,shared)};const {pick}=box;pick();",
    false,
  ],
  ["const box={pick:Object.keys.bind(null,shared)};const {pick}=box;", false],
  ["const pick=flag?()=>shared:()=>0;pick();", true],
])(
  "retains bound inputs selected by an invoked alias: %s",
  (source, escaped) => {
    const shared = indexedBindings(source).find(
      ({ name }) => name === "shared",
    );
    expect(shared).toBeDefined();
    expect((shared?.escapedPaths.length ?? 0) > 0).toBe(escaped);
  },
);
