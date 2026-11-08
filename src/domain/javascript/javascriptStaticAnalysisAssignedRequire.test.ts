import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  [
    "const values={*[Symbol.iterator](){yield module;}};const h={};[h.loader]=values;h.loader",
    true,
  ],
  [
    "const values=[{}];values[Symbol.iterator]=function*(){yield module;};const h={};[h.loader]=values;h.loader",
    true,
  ],
  [
    "const values={*[Symbol.iterator](){yield module;}};const [api]=values;api",
    true,
  ],
  [
    "const values={*[Symbol.iterator](){yield module;}};const [...api]=values;api[0]",
    true,
  ],
  [
    "Array.prototype[Symbol.iterator]=function*(){yield module;};const [api]=[{}];api",
    true,
  ],
  ["const h={};[h.loader]=[{}];h.loader", false],
  ["const [api]=[{}];api", false],
  ["const [api]=module;api", true],
])("keeps custom iterable selections unknown: %s", (source, expected) => {
  const analysis = analyzeJavaScriptStaticSource(
    `${source}.require('./shared.cjs');`,
  );
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.references).toEqual(
    expected
      ? [expect.objectContaining({ kind: "require", specifier: null })]
      : [],
  );
});

it.each(["??=", "||=", "&&="])(
  "retains possible logical assignment module sources for %s",
  (operator) => {
    const analysis = analyzeJavaScriptStaticSource(`
      const h={ loader: choose() };
      h.loader ${operator} module;
      h.loader.require=replacement;
      require('./shared.cjs');
    `);
    expect(analysis.references).toEqual([
      expect.objectContaining({ kind: "require", specifier: null }),
    ]);
  },
);

it.each(["??=", "||=", "&&="])(
  "keeps logical assignment local sources separate for %s",
  (operator) => {
    const analysis = analyzeJavaScriptStaticSource(`
      const h={ loader: {} };
      h.loader ${operator} { require() {} };
      h.loader.require=replacement;
      require('./shared.cjs');
    `);
    expect(analysis.references).toEqual([
      expect.objectContaining({ kind: "require", specifier: "./shared.cjs" }),
    ]);
  },
);

it.each(["??=", "||=", "&&="])(
  "keeps a load before a later logical module assignment for %s",
  (operator) => {
    const analysis = analyzeJavaScriptStaticSource(`
      require('./shared.cjs');
      const h={ loader: choose() };
      h.loader ${operator} module;
      h.loader.require=replacement;
    `);
    expect(analysis.references).toEqual([
      expect.objectContaining({ kind: "require", specifier: "./shared.cjs" }),
    ]);
  },
);

it.each([
  ["const {...h}={loader:module};h.loader", true],
  ["const [...h]=[module];h[0]", true],
  ["const [ignored,...h]=[{},module];h[0]", true],
  ["const {ignored,...h}={ignored:module,loader:module};h.loader", true],
  ["const {loader:ignored,...h}={loader:module};h.loader", false],
  ["const {...h}=module;h", false],
  ["const [...h]=[module];h", false],
  ["const {...h}={loader:module.exports};h.loader", false],
  ["const [...h]=[{}];h[0]", false],
])(
  "preserves child identities of declaration rest copies: %s",
  (source, expected) => {
    const analysis = analyzeJavaScriptStaticSource(
      `${source}.require('./shared.cjs');`,
    );
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.references).toEqual(
      expected
        ? [expect.objectContaining({ kind: "require", specifier: null })]
        : [],
    );
  },
);

it.each([
  ["({x:h.loader}={x:module});h.loader", true],
  ["[h.loader]=[module];h.loader", true],
  ["({x:[{y:h.loader}]}={x:[{y:module}]});h.loader", true],
  ["({x:h.loader=module}={});h.loader", true],
  ["({x:{y:h.loader=module}={}}={});h.loader", true],
  ["({[key]:h.loader}={x:module});h.loader", true],
  ["({['x']:h.loader}={x:module});h.loader", true],
  ["[ignore,...h.loader]=[{},module];h.loader[0]", true],
  ["({...h.loader}={loader:module});h.loader.loader", true],
  ["({exports:h.loader}=module);h.loader", false],
  ["({...h.loader}=module);h.loader", false],
  ["({x:ignore,...h.loader}={x:module});h.loader.x", false],
  ["({x:h.loader=module}={x:{}});h.loader", false],
  ["h.loader=module;({x:h.loader}={x:{}});h.loader", false],
  ["({a:h.loader,b:h.loader}={a:module,b:{}});h.loader", false],
  ["({a:h.loader,b:h.loader}={a:{},b:module});h.loader", true],
  ["({x:h.a,y:h.b}={x:{},y:module});h.a", false],
  ["({x:h.a,y:h.b}={x:{},y:module});h.b", true],
])("preserves selected assigned module sources: %s", (assignment, expected) => {
  const analysis = analyzeJavaScriptStaticSource(
    `const h={};${assignment}.require('./shared.cjs');`,
  );
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.references).toEqual(
    expected
      ? [expect.objectContaining({ kind: "require", specifier: null })]
      : [],
  );
});

it("retains a destructured member delegate call", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `const h={};({load:h.load}={load:module.require});h.load.call(module,'./shared.cjs');`,
  );
  expect(analysis.references).toEqual([
    expect.objectContaining({ kind: "require", specifier: null }),
  ]);
});

it("revokes the host delegate after a destructured module receiver write", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `const h={};({x:h.loader}={x:module});h.loader.require=replacement;require('./shared.cjs');`,
  );
  expect(analysis.references).toEqual([
    expect.objectContaining({ kind: "require", specifier: null }),
  ]);
});

it("revokes the host delegate after a dynamic defineProperty on module", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `Object.defineProperty(module,key,{value:x});require('./shared.cjs');`,
  );
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.references).toEqual([
    expect.objectContaining({ kind: "require", specifier: null }),
  ]);
});

// Zod's issue formatter (`r = s` after `Object.defineProperty(r, k, …)`)
// exhausts the alias-selection budget. A strict module check stays unproven.
const loopAliasedPropertyWalk = (defineProperty: boolean): string => {
  const step = defineProperty
    ? "Object.prototype.hasOwnProperty.call(r,k)||Object.defineProperty(r,k,{value:{_errors:[]}});"
    : "Object.prototype.hasOwnProperty.call(r,k);";
  return `let h=require("electron");function f(n,e){let r=n,i=0;for(;i<e.length;){let k=e[i];${step}let s=r[k];r=s,i++}return r}new h.BrowserWindow({webPreferences:{sandbox:!0}});h.ipcMain.handle(\`x:y\`,()=>1);`;
};

const expectElectronProbe = (
  source: string,
): ReturnType<typeof analyzeJavaScriptStaticSource> => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.electron.browser_windows).toHaveLength(1);
  expect(analysis.electron.ipc).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ channel: "x:y", side: "main" }),
    ]),
  );
  expect(analysis.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "require", specifier: "electron" }),
    ]),
  );
  return analysis;
};

it("keeps electron facts when a loop-aliased defineProperty exhausts alias selections", () => {
  const analysis = expectElectronProbe(loopAliasedPropertyWalk(true));
  expect(analysis.analysis_coverage).toMatchObject({
    examination: {
      semantic_resource_limits: expect.arrayContaining(["alias-selections"]),
    },
  });
});

it("keeps electron facts for the same path walk without defineProperty", () => {
  expectElectronProbe(loopAliasedPropertyWalk(false));
});

// A strict check that exhausts the budget still examines queued sources by
// their selected keys, so the result does not depend on branch order.
const exhaustedWalkWrite = (receiver: string): string =>
  `const m=module,g=()=>module;function f(n,e,flag){let r=n,i=0;for(;i<e.length;){let k=e[i];Object.prototype.hasOwnProperty.call(r,k)||Object.defineProperty(r,k,{value:{_errors:[]}});let s=r[k];r=s,i++}${receiver}.require=replacement;return r}let h=require("electron");new h.BrowserWindow({});`;

it.each([
  "(flag?module:r)",
  "(flag?r:module)",
  "(flag?(0,module):r)",
  "(flag?r:(0,module))",
  "(flag?process.mainModule:r)",
  "(flag?r:process.mainModule)",
  "(flag?m:r)",
  "(flag?r:m)",
  "(flag?g():r)",
  "(flag?r:g())",
])(
  "revokes the host delegate through %s after alias selections are exhausted",
  (receiver) => {
    const analysis = analyzeJavaScriptStaticSource(
      exhaustedWalkWrite(receiver),
    );
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.electron.browser_windows).toHaveLength(0);
    expect(analysis.references).toEqual([
      expect.objectContaining({ kind: "require", specifier: null }),
    ]);
  },
);

it.each(["(flag?process.foo:r)", "(flag?r:process.foo)"])(
  "keeps the host delegate through %s after alias selections are exhausted",
  (receiver) => {
    const analysis = analyzeJavaScriptStaticSource(
      exhaustedWalkWrite(receiver),
    );
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.electron.browser_windows).toHaveLength(1);
  },
);
