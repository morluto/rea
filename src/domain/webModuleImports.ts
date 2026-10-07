import { traverseFast, isStringLiteral, isTemplateLiteral } from "@babel/types";
import type { Node } from "@babel/types";
import { parseJavaScriptSource } from "./javascript/javascriptSourceParser.js";
import type { WebModuleImport } from "./webModuleTrace.js";
import type { ExportedWebScript } from "./webScriptExport.js";

/** Collect native import syntax, excluding erased type-only references. */
export const collectWebModuleImports = (
  source: string,
): {
  readonly imports: readonly WebModuleImport[];
  readonly state: "parsed" | "unparseable";
  readonly diagnostics: readonly string[];
} => {
  const ast = parseJavaScriptSource(source);
  if (ast === null)
    return {
      imports: [],
      state: "unparseable",
      diagnostics: ["Source could not be parsed; imports are unknown."],
    };
  const imports: WebModuleImport[] = [];
  const add = (kind: WebModuleImport["kind"], expression: Node): void => {
    if (
      expression.start === null ||
      expression.start === undefined ||
      expression.end === null ||
      expression.end === undefined ||
      expression.loc === null ||
      expression.loc === undefined
    )
      return;
    const specifier = isStringLiteral(expression)
      ? expression.value
      : isTemplateLiteral(expression) && expression.expressions.length === 0
        ? (expression.quasis[0]?.value.cooked ?? null)
        : null;
    imports.push({
      kind,
      specifier,
      expression: source.slice(expression.start, expression.end),
      start: {
        offset: expression.start,
        line: expression.loc.start.line,
        column: expression.loc.start.column,
      },
      end: {
        offset: expression.end,
        line: expression.loc.end.line,
        column: expression.loc.end.column,
      },
    });
  };
  traverseFast(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type" || node.importKind === "typeof") return;
      if (
        node.specifiers.length > 0 &&
        node.specifiers.every(
          (s) =>
            s.type === "ImportSpecifier" &&
            (s.importKind === "type" || s.importKind === "typeof"),
        )
      )
        return;
      add("static-import", node.source);
    } else if (
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      if (
        node.exportKind === "type" ||
        node.source === null ||
        node.source === undefined
      )
        return;
      if (
        node.type === "ExportNamedDeclaration" &&
        node.specifiers.length > 0 &&
        node.specifiers.every(
          (s) => s.type === "ExportSpecifier" && s.exportKind === "type",
        )
      )
        return;
      add("re-export", node.source);
    } else if (node.type === "ImportExpression")
      add("dynamic-import", node.source);
    else if (
      node.type === "CallExpression" &&
      node.callee.type === "Import" &&
      node.arguments[0] !== undefined
    )
      add("dynamic-import", node.arguments[0]);
  });
  imports.sort((a, b) => a.start.offset - b.start.offset);
  return {
    imports,
    state: "parsed",
    diagnostics: ast.errors?.map((error) => error.message) ?? [],
  };
};

/** Match reported URLs without collapsing query or module fragment identity. */
export const matchCapturedModules = (
  url: string,
  scripts: readonly ExportedWebScript[],
) => {
  const candidates: {
    script_index: number;
    match: "exact-reported-url" | "response-url-without-fragment";
    script: ExportedWebScript;
  }[] = [];
  scripts.forEach((script, script_index) => {
    if (script.url === url)
      candidates.push({ script_index, match: "exact-reported-url", script });
    else if (script.source.kind === "scenario-response") {
      try {
        const transport = new URL(url);
        transport.hash = "";
        if (transport.href === script.url)
          candidates.push({
            script_index,
            match: "response-url-without-fragment",
            script,
          });
      } catch (cause: unknown) {
        void cause;
      }
    }
  });
  return candidates;
};
