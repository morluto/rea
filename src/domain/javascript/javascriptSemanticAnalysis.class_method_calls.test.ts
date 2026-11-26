import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

// 4437 repro: exact this.sink at line 3, exact this.load at line 9,
// candidate outer plus inner exact at line 10, exact field load at line 13.
// Callers of load are lines 9, 10, 13; caller of sink is line 3.
const REPRO_4437 = [
  "class Backend {",
  "  load() { return 1; }",
  "  probe() { this.sink(); }",
  "  sink() { return 2; }",
  "  helper() { return new Backend(); }",
  "  store = new Backend();",
  "  fillerA() { return 0; }",
  "  fillerB() { return 0; }",
  "  runA() { this.load(); }",
  "  runB() { this.helper().load(); }",
  "  fillerC() { return 0; }",
  "  fillerD() { return 0; }",
  "  runC() { this.store.load(); }",
  "}",
].join("\n");

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "repro.js");
  if (parsed === null) throw new Error("Expected valid repro fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const bindingCache = new WeakMap<t.Identifier, LocalCallableResolution>();
  return {
    state,
    callableById,
    bindingCache,
    resolve: (node: t.Node) =>
      resolveLocalCallables({
        node,
        state,
        callableById,
        bindingCache,
        seenInitializers: new Set(),
      }),
  };
};

const callSitesOnLine = (
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
  line: number,
) =>
  ir.callSites.filter(
    ({ location, kind }) => location.start.line === line && kind === "call",
  );

const callersOf = (
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
  name: string,
) => {
  const target = onlyCallable(ir, name);
  return ir.callSites
    .filter(({ calleeCallableIds }) =>
      calleeCallableIds.includes(target.callableId),
    )
    .map(({ location }) => location.start.line)
    .sort((left, right) => left - right);
};

const CLASS_METHOD_NEGATIVES = [
  [
    "subclass override stays ambiguous",
    [
      "class Base { load() { return 1; } }",
      "class Derived extends Base { load() { return 2; } }",
      "const x = new Base();",
      "x.load();",
    ].join("\n"),
    /overrides or duplicate/iu,
    "ambiguous",
    "named-load",
  ],
  [
    "second field write stays ambiguous",
    [
      "class A { load() { return 1; } }",
      "class B { load() { return 2; } }",
      "class Consumer {",
      "  constructor() { this.store = new A(); this.store = new B(); }",
      "  run() { this.store.load(); }",
      "}",
    ].join("\n"),
    /multiple field writes/iu,
    "ambiguous",
    "named-load",
  ],
  [
    "prototype reassignment stays ambiguous",
    [
      "class Backend { load() { return 1; } }",
      "Backend.prototype.load = function() { return 2; };",
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
    "named-load-and-functions",
  ],
  [
    "instance reassignment stays ambiguous",
    [
      "class Backend { load() { return 1; } }",
      "const x = new Backend();",
      "x.load = function() { return 2; };",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
    "named-load-and-functions",
  ],
  [
    "computed method key stays ambiguous",
    [
      'const key = "load";',
      "class Backend { [key]() { return 1; } load() { return 2; } }",
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
    "named-load",
  ],
  [
    "computed call key stays unresolved",
    [
      "class Backend { load() { return 1; } }",
      "const x = new Backend();",
      'const key = "load";',
      "x[key]();",
    ].join("\n"),
    /computed/iu,
    "unresolved",
    "none",
  ],
  [
    "Object.assign mixin stays ambiguous",
    [
      "class Backend { load() { return 1; } }",
      "Object.assign(Backend.prototype, { extra() { return 2; } });",
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /reassigned or mixed/iu,
    "ambiguous",
    "named-load",
  ],
  [
    "imported class receiver stays unresolved",
    [
      'import { Backend } from "./backend.js";',
      "const x = new Backend();",
      "x.load();",
    ].join("\n"),
    /no single local class/iu,
    "unresolved",
    "none",
  ],
  [
    "parameter receiver stays unresolved",
    [
      "class Backend { load() { return 1; } }",
      "function run(item) { item.load(); }",
    ].join("\n"),
    /not a stable const/iu,
    "unresolved",
    "none",
  ],
  [
    "let reassigned receiver stays unresolved",
    [
      "class Backend { load() { return 1; } }",
      "let x = new Backend();",
      "x.load();",
    ].join("\n"),
    /not a stable const/iu,
    "unresolved",
    "none",
  ],
  [
    "getter returning two classes stays ambiguous",
    [
      "class A { load() { return 1; } }",
      "class B { load() { return 2; } }",
      "class Consumer {",
      "  helper(flag) { if (flag) { return new A(); } return new B(); }",
      "  run() { this.helper().load(); }",
      "}",
    ].join("\n"),
    /through a getter return/iu,
    "ambiguous",
    "named-load",
  ],
  [
    "getter returning external value stays unresolved",
    [
      "class Consumer {",
      "  helper() { return external; }",
      "  run() { this.helper().load(); }",
      "}",
    ].join("\n"),
    /Unresolved member receiver external/iu,
    "unresolved",
    "none",
  ],
  [
    "deep receiver chains stay unresolved",
    [
      "class Backend { load() { return 1; } }",
      "class Consumer {",
      "  constructor() { this.a = new Backend(); }",
      "  run() { this.a.b.load(); }",
      "}",
    ].join("\n"),
    /Unsupported/iu,
    "unresolved",
    "none",
  ],
] as const;

const memberCallSites = (
  source: string,
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
  name: string,
) => {
  const parsed = parseJavaScriptSource(source, "repro.js");
  if (parsed === null) throw new Error("Expected valid fixture");
  const positions = new Set<string>();
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return;
      const callee = node.callee;
      if (
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        !callee.computed &&
        t.isIdentifier(callee.property, { name }) &&
        callee.loc !== null &&
        callee.loc !== undefined
      )
        positions.add(
          `${String(callee.loc.start.line)}:${String(callee.loc.start.column)}:${String(callee.loc.end.column)}`,
        );
    },
  });
  return ir.callSites.filter(
    (site) =>
      site.kind === "call" &&
      positions.has(
        `${String(site.calleeLocation.start.line)}:${String(site.calleeLocation.start.column)}:${String(site.calleeLocation.end.column)}`,
      ),
  );
};

const expectedCandidateIds = (
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
  candidates: "none" | "named-load" | "named-load-and-functions",
): string[] => {
  if (candidates === "none") return [];
  const ids = ir.callables
    .filter((callable) => callable.name === "load")
    .map((callable) => callable.callableId);
  if (candidates === "named-load-and-functions") {
    for (const callable of ir.callables)
      if (callable.kind === "function" && callable.name === null)
        ids.push(callable.callableId);
  }
  return ids.sort();
};

const checkNegative = (
  source: string,
  reason: RegExp,
  resolution: "ambiguous" | "unresolved",
  candidates: "none" | "named-load" | "named-load-and-functions",
): void => {
  const ir = analyzeJavaScriptSemantics(source);
  const named = memberCallSites(source, ir, "load");
  // Computed calls have no static name; they are the only call in that fixture.
  const intended =
    named.length > 0
      ? named
      : ir.callSites.filter((site) => site.kind === "call");
  expect(intended.length).toBeGreaterThan(0);
  const expectedIds = expectedCandidateIds(ir, candidates);
  for (const target of intended) {
    expect(target.resolution).toBe(resolution);
    if (resolution === "ambiguous") {
      expect(target.calleeCallableIds.length).toBeGreaterThan(0);
      expect([...target.calleeCallableIds].sort()).toEqual(expectedIds);
    } else {
      expect(target.calleeCallableIds).toEqual([]);
    }
  }
  expect(ir.frontiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringMatching(reason) }),
    ]),
  );
};

describe("JavaScript semantic analysis: class method calls for #4437", () => {
  it("resolves exact edges for lines 3, 9, 13", () => {
    const ir = analyzeJavaScriptSemantics(REPRO_4437);
    const sink = onlyCallable(ir, "sink");
    const load = onlyCallable(ir, "load");
    const line3 = callSitesOnLine(ir, 3);
    expect(line3).toHaveLength(1);
    expect(line3[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [sink.callableId],
    });
    const line9 = callSitesOnLine(ir, 9);
    expect(line9).toHaveLength(1);
    expect(line9[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [load.callableId],
    });
    const line13 = callSitesOnLine(ir, 13);
    expect(line13).toHaveLength(1);
    expect(line13[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [load.callableId],
    });
  });

  it("keeps line 10 as candidate plus inner exact", () => {
    const ir = analyzeJavaScriptSemantics(REPRO_4437);
    const load = onlyCallable(ir, "load");
    const helper = onlyCallable(ir, "helper");
    const line10 = callSitesOnLine(ir, 10);
    expect(line10).toHaveLength(2);
    const outer = line10.find(({ calleeCallableIds }) =>
      calleeCallableIds.includes(load.callableId),
    );
    const inner = line10.find(({ calleeCallableIds }) =>
      calleeCallableIds.includes(helper.callableId),
    );
    expect(outer).toMatchObject({
      resolution: "ambiguous",
      calleeCallableIds: [load.callableId],
    });
    expect(inner).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [helper.callableId],
    });
    expect(ir.frontiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({
            start: expect.objectContaining({ line: 10 }),
          }),
          reason: expect.stringMatching(/through a getter return/iu),
        }),
      ]),
    );
  });

  it("traces callers to load at lines 9, 10, 13 and sink at line 3", () => {
    const ir = analyzeJavaScriptSemantics(REPRO_4437);
    expect(callersOf(ir, "load")).toEqual([9, 10, 13]);
    expect(callersOf(ir, "sink")).toEqual([3]);
  });

  it("resolves member targets through the resolver for #4437", () => {
    const context = indexed(REPRO_4437);
    const members: t.MemberExpression[] = [];
    traverseJavaScriptAst(context.state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          (t.isMemberExpression(node.callee) ||
            t.isOptionalMemberExpression(node.callee))
        )
          members.push(node.callee as t.MemberExpression);
      },
    });
    const byCalleeLine = (line: number) =>
      members.filter(
        (member) =>
          context.state.parentsByNode.get(member)?.type === "CallExpression" &&
          member.loc?.start.line === line,
      );
    for (const line of [3, 9, 13]) {
      const found = byCalleeLine(line);
      expect(found).toHaveLength(1);
      const resolved = context.resolve(found[0] as t.Node);
      expect(resolved.callableIds).toHaveLength(1);
      expect(resolved.complete).toBe(true);
    }
    expect(byCalleeLine(10)).toHaveLength(2);
    const outer = context.resolve(
      members.find(
        (member) =>
          member.loc?.start.line === 10 &&
          member.loc.start.column === 11 &&
          (member.property as t.Identifier).name === "load",
      ) as t.Node,
    );
    expect(outer.callableIds).toHaveLength(1);
    expect(outer.complete).toBe(false);
  });
});

describe("JavaScript semantic analysis: class method call negatives", () => {
  it.each(CLASS_METHOD_NEGATIVES)(
    "never resolves exact for %s",
    (_name, source, reason, resolution, candidates) => {
      checkNegative(source, reason, resolution, candidates);
    },
  );
});

describe("JavaScript semantic analysis: fail-closed member edges", () => {
  it("does not mark a shadowed instance field exact", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } load = () => 2; }",
        "const x = new Backend();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 3);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
    expect(site[0]?.calleeCallableIds).toEqual([]);
  });

  it("does not mark a constructor-replaced instance exact", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { constructor() { return { load() {} }; } load() { return 1; } }",
        "const x = new Backend();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 3);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not prove a field written only in an ordinary method", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "class Consumer {",
        "  run() { this.store.load(); }",
        "  setup() { this.store = new Backend(); }",
        "}",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 3);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not keep a stale field target after an alias write", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class A { load() { return 1; } }",
        "class B { load() { return 2; } }",
        "class Consumer {",
        "  store = new A();",
        "  run() { const self = this; self.store = new B(); this.store.load(); }",
        "}",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 5);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not treat a transitive override as exact", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class A { load() { return 1; } run() { this.load(); } }",
        "class B extends A {}",
        "class C extends B { load() { return 2; } }",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 1);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("ambiguous");
    expect(site[0]?.calleeCallableIds.length).toBeGreaterThan(1);
  });

  it("does not invent a caller through an async helper", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "class Consumer {",
        "  async helper() { return new Backend(); }",
        "  run() { this.helper().load(); }",
        "}",
      ].join("\n"),
    );
    const load = onlyCallable(ir, "load");
    expect(
      ir.callSites.some(({ calleeCallableIds }) =>
        calleeCallableIds.includes(load.callableId),
      ),
    ).toBe(false);
  });

  it("keeps an exact call beside an unrelated Object.assign", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } run() { this.load(); } }",
        "Object.assign({}, { extra: 1 });",
      ].join("\n"),
    );
    const load = onlyCallable(ir, "load");
    expect(callSitesOnLine(ir, 1)[0]).toMatchObject({
      resolution: "exact",
      calleeCallableIds: [load.callableId],
    });
  });

  it("does not prove a conditional imported constructor", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        'import { Imported } from "./imported.js";',
        "class Local { load() { return 1; } }",
        "const flag = true;",
        "const x = new (flag ? Local : Imported)();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 5);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });
});

describe("JavaScript semantic analysis: fail-closed review edges", () => {
  it("does not mark a decorated method exact", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "function replace(target) { return target; }",
        "class Backend { @replace load() { return 1; } }",
        "const x = new Backend();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 4);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).not.toBe("exact");
  });

  it("does not treat static-block this as an instance receiver", () => {
    const ir = analyzeJavaScriptSemantics(
      "class Backend { static load() { return 1; } load() { return 2; } static { this.load(); } }",
    );
    const site = callSitesOnLine(ir, 1);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not prove an aliased constructor with an imported arm", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        'import { Imported } from "./imported.js";',
        "class Local { load() { return 1; } }",
        "const flag = true;",
        "const K = flag ? Local : Imported;",
        "const x = new K();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 6);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not prove a class whose base constructor is unseen", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        'import Base from "./base.js";',
        "class Derived extends Base { load() { return 1; } }",
        "const x = new Derived();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 4);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not treat an uncalled constructor arrow as a field write", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "class Consumer {",
        "  constructor() { const setup = () => { this.store = new Backend(); }; }",
        "  run() { this.store.load(); }",
        "}",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 4);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not prove a method hidden by a base field", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Base { load = () => 2; }",
        "class Derived extends Base { load() { return 1; } }",
        "const x = new Derived();",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 4);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).toBe("unresolved");
  });

  it("does not keep a deleted prototype method exact", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "const x = new Backend();",
        "delete Backend.prototype.load;",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 4);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).not.toBe("exact");
  });

  it("does not keep the original method after an instance mixin", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "const x = new Backend();",
        "Object.assign(x, { load() { return 2; } });",
        "x.load();",
      ].join("\n"),
    );
    const site = callSitesOnLine(ir, 4);
    expect(site).toHaveLength(1);
    expect(site[0]?.resolution).not.toBe("exact");
  });

  it("does not follow a helper hidden by a field", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "class Consumer {",
        "  helper() { return new Backend(); }",
        "  helper = () => null;",
        "  run() { this.helper().load(); }",
        "}",
      ].join("\n"),
    );
    const load = onlyCallable(ir, "load");
    expect(
      ir.callSites.some(({ calleeCallableIds }) =>
        calleeCallableIds.includes(load.callableId),
      ),
    ).toBe(false);
  });

  it("does not revive a poisoned field through a helper return", () => {
    const ir = analyzeJavaScriptSemantics(
      [
        "class Backend { load() { return 1; } }",
        "class Consumer {",
        "  store = new Backend();",
        "  helper() { return this.store; }",
        "  run() { this.store = null; this.helper().load(); }",
        "}",
      ].join("\n"),
    );
    const load = onlyCallable(ir, "load");
    expect(
      ir.callSites.some(({ calleeCallableIds }) =>
        calleeCallableIds.includes(load.callableId),
      ),
    ).toBe(false);
  });
});
