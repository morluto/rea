import { expect, it } from "vitest";
import * as t from "@babel/types";
import {
  analyzeJavaScriptSemantics,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";
import { semanticResourceLimitReason } from "./javascriptSemanticResourceLimits.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

import {
  joinSemanticPropertyPaths,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";

const resultValue = (body: string) =>
  onlyCallable(
    analyzeJavaScriptSemantics(`export function result() { ${body} }`),
    "result",
  ).returnSites[0]?.value;

it("retains common copy exclusions and the union of array prefixes", () => {
  const path = joinSemanticPropertyPaths(
    [{ excludedKeys: ["1", "2"], startIndex: 1 }],
    [{ excludedKeys: ["2", "3"], startIndex: 2 }],
  );
  const key = path?.[0];
  if (key === undefined) throw new Error("Expected joined projection");
  expect(
    ["0", "1", "2", "3", "4", "named"].filter((name) =>
      semanticPropertyPathKeyMatches(key, name),
    ),
  ).toEqual(["1", "3", "4"]);
  const withScalar = joinSemanticPropertyPaths(path ?? [], [0]);
  const scalarKey = withScalar?.[0];
  if (scalarKey === undefined) throw new Error("Expected joined scalar");
  expect(
    ["0", "1", "2", "3", "named"].filter((name) =>
      semanticPropertyPathKeyMatches(scalarKey, name),
    ),
  ).toEqual(["0", "1", "3"]);
  const exact = [1] as const;
  expect(joinSemanticPropertyPaths(exact, ["1"])).toBe(exact);
});

const memberAliasSource = (count: number) => `
  import { Worker } from "node:worker_threads";
  const alias0 = globalThis;
  ${Array.from(
    { length: count },
    (_, index) =>
      `const alias${index + 1} = flag${index} ? alias${index}.globalThis : alias${index}.window;`,
  ).join("\n")}
  alias${count}.URL = replacement;
  new Worker(new URL("./worker.js", import.meta.url));
`;

it("joins overflowing member-alias histories into disclosed possible effects", () => {
  const source = memberAliasSource(16);
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.coverage).toMatchObject({
    status: "partial",
    omittedCount: null,
    resourceLimits: ["alias-selections"],
  });
  expect(ir.limitations).toContain(
    semanticResourceLimitReason("alias-selections"),
  );
  const facts = analyzeJavaScriptStaticSource(source);
  expect(facts.limitations).toContain(
    semanticResourceLimitReason("alias-selections"),
  );
  expect(
    facts.references.filter(({ kind }) => kind === "worker"),
  ).toMatchObject([{ specifier: null }]);
});

// Linked-list splicing in the shape of a minified update-queue drain. Its
// reassigned cursors add a different segment on each alias lap.
const growingAliasCycleSource = `
  export function drain(owner, props, context, mask) {
    var queue = owner.queue;
    var first = queue.head, last = queue.tail, item = queue.inbox.pending;
    if (null !== item) {
      queue.inbox.pending = null;
      var end = item, start = end.next;
      end.next = null;
      null === last ? first = start : last.next = start;
      last = end;
      var other = owner.alternate;
      null !== other && (other = other.queue, item = other.tail, item !== last && (null === item ? other.head = start : item.next = start, other.tail = end));
    }
    if (null !== first) {
      var state = queue.state;
      last = 0;
      other = start = end = null;
      item = first;
      do {
        var lane = item.lane, time = item.time;
        if ((mask & lane) === lane) {
          null !== other && (other = other.next = { time: time, lane: 0, tag: item.tag, payload: item.payload, callback: item.callback, next: null });
          apply: {
            var target = owner, update = item;
            lane = props; time = context;
            switch (update.tag) {
              case 1: target = update.payload; if ("function" === typeof target) { state = target.call(time, state, lane); break apply; } state = target; break apply;
              case 3: target.flags = target.flags & -65537 | 128;
              case 0: target = update.payload; lane = "function" === typeof target ? target.call(time, state, lane) : target; if (null === lane || void 0 === lane) break apply; state = assign({}, state, lane); break apply;
            }
          }
        } else time = { time: time, lane: lane, tag: item.tag, payload: item.payload, callback: item.callback, next: null }, null === other ? (start = other = time, end = state) : other = other.next = time, last |= lane;
        item = item.next;
        if (null === item) if (item = queue.inbox.pending, null === item) break; else lane = item, item = lane.next, lane.next = null, queue.tail = lane, queue.inbox.pending = null;
      } while (1);
      null === other && (end = state);
      queue.state = end;
      queue.head = start;
      queue.tail = other;
      owner.lanes = last;
      owner.memoizedState = state;
    }
  }
`;

it("bounds widened alias joins on a growing linked-list cycle", () => {
  const facts = analyzeJavaScriptStaticSource(growingAliasCycleSource);
  expect(facts.parse_status).not.toBe("failed");
  expect(
    facts.analysis_coverage?.examination.semantic_resource_limits,
  ).toContain("alias-selections");
  expect(facts.limitations).toContain(
    semanticResourceLimitReason("alias-selections"),
  );
});

it("never records a joined selector as a definite receiver replacement", () => {
  const parsed = parseJavaScriptSource(memberAliasSource(16));
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const joined = [...index.bindings.bindingsById.values()]
    .flatMap(({ memberWrites }) => memberWrites)
    .filter(({ path }) => path.includes(null));
  expect(joined.length).toBeGreaterThan(0);
  expect(
    joined.every(({ receiverIdentity }) => receiverIdentity === "possible"),
  ).toBe(true);
});

it("keeps small selector alternatives exact and preserves an untouched third sibling", () => {
  const ir = analyzeJavaScriptSemantics(`
    export function result() {
      const source = { left: { value: 1 }, right: { value: 3 }, third: { value: 2 } };
      const selected = flag ? source.left : source.right;
      selected.value = replacement;
      return source.third.value;
    }
  `);
  expect(onlyCallable(ir, "result").returnSites[0]?.value).toEqual({
    status: "literal",
    value: 2,
  });
  expect(ir.coverage.resourceLimits ?? []).not.toContain("alias-selections");
});

it.each([
  "const left={value:1}; const right={value:2}; const window={left,right}; const selected=flag?window.left:window.right; selected.value=9; return left.value;",
  "const left={value:1}; const right={value:2}; const globalThis={window:left,globalThis:right}; const selected=flag?globalThis.window:globalThis.globalThis; selected.value=9; return left.value;",
  "const local={value:1}; const selected=flag?local:external; selected.value=9; return local.value;",
])("retains local and unresolved mutation targets: %s", (body) => {
  expect(resultValue(body)?.status).toBe("unknown");
});

it.each(["first", "second"])(
  "retains both captured targets across replacement: %s",
  (name) => {
    expect(
      resultValue(`
      const first = { value: 1 };
      const second = { value: 2 };
      let current = first;
      const before = current;
      current = second;
      const after = current;
      const selected = flag ? before : after;
      selected.value = 9;
      return ${name}.value;
    `)?.status,
    ).toBe("unknown");
  },
);

it.each([
  "const first={value:1}; const second={value:2}; const captured=first; let selected=first; selected=second; const alias=flag?captured:captured; alias.value=9; return second.value;",
  "const first={value:2}; const second={value:1}; let selected=first; selected=second; const captured=selected; const alias=flag?captured:captured; alias.value=9; return first.value;",
  "const source={left:{value:1},right:{value:2}}; source.left.value=9; return source.right.value;",
])("preserves captured ownership and unjoined siblings: %s", (body) => {
  expect(resultValue(body)).toEqual({ status: "literal", value: 2 });
});

it("preserves exclusions shared by shallow-copy alternatives", () => {
  expect(
    resultValue(`
    const excluded = { value: 2 };
    const first = { value: 1 };
    const second = { value: 3 };
    const source = { excluded, first, second };
    const { excluded: leftExcluded, first: leftFirst, ...left } = source;
    const { excluded: rightExcluded, second: rightSecond, ...right } = source;
    const selected = flag ? left : right;
    mutate(selected);
    return excluded.value;
  `),
  ).toEqual({ status: "literal", value: 2 });
});

it("keeps a preceding global self-property replacement unresolved", () => {
  const facts = analyzeJavaScriptStaticSource(`
    import { Worker } from "node:worker_threads";
    globalThis.window = replacement;
    const selected = flag ? globalThis.window : globalThis;
    selected.URL = replacement;
    new Worker(new URL("./worker.js", import.meta.url));
  `);
  expect(
    facts.references.filter(({ kind }) => kind === "worker"),
  ).toMatchObject([{ specifier: null }]);
});

it.each([
  [
    "load",
    "inspect(load); load.d = replacement; inspect(load);",
    ["after", "before"],
  ],
  [
    "load",
    "inspect(load); function later() { load.d = replacement; }",
    ["unknown"],
  ],
  ["load", "inspect(load); if (flag) { load.d = replacement; }", ["unknown"]],
  [
    "load",
    "inspect(load); while (flag) { load.d = replacement; }",
    ["unknown"],
  ],
  [
    "load",
    "while (flag) { inspect(load); load.d = replacement; }",
    ["unknown"],
  ],
  ["load, value = (load.d = replacement)", "inspect(load);", ["unknown"]],
] as const)(
  "preserves parameter member provenance and activation ordering: (%s) %s",
  (parameters, body, timing) => {
    const parsed = parseJavaScriptSource(
      `function factory(${parameters}) { ${body} }`,
    );
    if (parsed === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    const sites: t.CallExpression[] = [];
    traverseJavaScriptAst(parsed.program, {
      enter: (node) => {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "inspect" })
        )
          sites.push(node);
      },
    });
    const originalTiming: string[] = [];
    const activationTiming: string[] = [];
    for (const site of sites) {
      const reference = site.arguments[0];
      if (!t.isIdentifier(reference))
        throw new Error("Expected parameter reference");
      const binding = index.bindingForReferenceAt(reference);
      expect(binding?.memberWrites).toEqual([
        expect.objectContaining({
          path: ["d"],
          node: expect.objectContaining({ type: "AssignmentExpression" }),
        }),
      ]);
      for (const [facts, output] of [
        [index.effectsForReferenceAt(site, reference, ["d"]), originalTiming],
        [
          index.effectsForReferenceWithinActivationAt(site, reference, ["d"]),
          activationTiming,
        ],
      ] as const) {
        const writes = facts.effects.filter(
          ({ kind }) => kind === "member-write",
        );
        expect(writes).toHaveLength(1);
        output.push(writes[0]!.timing);
      }
    }
    expect(originalTiming).toEqual(timing.map(() => "unknown"));
    expect(activationTiming).toEqual(timing);
  },
);

it("preserves exact member writes through an externally supplied caught value", () => {
  const parsed = parseJavaScriptSource(`
    try { throw external; } catch (caught) { caught.d = replacement; }
  `);
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const caught = [...index.bindings.bindingsById.values()].find(
    ({ name }) => name === "caught",
  );
  expect(caught?.memberWrites).toEqual([
    expect.objectContaining({
      path: ["d"],
      node: expect.objectContaining({ type: "AssignmentExpression" }),
    }),
  ]);
});

const indexedMemberEffects = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return [...index.bindings.bindingsById.values()];
};

it("records a write reached through two alias routes once", () => {
  // `c.y = 1` reaches `a.x` through `b` and through the later `c = a.x`.
  const a = indexedMemberEffects(`
    function f(a) {
      var b = a.x;
      var c = b;
      c.y = 1;
      c = a.x;
      c.y = 2;
    }
  `).find(({ name }) => name === "a");
  expect(
    a?.memberWrites.map(({ path, node, receiverIdentity }) => [
      path,
      t.isAssignmentExpression(node) && t.isNumericLiteral(node.right)
        ? node.right.value
        : undefined,
      receiverIdentity,
    ]),
  ).toEqual([
    [["x", "y"], 1, "possible"],
    [["x", "y"], 2, "definite"],
  ]);
});

it("keeps one record per stored fact for loop-carried register aliases", () => {
  const identities = new WeakMap<object, number>();
  let identityCount = 0;
  const identity = (value: object | undefined) => {
    if (value === undefined) return undefined;
    if (!identities.has(value)) identities.set(value, identityCount++);
    return identities.get(value);
  };
  const bindings = indexedMemberEffects(`
    function dispatch(a) {
      var b, c;
      for (b = a.target; b; ) {
        c = b;
        c.seen = 1;
        if ((c = b.owner)) { b = c; continue; }
        b = b.parentNode;
      }
    }
  `);
  const records = bindings.flatMap(({ memberWrites, escapedPaths }) => [
    memberWrites,
    escapedPaths,
  ]);
  expect(records.some((effects) => effects.length > 1)).toBe(true);
  for (const effects of records) {
    const facts = effects.map((effect) =>
      JSON.stringify([
        effect.path,
        identity(effect.node),
        identity(effect.receiverAt),
        effect.receiverIdentity,
        effect.receiverInitializers?.map((source) => identity(source)),
        effect.assignedSources?.map((source) => identity(source)),
      ]),
    );
    expect(new Set(facts).size).toBe(facts.length);
  }
});
