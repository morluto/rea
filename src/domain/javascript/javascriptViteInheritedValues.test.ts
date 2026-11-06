import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const helper = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./first.js","./last.js"])))=>i.map(i=>d[i]);`;
const candidates = (source: string) =>
  analyzeJavaScriptStaticSource(helper + source)
    .references.filter(({ kind }) => kind === "vite-table-candidate")
    .map(({ specifier }) => specifier);

describe("Vite inherited dependency values", () => {
  it("does not treat replaced shared array prototype methods as read-only", () => {
    for (const method of [
      "at",
      "includes",
      "indexOf",
      "lastIndexOf",
      "slice",
    ]) {
      const effect = `__vite__mapDeps([0]); const cache=__vite__mapDeps.f; const proto=cache.__proto__; proto.${method}=function(){this[0]='./last.js'}; cache.${method}(); __vite__mapDeps([0]);`;
      expect(candidates(effect)).toEqual([null, null]);
      expect(Array.from(runInNewContext(helper + effect))).toEqual([
        "./last.js",
      ]);
    }
    const safe = `__vite__mapDeps([0]); const cache=__vite__mapDeps.f; const proto=cache.__proto__; proto.unrelated=function(){}; cache.slice(); __vite__mapDeps([0]);`;
    expect(candidates(safe)).toEqual(["./first.js", "./first.js"]);
    const nested = `__vite__mapDeps([0]); const cache=__vite__mapDeps.f; const proto=cache.__proto__; proto.slice=function(){this[0]='./last.js'}; {const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=['./second.js'])))=>i.map(i=>d[i]); __vite__mapDeps([0]); __vite__mapDeps.f.slice(); __vite__mapDeps([0]);}`;
    expect(candidates(nested)).toEqual([null, null, null]);
    expect(Array.from(runInNewContext(helper + nested))).toEqual(["./last.js"]);
    const ambient = nested.replace(
      "proto.slice=function()",
      "Array.prototype.slice=function()",
    );
    expect(candidates(ambient)).toEqual([null, null, null]);
  });
  it("copies enumerable prototype values without copying prototype identity", () => {
    const init = `const proto=__vite__mapDeps(['__proto__'])[0];`;
    for (const copy of [
      `const copy={...proto};`,
      `const {...copy}=proto;`,
      `const copy=Object.assign({},proto);`,
    ]) {
      expect(
        candidates(init + copy + ` opaque(copy); __vite__mapDeps([0]);`),
      ).toEqual([null, "./first.js"]);
      expect(
        candidates(
          init +
            ` proto.extra=proto; ` +
            copy +
            ` opaque(copy); __vite__mapDeps([0]);`,
        ),
      ).toEqual([null, null]);
    }
    const getter = `Object.defineProperty(proto,'x',{enumerable:true,get(){return proto}});`;
    expect(
      candidates(
        init +
          getter +
          `const copy={...proto}; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    expect(
      candidates(
        `const proto = flag ? Array.prototype : external; const copy={...proto}; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null]);
    expect(
      candidates(
        init +
          `opaque(proto); const copy={...proto}; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    expect(
      candidates(
        init + `const copy=[...proto]; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, "./first.js"]);
    expect(
      candidates(
        init + `const copy=[proto]; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    expect(
      candidates(
        init +
          `const {x,...copy}={x:1,p:proto}; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    expect(
      candidates(
        init +
          `const copy={...proto}; proto.extra=proto; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, "./first.js"]);
    expect(
      candidates(
        init +
          `const first={...proto}; proto.extra=proto; const second={...proto}; opaque(first); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, "./first.js"]);
    expect(
      candidates(
        init +
          `const first={...proto}; proto.extra=proto; const second={...proto}; opaque(second); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    const setter = `Object.defineProperty(proto,'extra',{set(v){v.map=()=>['./last.js']},configurable:true}); const copy={...proto}; proto.extra=proto; opaque(copy); __vite__mapDeps([0]);`;
    expect(candidates(init + setter)).toEqual([null, null]);
    expect(
      Array.from(runInNewContext(helper + init + setter, { opaque: () => {} })),
    ).toEqual(["./last.js"]);
    const getterWrite = `Object.defineProperty(proto,'x',{enumerable:true,get(){__vite__mapDeps.f[0]='./last.js';return 1}}); const copy={...proto}; __vite__mapDeps([0]);`;
    expect(candidates(init + getterWrite)).toEqual([null, null]);
    expect(Array.from(runInNewContext(helper + init + getterWrite))).toEqual([
      "./last.js",
    ]);
    const changed =
      init +
      `proto.extra=proto; const copy={...proto}; opaque(copy); __vite__mapDeps([0]);`;
    expect(
      Array.from(
        runInNewContext(helper + changed, {
          opaque: (value: { extra: { map: () => string[] } }) => {
            value.extra.map = () => ["./last.js"];
          },
        }),
      ),
    ).toEqual(["./last.js"]);
  });
});

describe("Vite intrinsic prototype effects", () => {
  it("retains effects from unproven property descriptors", () => {
    for (const method of ["Object.defineProperty", "Reflect.defineProperty"]) {
      const effect = `${method}(Array.prototype, 'foo', externalDescriptor); __vite__mapDeps([0]);`;
      expect(candidates(effect)).toEqual([null]);
      const setup = `const externalDescriptor={get configurable(){Array.prototype.map=()=>['./last.js'];return true},value:1};`;
      expect(Array.from(runInNewContext(setup + helper + effect))).toEqual([
        "./last.js",
      ]);
    }
  });
  it("invalidates caches when an intrinsic prototype escapes directly or through an alias", () => {
    for (const effect of [
      `opaque(Array.prototype);`,
      `const p=Array.prototype; opaque(p);`,
      `const box={x:Array.prototype}; opaque(box);`,
      `const box={}; Object.setPrototypeOf(box, Array.prototype); opaque(box);`,
      `Object.setPrototypeOf(external, Array.prototype);`,
    ]) {
      expect(candidates(effect + ` __vite__mapDeps([0]);`)).toEqual([null]);
    }
    const source = helper + `opaque(Array.prototype); __vite__mapDeps([0]);`;
    expect(
      Array.from(
        runInNewContext(source, {
          opaque: (value: { map: () => string[] }) => {
            value.map = () => ["./last.js"];
          },
        }),
      ),
    ).toEqual(["./last.js"]);
  });
  it("keeps unrelated direct intrinsic writes and prototype assignments precise", () => {
    expect(
      candidates(`Array.prototype[2] = 1; __vite__mapDeps([,0]);`),
    ).toEqual(["./first.js"]);
    expect(
      candidates(
        `const getProto = Object.getPrototypeOf; const proto = {}; const box = {}; box.object = Object.create(proto); const captured = getProto(box.object); Object.setPrototypeOf(box.object, Array.prototype); captured.label = 1; __vite__mapDeps([0]);`,
      ),
    ).toEqual(["./first.js"]);
    expect(
      candidates(
        `Object.defineProperty(Array.prototype, "1", {get() { this[0] = "./last.js"; return 1; }, configurable: true}); __vite__mapDeps([1], void 0, []); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, "./first.js"]);
    const source =
      helper.replace(
        '["./first.js","./last.js"]',
        '["./first.js",null,"./last.js"]',
      ) +
      `Object.defineProperty(Array.prototype,"1",{get(){return 1},configurable:true}); __vite__mapDeps([1,2]);`;
    expect(
      analyzeJavaScriptStaticSource(source)
        .references.filter(({ kind }) => kind === "vite-table-candidate")
        .map(({ specifier }) => specifier),
    ).toEqual([null, "./last.js"]);
  });
});

describe("Vite selected table values", () => {
  it("distinguishes independent owned values from inherited prototypes", () => {
    for (const key of ["constructor", "__proto__"]) {
      const effect = `const values=__vite__mapDeps([${JSON.stringify(key)}], void 0, {[${JSON.stringify(key)}]: {}}); opaque(values); __vite__mapDeps([0]);`;
      expect(
        Array.from(runInNewContext(helper + effect, { opaque: () => {} })),
      ).toEqual(["./first.js"]);
      expect(candidates(effect)).toEqual([null, "./first.js"]);
    }
  });

  it("retains an explicit shared prototype stored under an arbitrary own key", () => {
    for (const value of [
      "Array.prototype",
      "globalThis.Array.prototype",
      "Object.prototype",
      "Array",
    ]) {
      const effect = `const values=__vite__mapDeps(['foo'], void 0, {foo:${value}}); opaque(values); __vite__mapDeps([0]);`;
      expect(candidates(effect)).toEqual([null, null]);
    }
    const effect = `const values=__vite__mapDeps(['foo'], void 0, {foo:Array.prototype}); opaque(values); __vite__mapDeps([0]);`;
    expect(
      candidates(
        `const values=__vite__mapDeps(['foo'], void 0, {foo:Array.prototype}); opaque(values[0]); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    expect(
      Array.from(
        runInNewContext(helper + effect, {
          opaque: (values: { map: () => string[] }[]) => {
            const value = values[0];
            if (value !== undefined) value.map = () => ["./last.js"];
          },
        }),
      ),
    ).toEqual(["./last.js"]);
  });

  it("retains possible inherited values after a table property is deleted", () => {
    const effect = `const table = { constructor: {} }; delete table.constructor; const values=__vite__mapDeps(['constructor'], void 0, table); opaque(values); __vite__mapDeps([0]);`;
    expect(candidates(effect)).toEqual([null, null]);
  });

  it("respects table writes after the mapped selection", () => {
    const effect = `const table = { constructor: {} }; const values=__vite__mapDeps(['constructor'], void 0, table); delete table.constructor; opaque(values); __vite__mapDeps([0]);`;
    expect(candidates(effect)).toEqual([null, "./first.js"]);
  });

  it("tracks a prototype returned by an own getter", () => {
    const effect = `const values=__vite__mapDeps(['constructor'], void 0, {get constructor() { return Array.prototype; }}); opaque(values); __vite__mapDeps([0]);`;
    expect(candidates(effect)).toEqual([null, null]);
  });

  it("does not assume an unknown own value is independent", () => {
    for (const table of ["{foo:external}", "[external]"]) {
      const key = table.startsWith("{") ? "'foo'" : "0";
      expect(
        candidates(
          `const values=__vite__mapDeps([${key}],void 0,${table}); opaque(values); __vite__mapDeps([0]);`,
        ),
      ).toEqual([null, null]);
    }
  });

  it("does not assume an unknown supplied table is independent", () => {
    const effect = `const values=__vite__mapDeps(['foo'],void 0,makeTable()); opaque(values); __vite__mapDeps([0]);`;
    expect(candidates(effect)).toEqual([null, null]);
  });

  it("tracks an arbitrary slot replaced before mapping and preserves known values", () => {
    const changed = `const table={foo:{}}; table.foo=Array.prototype; const values=__vite__mapDeps(['foo'],void 0,table); opaque(values); __vite__mapDeps([0]);`;
    expect(candidates(changed)).toEqual([null, null]);
    expect(
      candidates(
        `const values=__vite__mapDeps([0]); opaque(values); __vite__mapDeps([0]);`,
      ),
    ).toEqual(["./first.js", "./first.js"]);
  });
});

describe("Vite inherited prototype and iteration effects", () => {
  it("retains possible inherited prototype effects separately from table elements", () => {
    const effect = `const key="__proto__"; const proto=__vite__mapDeps([key])[0]; proto.map=function(){return ["./last.js"]}; __vite__mapDeps([0]);`;
    expect(Array.from(runInNewContext(helper + effect))).toEqual(["./last.js"]);
    expect(candidates(effect)).toEqual([null, null]);
    expect(
      candidates(
        `const key="__proto__"; const proto=__vite__mapDeps([key])[0]; proto.irrelevant=1; __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, "./first.js"]);
    expect(
      candidates(
        `const key="__proto__"; const proto=__vite__mapDeps([key])[0]; opaque(proto); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
    expect(
      candidates(
        `const key="constructor"; const proto=__vite__mapDeps([key])[0]; proto.prototype.map=()=>["./last.js"]; __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
  });

  it.each([
    `Object.defineProperty(proto, "map", { value: () => ["./last.js"] });`,
    `Object.assign(proto, { map: () => ["./last.js"] });`,
    `proto.change = function() { this.map = () => ["./last.js"]; }; proto.change();`,
    `external.saved = proto;`,
  ])("retains inherited prototype exposure through %s", (effect) => {
    expect(
      candidates(
        `const key = "__proto__"; const proto = __vite__mapDeps([key])[0]; ${effect} __vite__mapDeps([0]);`,
      ),
    ).toEqual([null, null]);
  });

  it("exposes only iterated values to for-await thenable hooks", () => {
    const init = `const initialize=__vite__mapDeps; initialize([]);`;
    expect(
      candidates(
        init +
          `const items=["text"]; items.extra=__vite__mapDeps.f; for await (const x of items) { void x; } __vite__mapDeps([0]);`,
      ),
    ).toEqual(["./first.js"]);
    expect(
      candidates(
        init +
          `const items=[__vite__mapDeps.f]; for await (const x of items) { void x; } __vite__mapDeps([0]);`,
      ),
    ).toEqual([null]);
  });

  it("copies only array elements for array spread and keeps object spread semantics", () => {
    const init = `const initialize=__vite__mapDeps; initialize([]);`;
    const source = `const items=["text"]; items.extra=__vite__mapDeps.f;`;
    expect(
      candidates(
        init +
          source +
          `const copy=[...items]; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual(["./first.js"]);
    expect(
      candidates(
        init +
          source +
          `const copy={...items}; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null]);
    expect(
      candidates(
        init +
          `const items=[__vite__mapDeps.f]; const copy=[...items]; opaque(copy); __vite__mapDeps([0]);`,
      ),
    ).toEqual([null]);
  });
});
