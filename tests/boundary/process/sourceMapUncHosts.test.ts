import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

const cases = [
  {
    name: "soft hyphen U+00AD",
    source: "\\\\\u00ad\\share\\source.ts",
    expected: { kind: "unresolved" },
  },
  {
    name: "zero width non joiner U+200C",
    source: "\\\\\u200c\\share\\source.ts",
    expected: { kind: "unresolved" },
  },
  {
    name: "ASCII delimiter",
    source: "\\\\bad#host\\share\\source.ts",
    expected: { kind: "unresolved" },
  },
  {
    name: "empty host",
    source: "\\\\\\share\\source.ts",
    expected: { kind: "unresolved" },
  },
  {
    name: "normal host",
    source: "\\\\server\\share\\source.ts",
    expected: { kind: "suffix", path: "server/share/source.ts" },
  },
  {
    name: "valid IDNA host",
    source: "\\\\bücher.example\\share\\source.ts",
    expected: { kind: "suffix", path: "bücher.example/share/source.ts" },
  },
  {
    name: "nonempty normalized host",
    source: "\\\\\u00adserver\\share\\source.ts",
    expected: { kind: "suffix", path: "server/share/source.ts" },
  },
  {
    name: "localhost host",
    source: "\\\\localhost\\share\\source.ts",
    expected: { kind: "suffix", path: "share/source.ts" },
  },
  {
    name: "drive letter",
    source: "C:\\src\\source.ts",
    expected: { kind: "suffix", path: "C:/src/source.ts" },
  },
  {
    name: "soft hyphen source root",
    source: "source.ts",
    root: "\\\\\u00ad\\share",
    expected: { kind: "unresolved" },
  },
  {
    name: "zero width non joiner source root",
    source: "source.ts",
    root: "\\\\\u200c\\share",
    expected: { kind: "unresolved" },
  },
] as const;

processTest(
  "preserves UNC host resolution and source spelling in an owned subprocess",
  async ({ processes }) => {
    const inputs = cases.map((scenario) => ({
      name: scenario.name,
      source: scenario.source,
      root: "root" in scenario ? scenario.root : null,
    }));
    const result = await processes.run(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { resolveJavaScriptSourceMapReference } from "./dist/domain/javascript/javascriptSourceMapPaths.js";
     const inputs = JSON.parse(process.argv[1]);
     const references = inputs.map(({ name, source, root }) => {
       console.error("Resolving", name);
       return resolveJavaScriptSourceMapReference(source, root, "maps/main.js.map");
     });
     console.log(JSON.stringify(references));`,
      JSON.stringify(inputs),
    ]);

    expect(result.signal, result.stderr).toBeNull();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(
      cases.map((scenario) => ({
        source_name: scenario.source,
        source_root: "root" in scenario ? scenario.root : null,
        map_path: "maps/main.js.map",
        resolution: scenario.expected,
      })),
    );
  },
);
