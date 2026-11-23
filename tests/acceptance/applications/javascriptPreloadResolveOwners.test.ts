import { posix } from "node:path";
import { runInNewContext } from "node:vm";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    [
      {
        name: "local helper",
        declaration: "const helper={resolve(value){return value}};",
        expression: 'helper.resolve(runtimePath,__dirname,"decoy.cjs")',
        preload: null,
      },
      {
        name: "Node path resolver",
        declaration: 'const path=require("node:path");',
        expression: 'path.resolve(runtimePath,__dirname,"decoy.cjs")',
        preload: "decoy.cjs",
      },
      {
        name: "untouched CommonJS directory parameter",
        declaration: 'var __dirname;const path=require("node:path");',
        expression: 'path.join(__dirname,"decoy.cjs")',
        preload: "decoy.cjs",
      },
      {
        name: "local dirname helper",
        declaration:
          'import path from "node:path";const helper={dirname(){return "/local"}};',
        expression:
          'path.resolve(runtimePath,helper.dirname(import.meta.url),"decoy.cjs")',
        preload: null,
        mainFile: "main.mjs",
      },
      {
        name: "Node dirname and source URL",
        declaration:
          'import path from "node:path";import {fileURLToPath} from "node:url";',
        expression:
          'path.resolve(runtimePath,path.dirname(fileURLToPath(import.meta.url)),"decoy.cjs")',
        preload: "decoy.cjs",
        mainFile: "main.mjs",
      },
      {
        name: "separate default path write",
        declaration:
          'import changed from "node:path";import path from "path";changed.resolve=first=>first;',
        expression: 'path.resolve(runtimePath,__dirname,"decoy.cjs")',
        preload: null,
        mainFile: "main.mjs",
      },
      {
        name: "separate default URL write",
        declaration:
          'import changed from "node:url";import url from "url";import path from "node:path";changed.fileURLToPath=()=>"/changed/main.mjs";',
        expression:
          'path.resolve(runtimePath,path.dirname(url.fileURLToPath(import.meta.url)),"decoy.cjs")',
        preload: null,
        mainFile: "main.mjs",
      },
      {
        name: "shadowed directory",
        declaration: 'const path=require("node:path");',
        expression: 'path.resolve(runtimePath,__dirname,"decoy.cjs")',
        preload: null,
        scopeStart: "function build(__dirname){",
        scopeEnd: "}build('local-directory');",
      },
    ].map((testCase) => ({
      surface,
      scopeStart: "",
      scopeEnd: "",
      mainFile: "main.cjs",
      ...testCase,
    })),
  ),
)(
  "requires the $name owner for preload resolve semantics through $surface",
  async (
    {
      surface,
      declaration,
      expression,
      preload,
      scopeStart,
      scopeEnd,
      mainFile,
    },
    { cli },
  ) => {
    const root = await createTestTempDirectory("rea-preload-resolve-owner-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ main: mainFile }),
      [mainFile]: `throw new Error('Static fixture must never execute');${mainFile.endsWith(".mjs") ? "import {BrowserWindow} from 'electron';" : "const {BrowserWindow}=require('electron');"}${declaration}${scopeStart}new BrowserWindow({webPreferences:{preload:${expression}}});${scopeEnd}`,
      "decoy.cjs": "throw new Error('Static preload must never execute');",
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);
    const windows = graph.nodes.filter(({ kind }) => kind === "browser-window");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.observations[0]?.properties.preload_path).toBe(preload);
    const associations = graph.edges.filter(
      ({ source_node_id, evidence }) =>
        source_node_id === windows[0]?.node_id &&
        evidence.extractor.operation === "associate-browser-window-preload",
    );
    if (preload === null) expect(associations).toEqual([]);
    else
      expect(associations).toEqual([
        expect.objectContaining({
          relation: "loads",
          properties: expect.objectContaining({
            resolved_path: preload,
            resolution_status: "resolved",
          }),
        }),
      ]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps unproven source-directory compositions unknown through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-path-base-");
    const expressions = [
      'path.join("prefix",__dirname,"decoy.cjs")',
      'path.join(__dirname,__dirname,"decoy.cjs")',
      'path.join(__dirname,path.join(__dirname,"decoy.cjs"))',
      'path.join(__dirname,"control.cjs")',
    ];
    const runtime = expressions.map((expression) =>
      runInNewContext(expression, { path: posix, __dirname: "/target/app" }),
    );
    expect(runtime).toEqual([
      "prefix/target/app/decoy.cjs",
      "/target/app/target/app/decoy.cjs",
      "/target/app/target/app/decoy.cjs",
      "/target/app/control.cjs",
    ]);
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ main: "main.cjs" }),
      "main.cjs": `const path=require('node:path');
const {BrowserWindow,utilityProcess}=require('electron');
${expressions.map((expression) => `new BrowserWindow({webPreferences:{preload:${expression}}});utilityProcess.fork(${expression});`).join("\n")}`,
      "decoy.cjs": "throw new Error('Incorrect directory composition');",
      "prefix/decoy.cjs": "throw new Error('Incorrect directory composition');",
      "control.cjs": "throw new Error('Static fixture must never execute');",
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);
    const windows = graph.nodes.filter(({ kind }) => kind === "browser-window");
    expect(
      windows
        .map(({ observations }) => observations[0]?.properties.preload_path)
        .sort((left, right) => Number(left === null) - Number(right === null)),
    ).toEqual(["control.cjs", null, null, null]);
    expect(graph.coverage.status).toBe("partial");
    const utilities = graph.nodes.filter(
      ({ kind }) => kind === "electron-utility",
    );
    expect(utilities).toHaveLength(4);
    const declaredUtilities = utilities.flatMap(({ observations }) =>
      observations
        .filter(({ properties }) => "module_path" in properties)
        .map(({ properties }) => properties),
    );
    expect(
      declaredUtilities
        .map(({ module_path }) => module_path)
        .sort((left, right) => Number(left === null) - Number(right === null)),
    ).toEqual(["control.cjs", null, null, null]);
    expect(
      declaredUtilities
        .filter(({ module_path }) => module_path === null)
        .map(({ module_expression }) => module_expression),
    ).toEqual(expect.arrayContaining(expressions.slice(0, 3)));
    const associations = graph.edges.filter(
      ({ evidence }) =>
        evidence.extractor.operation === "associate-browser-window-preload",
    );
    expect(
      associations.map(({ properties }) => properties.resolved_path),
    ).toEqual(["control.cjs"]);
    const utilityIds = new Set(utilities.map(({ node_id }) => node_id));
    expect(
      graph.edges
        .filter(
          ({ source_node_id, relation }) =>
            utilityIds.has(source_node_id) && relation === "maps_to",
        )
        .map(({ properties }) => properties.resolved_path),
    ).toEqual(["control.cjs"]);
  },
);
