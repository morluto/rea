import type { Node } from "@babel/types";
import { readExactJavaScriptLiteral } from "./javascript/javascriptAstValues.js";
import { traverseJavaScriptAst } from "./javascript/javascriptSemanticTraversal.js";
import {
  javaScriptSourceLoaderCondition,
  parseJavaScriptSource,
} from "./javascript/javascriptSourceParser.js";
import type { WebModuleImport } from "./webModuleTrace.js";
import type { ExportedWebScript } from "./webScriptExport.js";
import {
  hasUncertainTypeOnlyModuleSideEffect,
  TYPE_ONLY_MODULE_SIDE_EFFECT_LIMITATION,
  semanticStaticModuleSource,
} from "./javascript/javascriptModuleDeclaration.js";

const SKIPPABLE_AST_LEAF_TYPES = new Set([
  "StringLiteral",
  "NumericLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "BigIntLiteral",
  "RegExpLiteral",
  "ThisExpression",
  "Super",
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "ImportAttribute",
  "ExportSpecifier",
]);

const collectModuleKeywordOffsets = (source: string): number[] => {
  const offsets: number[] = [];
  for (
    let index = source.indexOf("import");
    index >= 0;
    index = source.indexOf("import", index + 6)
  )
    offsets.push(index);
  for (
    let index = source.indexOf("export");
    index >= 0;
    index = source.indexOf("export", index + 6)
  )
    offsets.push(index);
  if (offsets.length > 1) offsets.sort((a, b) => a - b);
  return offsets;
};

const rangeContainsKeyword = (
  offsets: readonly number[],
  start: number,
  end: number,
): boolean => {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid]! < start) lo = mid + 1;
    else hi = mid;
  }
  return lo < offsets.length && offsets[lo]! < end;
};

const addImportedReference = (
  source: string,
  expression: Node,
  kind: WebModuleImport["kind"],
  imports: WebModuleImport[],
): void => {
  if (
    expression.start === null ||
    expression.start === undefined ||
    expression.end === null ||
    expression.end === undefined ||
    expression.loc === null ||
    expression.loc === undefined
  )
    return;
  let specifier: string | null;
  if (expression.type === "StringLiteral") {
    specifier = expression.value;
  } else {
    const literal = readExactJavaScriptLiteral(expression);
    specifier =
      literal.found && typeof literal.value === "string" ? literal.value : null;
  }
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

const minDecoratorStart = (node: Node, start: number): number => {
  const decorators = (node as { readonly decorators?: readonly Node[] | null })
    .decorators;
  if (
    decorators === undefined ||
    decorators === null ||
    decorators.length === 0
  )
    return start;
  for (let i = 0; i < decorators.length; i += 1) {
    const decoratorStart = decorators[i]?.start;
    if (decoratorStart != null && decoratorStart < start)
      start = decoratorStart;
  }
  return start;
};

// Babel's `decorators-legacy` plugin places `node.start` after leading
// decorators on patterns, object members, and `AssignmentPattern.left`.
const effectiveNodeStart = (node: Node, nodeStart: number): number => {
  let start = minDecoratorStart(node, nodeStart);
  let current: Node = node;
  while (current.type === "AssignmentPattern") {
    current = current.left;
    start = minDecoratorStart(current, start);
    if (current.start != null && current.start < start) start = current.start;
  }
  return start;
};

const traverseModuleImports = (
  ast: Node,
  source: string,
  keywordOffsets: readonly number[],
): WebModuleImport[] => {
  const imports: WebModuleImport[] = [];
  let lastOffset = -1;
  let needsSort = false;
  const record = (kind: WebModuleImport["kind"], expression: Node): void => {
    const before = imports.length;
    addImportedReference(source, expression, kind, imports);
    if (imports.length > before) {
      const startOffset = imports[before]!.start.offset;
      if (startOffset < lastOffset) needsSort = true;
      lastOffset = startOffset;
    }
  };
  traverseJavaScriptAst(ast, {
    skip: (node) => {
      if (node.type === "File" || node.type === "Program") return false;
      if (node.type === "Identifier" && (node.decorators?.length ?? 0) === 0)
        return true;
      if (SKIPPABLE_AST_LEAF_TYPES.has(node.type)) return true;
      return (
        node.start != null &&
        node.end != null &&
        !rangeContainsKeyword(
          keywordOffsets,
          effectiveNodeStart(node, node.start),
          node.end,
        )
      );
    },
    enter: (node) => {
      switch (node.type) {
        case "ImportDeclaration":
        case "ExportAllDeclaration":
        case "ExportNamedDeclaration": {
          const moduleSource = semanticStaticModuleSource(node);
          if (moduleSource !== null)
            record(
              node.type === "ImportDeclaration" ? "static-import" : "re-export",
              moduleSource,
            );
          break;
        }
        case "ImportExpression":
          record("dynamic-import", node.source);
          break;
      }
    },
  });
  if (needsSort) imports.sort((a, b) => a.start.offset - b.start.offset);
  return imports;
};

/** Collect module declarations, omitting whole-statement type-only forms. */
export const collectWebModuleImports = (
  source: string,
  sourcePath: string,
): {
  readonly imports: readonly WebModuleImport[];
  readonly state: "parsed" | "unparseable";
  readonly diagnostics: readonly string[];
} => {
  const ast = parseJavaScriptSource(source, sourcePath);
  if (ast === null)
    return {
      imports: [],
      state: "unparseable",
      diagnostics: ["Source could not be parsed; imports are unknown."],
    };
  const keywordOffsets = collectModuleKeywordOffsets(source);
  const imports =
    keywordOffsets.length > 0
      ? traverseModuleImports(ast, source, keywordOffsets)
      : [];
  const loaderCondition = javaScriptSourceLoaderCondition(ast.program);
  return {
    imports,
    state: "parsed",
    diagnostics: [
      ...(loaderCondition === undefined ? [] : [loaderCondition]),
      ...(ast.errors?.map((error) => error.message) ?? []),
      ...(keywordOffsets.length > 0 &&
      hasUncertainTypeOnlyModuleSideEffect(ast.program)
        ? [TYPE_ONLY_MODULE_SIDE_EFFECT_LIMITATION]
        : []),
    ],
  };
};

export interface CapturedModuleCandidate {
  readonly script_index: number;
  readonly match: "exact-reported-url" | "response-url-without-fragment";
  readonly script: ExportedWebScript;
}

interface CapturedModuleIndex {
  readonly byUrl: Map<string, number[]>;
  readonly responseByUrl: Map<string, number[]>;
}

const pushIndex = (
  map: Map<string, number[]>,
  key: string,
  index: number,
): void => {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = [];
    map.set(key, bucket);
  }
  bucket.push(index);
};

const buildCapturedModuleIndex = (
  scripts: readonly ExportedWebScript[],
): CapturedModuleIndex => {
  const byUrl = new Map<string, number[]>();
  const responseByUrl = new Map<string, number[]>();
  for (let i = 0; i < scripts.length; i += 1) {
    const script = scripts[i]!;
    pushIndex(byUrl, script.url, i);
    if (script.source.kind === "scenario-response")
      pushIndex(responseByUrl, script.url, i);
  }
  return { byUrl, responseByUrl };
};

const normalizedResponseUrl = (url: string): string | undefined => {
  const transport = URL.parse(url);
  if (transport === null) return undefined;
  transport.hash = "";
  return transport.href;
};

const matchLinear = (
  url: string,
  scripts: readonly ExportedWebScript[],
): CapturedModuleCandidate[] => {
  const candidates: CapturedModuleCandidate[] = [];
  let transportHref: string | undefined;
  let transportParsed = false;
  for (let script_index = 0; script_index < scripts.length; script_index += 1) {
    const script = scripts[script_index]!;
    if (script.url === url) {
      candidates.push({ script_index, match: "exact-reported-url", script });
      continue;
    }
    if (script.source.kind !== "scenario-response") continue;
    if (!transportParsed) {
      transportParsed = true;
      transportHref = normalizedResponseUrl(url);
    }
    if (transportHref === script.url)
      candidates.push({
        script_index,
        match: "response-url-without-fragment",
        script,
      });
  }
  return candidates;
};

const matchIndexed = (
  url: string,
  scripts: readonly ExportedWebScript[],
  index: CapturedModuleIndex,
): CapturedModuleCandidate[] => {
  const exactIndices = index.byUrl.get(url);
  let responseIndices: readonly number[] | undefined;
  if (index.responseByUrl.size > 0) {
    const normalized = normalizedResponseUrl(url);
    if (normalized !== undefined && normalized !== url)
      responseIndices = index.responseByUrl.get(normalized);
  }
  if (exactIndices === undefined && responseIndices === undefined) return [];
  if (responseIndices === undefined)
    return exactIndices!.map((script_index) => ({
      script_index,
      match: "exact-reported-url",
      script: scripts[script_index]!,
    }));
  if (exactIndices === undefined)
    return responseIndices.map((script_index) => ({
      script_index,
      match: "response-url-without-fragment",
      script: scripts[script_index]!,
    }));
  const candidates: CapturedModuleCandidate[] = [];
  let ei = 0;
  let ri = 0;
  while (ei < exactIndices.length && ri < responseIndices.length) {
    const eIdx = exactIndices[ei]!;
    const rIdx = responseIndices[ri]!;
    if (eIdx < rIdx) {
      candidates.push({
        script_index: eIdx,
        match: "exact-reported-url",
        script: scripts[eIdx]!,
      });
      ei += 1;
    } else {
      candidates.push({
        script_index: rIdx,
        match: "response-url-without-fragment",
        script: scripts[rIdx]!,
      });
      ri += 1;
    }
  }
  while (ei < exactIndices.length) {
    const script_index = exactIndices[ei++]!;
    candidates.push({
      script_index,
      match: "exact-reported-url",
      script: scripts[script_index]!,
    });
  }
  while (ri < responseIndices.length) {
    const script_index = responseIndices[ri++]!;
    candidates.push({
      script_index,
      match: "response-url-without-fragment",
      script: scripts[script_index]!,
    });
  }
  return candidates;
};

/** Create a reusable matcher for repeated queries against one captured script inventory. */
export const createCapturedModuleMatcher = (
  scripts: readonly ExportedWebScript[],
): ((url: string) => CapturedModuleCandidate[]) => {
  let index: CapturedModuleIndex | undefined;
  let lookups = 0;
  return (url) => {
    if (scripts.length === 0) return [];
    if (lookups === 0) {
      lookups = 1;
      return matchLinear(url, scripts);
    }
    index ??= buildCapturedModuleIndex(scripts);
    return matchIndexed(url, scripts, index);
  };
};

/** Match reported URLs without collapsing query or module fragment identity. */
export const matchCapturedModules = (
  url: string,
  scripts: readonly ExportedWebScript[],
): CapturedModuleCandidate[] =>
  scripts.length === 0 ? [] : matchLinear(url, scripts);
