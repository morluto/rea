import { basename, dirname } from "node:path";
import type * as t from "@babel/types";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import { traverseJavaScriptAst } from "../domain/javascript/javascriptSemanticTraversal.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

const SCHEME_OR_PROTOCOL_RE = /^[a-z][a-z\d+.-]*:|^\/\//iu;
const SKIPPABLE_GLUE_LEAVES = new Set([
  "NumericLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "BigIntLiteral",
  "RegExpLiteral",
  "ThisExpression",
  "Super",
]);

/**
 * Only the path before the first query/fragment delimiter determines the suffix.
 * Returns the delimiter offset (or `value.length`) when `.wasm` matches, else `-1`.
 */
const findWasmReferenceEnd = (value: string): number => {
  if (value.length < 5) return -1;
  const query = value.indexOf("?");
  const hash = value.indexOf("#");
  const end =
    query < 0
      ? hash < 0
        ? value.length
        : hash
      : hash < 0
        ? query
        : Math.min(query, hash);
  if (end < 5) return -1;
  return value.charCodeAt(end - 5) === 0x2e &&
    (value.charCodeAt(end - 4) | 0x20) === 0x77 &&
    (value.charCodeAt(end - 3) | 0x20) === 0x61 &&
    (value.charCodeAt(end - 2) | 0x20) === 0x73 &&
    (value.charCodeAt(end - 1) | 0x20) === 0x6d
    ? end
    : -1;
};

const literalNodeValue = (node: t.Node): string | null | undefined => {
  switch (node.type) {
    case "StringLiteral":
      return node.value;
    case "DirectiveLiteral": {
      const cooked = node.extra?.expressionValue;
      return typeof cooked === "string" ? cooked : undefined;
    }
    case "TemplateLiteral":
      return node.expressions.length === 0
        ? node.quasis[0]?.value.cooked
        : undefined;
    default:
      return undefined;
  }
};

const indexCandidates = (
  candidates: readonly string[],
  keyOf: (candidate: string) => string,
): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const key = keyOf(candidate);
    let bucket = index.get(key);
    if (bucket === undefined) {
      bucket = [];
      index.set(key, bucket);
    }
    bucket.push(candidate);
  }
  return index;
};

/** Associate visible literals with selected candidates without asserting data flow or URL identity. */
export const associateWasmGlue = (
  source: string,
  path: string,
  candidates: readonly string[],
) => {
  // Babel requires a hashbang at offset zero. Removing only its preceding BOM
  // leaves reference coordinates intact: all code starts on a later line.
  // The selected filename selects the JavaScript grammar for .js glue; the
  // unnamed-source fallback would misread valid JavaScript conditionals.
  const file = parseJavaScriptSource(
    source.startsWith("\uFEFF#!") ? source.slice(1) : source,
    path,
  );
  const references: {
    value: string;
    line: number;
    column: number;
    candidate_paths: string[];
    association: "local-path-candidate" | "basename-candidates" | "unresolved";
    evidence_kind: "static-literal";
  }[] = [];
  if (file === null) return { parse_status: "failed" as const, references };
  let glueDir: string | undefined;
  let byAbsolutePath: Map<string, string[]> | undefined;
  let byBasename: Map<string, string[]> | undefined;
  traverseJavaScriptAst(file, {
    skip(node) {
      if (node.type === "Identifier")
        return (
          node.typeAnnotation == null && (node.decorators?.length ?? 0) === 0
        );
      return SKIPPABLE_GLUE_LEAVES.has(node.type);
    },
    enter(node) {
      // Babel retains the source spelling in DirectiveLiteral.value, while
      // extra.expressionValue is the same cooked value used by StringLiteral.
      const value = literalNodeValue(node);
      if (value === undefined || value === null || node.loc == null) return;
      const delimiterEnd = findWasmReferenceEnd(value);
      if (delimiterEnd < 0) return;
      const hasDelimiter = delimiterEnd < value.length;
      const stripped = hasDelimiter ? value.slice(0, delimiterEnd) : value;
      const local =
        !hasDelimiter &&
        value.charCodeAt(0) !== 0x2f &&
        !SCHEME_OR_PROTOCOL_RE.test(value);
      // Compare through the caller-path owner so `.` spellings match and a
      // symlink followed by `..` is never collapsed onto a sibling.
      let exact: readonly string[] | undefined;
      if (local && candidates.length > 0) {
        glueDir ??= dirname(path);
        byAbsolutePath ??= indexCandidates(candidates, (candidate) =>
          absoluteCallerPath(candidate),
        );
        exact = byAbsolutePath.get(absoluteCallerPath(value, { cwd: glueDir }));
      }
      let matches: readonly string[] | undefined = exact;
      if (matches === undefined && candidates.length > 0) {
        byBasename ??= indexCandidates(candidates, basename);
        matches = byBasename.get(basename(stripped));
      }
      references.push({
        value,
        line: node.loc.start.line,
        column: node.loc.start.column,
        candidate_paths: matches === undefined ? [] : [...matches],
        association:
          exact !== undefined
            ? "local-path-candidate"
            : matches !== undefined
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
