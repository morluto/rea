import { createRequire, wrap } from "node:module";
import { runInThisContext } from "node:vm";

import { expect, it } from "vitest";

import { analyzeCommonJsStaticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

it.each([false, true])(
  "preserves only untouched authored CommonJS dirname vars: assigned=%s",
  (assigned) => {
    const setup = `const path=require('node:path/posix');var __dirname;${assigned ? '__dirname="relative";' : ""}`;
    const fixture = { exports: "" };
    const run = runInThisContext(
      wrap(`${setup}module.exports=path.join(__dirname,'preload.cjs');`),
    );
    run(
      fixture.exports,
      createRequire(import.meta.url),
      fixture,
      "/source/app/main.cjs",
      "/source/app",
    );
    expect(fixture.exports).toBe(
      assigned ? "relative/preload.cjs" : "/source/app/preload.cjs",
    );
    const analysis = analyzeCommonJsStaticFixture(
      `${setup}
      const {BrowserWindow, utilityProcess} = require('electron');
      new BrowserWindow({webPreferences:{preload:path.join(__dirname,'preload.cjs')}});
      utilityProcess.fork(path.join(__dirname,'worker.cjs'));`,
    );
    expect(analysis.electron.browser_windows).toMatchObject([
      { preload_path: assigned ? null : "preload.cjs" },
    ]);
    expect(analysis.electron.utility_processes).toMatchObject([
      { module_path: assigned ? null : "worker.cjs" },
    ]);
  },
);

it.each([false, true])(
  "preserves a decoded module URL through its real dirname owner: local=%s",
  (local) => {
    const analysis = analyzeCommonJsStaticFixture(`
      import path from 'node:path';import*as url from 'node:url';
      const helper={dirname:()=>'/other'};const{BrowserWindow}=require('electron');
      new BrowserWindow({webPreferences:{preload:path.resolve(runtimeBase,${local ? "helper" : "path"}.dirname(url.fileURLToPath(import.meta.url)),'preload.cjs')}});
    `);
    expect(analysis.electron.browser_windows).toMatchObject([
      {
        preload_path: local ? null : "preload.cjs",
        preload_resolution_context: local ? null : "filesystem-expression",
      },
    ]);
  },
);

it("does not use a URL string as a filesystem source-file anchor", () => {
  const analysis = analyzeCommonJsStaticFixture(
    `import path from 'node:path';const{BrowserWindow}=require('electron');new BrowserWindow({webPreferences:{preload:path.resolve(runtimeBase,path.dirname(import.meta.url),'decoy.cjs')}});`,
  );
  expect(analysis.electron.browser_windows).toMatchObject([
    { preload_path: null },
  ]);
});

it.each([false, true])(
  "proves the CommonJS filename dirname owner: local=%s",
  (local) => {
    const analysis = analyzeCommonJsStaticFixture(
      `const path=require('node:path');const helper={dirname:()=>'.'};const{BrowserWindow}=require('electron');new BrowserWindow({webPreferences:{preload:path.resolve(runtimeBase,${local ? "helper" : "path"}.dirname(__filename),'decoy.cjs')}});`,
    );
    expect(analysis.electron.browser_windows).toMatchObject([
      { preload_path: local ? null : "decoy.cjs" },
    ]);
  },
);
