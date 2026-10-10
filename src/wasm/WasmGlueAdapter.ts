import { basename, dirname, resolve } from "node:path";
import * as t from "@babel/types";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import { traverseJavaScriptAst } from "../domain/javascript/javascriptSemanticTraversal.js";
/** Associate visible literals with selected candidates without asserting data flow or URL identity. */
export const associateWasmGlue = (
  source: string,
  path: string,
  candidates: readonly string[],
) => {
  const file = parseJavaScriptSource(source);
  const references: {
    value: string;
    line: number;
    column: number;
    candidate_paths: string[];
    association: "local-path-candidate" | "basename-candidates" | "unresolved";
    evidence_kind: "static-literal";
  }[] = [];
  if (file === null) return { parse_status: "failed" as const, references };
  traverseJavaScriptAst(file, {
    enter(node) {
      const value = t.isStringLiteral(node)
        ? node.value
        : t.isTemplateLiteral(node) && node.expressions.length === 0
          ? node.quasis[0]?.value.cooked
          : undefined;
      if (
        value === undefined ||
        value === null ||
        !/\.wasm(?:[?#].*)?$/iu.test(value) ||
        node.loc == null
      )
        return;
      const stripped = value.split(/[?#]/u)[0] ?? value;
      const local =
        !/^[a-z][a-z\d+.-]*:|^\/\//iu.test(value) &&
        !value.startsWith("/") &&
        !/[?#]/u.test(value);
      const exact = local
        ? candidates.filter(
            (candidate) => candidate === resolve(dirname(path), value),
          )
        : [];
      const matches =
        exact.length > 0
          ? exact
          : candidates.filter(
              (candidate) => basename(candidate) === basename(stripped),
            );
      references.push({
        value,
        line: node.loc.start.line,
        column: node.loc.start.column,
        candidate_paths: [...matches],
        association:
          exact.length > 0
            ? "local-path-candidate"
            : matches.length > 0
              ? "basename-candidates"
              : "unresolved",
        evidence_kind: "static-literal",
      });
    },
  });
  return {
    parse_status:
      file.errors.length === 0 ? ("complete" as const) : ("partial" as const),
    references,
  };
};
