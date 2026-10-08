import { posix } from "node:path";

import { parseExpression } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import {
  staticPath,
  staticPathResolutionContext,
} from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptStaticPathContext } from "./javascriptStaticAnalysisTypes.js";

const absoluteParts = [
  ["/app", "/shared/preload.js"],
  ["ignored", "/app", "preload.js"],
  ["/app", "first", "/shared", "nested", "../preload.js"],
  ["/app", "preload/"],
  ["/app", "preload///"],
  ["/app/", "./sub", "../preload.js"],
  ["/app", ".."],
  ["/app", "../../.."],
  ["/"],
  ["///"],
  ["/app", "/", ""],
  ["", "/app", "", "preload.js", ""],
  ["/app", "..", "child", "..", "preload.js"],
];

const anchoredExpressions = [
  ['path.resolve(__dirname, "preload.cjs")', "preload.cjs"],
  ['path.posix.resolve("ignored", __dirname, "preload.js")', "preload.js"],
  ['path.resolve("/ignored", __dirname, "preload.js")', "preload.js"],
  [
    'path.posix.resolve("ignored", dirname(fileURLToPath(import.meta.url)), "preload.js")',
    "preload.js",
  ],
  [
    'path.resolve("ignored", path.dirname(__filename), "preload.js")',
    "preload.js",
  ],
  ['path.resolve(__dirname, "sub", "../preload.js")', "preload.js"],
  ['path.resolve(__dirname, "../preload.js")', "../preload.js"],
  ['path.resolve(__dirname, "preload/")', "preload"],
  ['path.resolve(__dirname, "sub", __dirname, "preload.js")', "preload.js"],
  ['path.resolve(__dirname, "/shared", "preload.js")', "/shared/preload.js"],
  [
    'path.resolve(dirname(fileURLToPath(import.meta.url)), "/shared/preload.js")',
    "/shared/preload.js",
  ],
  ["path.resolve(__dirname)", "."],
  ['path.resolve(__dirname, "")', "."],
  ['path.resolve(__dirname, "sub/../")', "."],
  ['path.posix.resolve(`/app`, `/shared`, "preload.js")', "/shared/preload.js"],
  ['path.posix.resolve("" + "/app", "preload.js")', "/app/preload.js"],
  ['path.posix.resolve(`/` + `app`, "preload.js")', "/app/preload.js"],
] as const;

const unknownExpressions = [
  "path.resolve()",
  "path.posix.resolve()",
  'path.resolve("sub", "../preload.js")',
  'path.resolve("", "")',
  'path.resolve(runtimeBase, "/app/preload.js")',
  'path.resolve("/app", runtimeFile)',
  'path.resolve(runtimeBase, __dirname, "preload.js")',
  "path.resolve(__dirname, runtimeFile)",
  'path.resolve(...parts, "/app/preload.js")',
  'path.resolve("/app", ...parts)',
  'path.resolve(42, "/app/preload.js")',
  'path.resolve("/app", null)',
  "path.resolve(`/app/${runtimeFile}`)",
  'path.win32.resolve("/app", "/shared/preload.js")',
  'path.win32.resolve(__dirname, "preload.js")',
  'win32.resolve("/app", "preload.js")',
  'resolve("/app", "preload.js")',
];

describe("inert JavaScript path resolution", () => {
  it.each(absoluteParts)(
    "matches the POSIX resolve oracle for %j",
    (...parts) => {
      assertPathProjection(
        `path.posix.resolve(${parts.map((part) => JSON.stringify(part)).join(", ")})`,
        posix.resolve(...parts),
        "filesystem-expression",
      );
    },
  );

  it.each(anchoredExpressions)(
    "projects the source anchor in %s",
    (expression, path) => {
      assertPathProjection(expression, path, "filesystem-expression");
    },
  );

  it.each([
    [
      'path.join("/app", "/shared/preload.js")',
      posix.join("/app", "/shared/preload.js"),
      "filesystem-expression",
    ],
    [
      'path.posix.join("/app", "preload/")',
      posix.join("/app", "preload/"),
      "filesystem-expression",
    ],
    [
      'path.join("sub", "../preload.js")',
      posix.join("sub", "../preload.js"),
      "module-specifier",
    ],
    [
      'path.join(__dirname, "preload.js")',
      "preload.js",
      "filesystem-expression",
    ],
    [
      'path.join("ignored", __dirname, "preload.js")',
      "ignored/preload.js",
      "filesystem-expression",
    ],
    [
      'path.join(dirname(fileURLToPath(import.meta.url)), "preload.js")',
      "preload.js",
      "filesystem-expression",
    ],
    ['join("sub", "preload.js")', "sub/preload.js", "module-specifier"],
  ] as const)("preserves join behavior in %s", (expression, path, context) => {
    assertPathProjection(expression, path, context);
  });

  it.each(unknownExpressions)("keeps unsupported %s unknown", (expression) => {
    expect(
      staticPath(parseExpression(expression, { sourceType: "module" })),
    ).toBeUndefined();
    const { analysis, windowExpression, utilityExpression } =
      analyzePathConsumers(expression);
    expect(analysis.parse_status).toBe("partial");
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.role_paths).toEqual([]);
    expect(analysis.electron.browser_windows).toEqual([
      expect.objectContaining({
        preload_path: null,
        preload_resolution_context: null,
        web_preferences: [
          {
            name: "preload",
            value: { status: "dynamic", value: null, expression },
          },
        ],
        location: lineRange(2, 0, windowExpression.length),
      }),
    ]);
    expect(analysis.electron.utility_processes).toEqual([
      {
        module_path: null,
        module_resolution_context: null,
        module_expression: expression,
        service_name: null,
        module_key: null,
        location: lineRange(3, 0, utilityExpression.length),
      },
    ]);
    expect(analysis.limitations).toContain(
      "One or more static keys, expressions, or Electron boundary values were dynamic and remain unknown.",
    );
  });

  it("keeps recovered templates with invalid escapes unknown as paths", () => {
    const expression = ["`", String.raw`\unicode`, "`"].join("");
    const { analysis } = analyzePathConsumers(expression);

    expect(analysis.parse_status).toBe("partial");
    expect(analysis.parse_error_count).toBe(3);
    expect(analysis.role_paths).toEqual([]);
    expect(analysis.electron.browser_windows).toMatchObject([
      {
        preload_path: null,
        preload_resolution_context: null,
        web_preferences: [
          {
            name: "preload",
            value: { status: "dynamic", value: null, expression },
          },
        ],
      },
    ]);
    expect(analysis.electron.utility_processes).toEqual([
      expect.objectContaining({
        module_path: null,
        module_resolution_context: null,
        module_expression: expression,
      }),
    ]);
  });

  it.each([
    "path.join()",
    "path.join(__dirname)",
    'path.join("/app", runtimeFile)',
    "path.join(...parts)",
  ])("preserves unresolved join syntax in %s", (expression) =>
    expect(
      staticPath(parseExpression(expression, { sourceType: "module" })),
    ).toBeUndefined(),
  );
});

const analyzePathConsumers = (expression: string) => {
  const property = `preload: ${expression}`;
  const genericPrefix = "const options = { ";
  const windowPrefix = "new BrowserWindow({ webPreferences: { ";
  const windowExpression = `${windowPrefix}${property} } })`;
  const utilityExpression = `utilityProcess.fork(${expression})`;
  return {
    property,
    genericPrefix,
    windowPrefix,
    windowExpression,
    utilityExpression,
    analysis: analyzeJavaScriptStaticSource(
      `${genericPrefix}${property} };\n${windowExpression};\n${utilityExpression};`,
    ),
  };
};

const assertPathProjection = (
  expression: string,
  path: string,
  context: JavaScriptStaticPathContext,
) => {
  const node = parseExpression(expression, { sourceType: "module" });
  expect(staticPath(node)).toBe(path);
  expect(staticPathResolutionContext(node)).toBe(context);
  const {
    analysis,
    property,
    genericPrefix,
    windowPrefix,
    windowExpression,
    utilityExpression,
  } = analyzePathConsumers(expression);
  expect(analysis.parse_status).toBe("complete");
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.role_paths).toEqual(
    (
      [
        [1, genericPrefix.length],
        [2, windowPrefix.length],
      ] as const
    ).map(([line, column]) => ({
      role: "preload",
      path,
      resolution_context: context,
      mechanism: "property:preload",
      module_key: null,
      location: lineRange(line, column, column + property.length),
    })),
  );
  expect(analysis.electron.browser_windows).toEqual([
    {
      options_status: "object-literal",
      web_preferences_status: "object-literal",
      web_preferences: [
        {
          name: "preload",
          value: { status: "literal", value: path, expression: null },
        },
      ],
      preload_path: path,
      preload_resolution_context: context,
      module_key: null,
      location: lineRange(2, 0, windowExpression.length),
    },
  ]);
  expect(analysis.electron.utility_processes).toEqual([
    {
      module_path: path,
      module_resolution_context: context,
      module_expression: null,
      service_name: null,
      module_key: null,
      location: lineRange(3, 0, utilityExpression.length),
    },
  ]);
};

const lineRange = (line: number, start: number, end: number) => ({
  start: { line, column: start },
  end: { line, column: end },
});
