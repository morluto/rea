import { parse, type ParserPlugin } from "@babel/parser";
import type { CallExpression, File, Node, StringLiteral } from "@babel/types";
import {
  isCallExpression,
  isExportAllDeclaration,
  isExportNamedDeclaration,
  isIdentifier,
  isImport,
  isImportDeclaration,
  isMemberExpression,
  isNode,
  isStringLiteral,
  isTSExternalModuleReference,
  isTSImportEqualsDeclaration,
  isTSModuleDeclaration,
} from "@babel/types";

type ReferenceSourceImportKind =
  | "imports"
  | "requires"
  | "references"
  | "declares-module";

type ReferenceSourceImportResolution =
  | "internal"
  | "external"
  | "unresolved"
  | "unknown";

type ReferenceSourceImportParseState = "parsed" | "partial" | "unknown";

interface ReferenceSourceImportRelationship {
  readonly from_path: string;
  readonly to: string;
  readonly kind: ReferenceSourceImportKind;
  readonly resolution: ReferenceSourceImportResolution;
  readonly parse_state: ReferenceSourceImportParseState;
}

interface ReferenceSourceParseFailure {
  readonly path: string;
  readonly parser: string;
  readonly reason: string;
}

export interface ReferenceSourceImportParseResult {
  readonly relationships: readonly ReferenceSourceImportRelationship[];
  readonly parse_failures: readonly ReferenceSourceParseFailure[];
}

const MAX_REASON_LENGTH = 1_024;

const codeSourceLanguages = new Set(["JavaScript", "TypeScript", "JSX", "TSX"]);

const truncateReason = (reason: string): string =>
  reason.length > MAX_REASON_LENGTH
    ? `${reason.slice(0, MAX_REASON_LENGTH - 3)}...`
    : reason;

const safeModuleName = (node: Node | null | undefined): string | undefined => {
  if (isStringLiteral(node)) return node.value;
  return undefined;
};

const resolveSpecifier = (
  specifier: string,
): ReferenceSourceImportResolution => {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "internal";
  if (specifier.startsWith("node:") || specifier.startsWith("data:"))
    return "external";
  return "external";
};

const isModuleExpression = (
  expression: Node | null | undefined,
): expression is StringLiteral | CallExpression =>
  isStringLiteral(expression) || isCallExpression(expression);

const moduleSpecifierFromExpression = (
  expression: Node | null | undefined,
):
  | { specifier: string; parseState: ReferenceSourceImportParseState }
  | undefined => {
  if (isStringLiteral(expression))
    return { specifier: expression.value, parseState: "parsed" };
  if (
    isCallExpression(expression) &&
    isImport(expression.callee) &&
    expression.arguments.length > 0
  ) {
    const first = expression.arguments[0];
    if (isStringLiteral(first)) {
      return { specifier: first.value, parseState: "parsed" };
    }
    return { specifier: "<dynamic-import>", parseState: "partial" };
  }
  return undefined;
};

const appendRelationship = (
  relationships: ReferenceSourceImportRelationship[],
  input: {
    readonly fromPath: string;
    readonly to: string | undefined;
    readonly kind: ReferenceSourceImportKind;
    readonly parseState: ReferenceSourceImportParseState;
    readonly resolution?: ReferenceSourceImportResolution;
  },
): void => {
  if (input.to === undefined) return;
  relationships.push({
    from_path: input.fromPath,
    to: input.to,
    kind: input.kind,
    resolution: input.resolution ?? resolveSpecifier(input.to),
    parse_state: input.parseState,
  });
};

const extractImportDeclarations = (
  body: readonly Node[],
  from_path: string,
  relationships: ReferenceSourceImportRelationship[],
): void => {
  for (const statement of body) {
    if (isImportDeclaration(statement)) {
      appendRelationship(relationships, {
        fromPath: from_path,
        to: safeModuleName(statement.source),
        kind: "imports",
        parseState: "parsed",
      });
      continue;
    }

    if (isExportNamedDeclaration(statement)) {
      if (statement.source !== null && statement.source !== undefined) {
        appendRelationship(relationships, {
          fromPath: from_path,
          to: safeModuleName(statement.source),
          kind: "imports",
          parseState: "parsed",
        });
      }
      continue;
    }

    if (isExportAllDeclaration(statement)) {
      appendRelationship(relationships, {
        fromPath: from_path,
        to: safeModuleName(statement.source),
        kind: "imports",
        parseState: "parsed",
      });
      continue;
    }

    if (isTSImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (isTSExternalModuleReference(reference)) {
        appendRelationship(relationships, {
          fromPath: from_path,
          to: safeModuleName(reference.expression),
          kind: "requires",
          parseState: "parsed",
        });
      }
      continue;
    }

    if (isTSModuleDeclaration(statement)) {
      if (statement.declare === true && isStringLiteral(statement.id)) {
        appendRelationship(relationships, {
          fromPath: from_path,
          to: statement.id.value,
          kind: "declares-module",
          parseState: "parsed",
          resolution: "unknown",
        });
      }
    }
  }
};

const isRequireCallee = (callee: Node | null | undefined): boolean => {
  if (isIdentifier(callee) && callee.name === "require") return true;
  if (
    isMemberExpression(callee) &&
    isIdentifier(callee.object) &&
    callee.object.name === "require" &&
    (isIdentifier(callee.property) || isStringLiteral(callee.property))
  ) {
    const propertyName = isIdentifier(callee.property)
      ? callee.property.name
      : isStringLiteral(callee.property)
        ? callee.property.value
        : undefined;
    return propertyName === "resolve" || propertyName === "main";
  }
  return false;
};

const isImportCallee = (callee: Node | null | undefined): boolean =>
  isImport(callee);

const collectCallExpressions = (
  node: unknown,
  targets: CallExpression[],
): void => {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectCallExpressions(item, targets);
    return;
  }
  if (!isNode(node)) return;
  if (isCallExpression(node)) {
    targets.push(node);
  }
  for (const value of Object.values(node)) {
    if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !isSourceLocation(value)
    ) {
      collectCallExpressions(value, targets);
    }
  }
};

const isSourceLocation = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "start" in value &&
  "end" in value &&
  !("type" in value);

const extractRequireAndDynamicImports = (
  body: readonly Node[],
  from_path: string,
  relationships: ReferenceSourceImportRelationship[],
): void => {
  const calls: CallExpression[] = [];
  for (const statement of body) collectCallExpressions(statement, calls);

  for (const call of calls) {
    const first = call.arguments[0];
    if (isRequireCallee(call.callee) && isModuleExpression(first)) {
      const result = moduleSpecifierFromExpression(first);
      if (result !== undefined) {
        appendRelationship(relationships, {
          fromPath: from_path,
          to: result.specifier,
          kind: "requires",
          parseState: result.parseState,
        });
      }
      continue;
    }

    if (isImportCallee(call.callee) && isModuleExpression(first)) {
      const result = moduleSpecifierFromExpression(first);
      if (result !== undefined) {
        appendRelationship(relationships, {
          fromPath: from_path,
          to: result.specifier,
          kind: "imports",
          parseState: result.parseState,
        });
      }
    }
  }
};

const parseWithBabel = (
  path: string,
  source: string,
  language: string | null,
): {
  ast: File | undefined;
  parseState: ReferenceSourceImportParseState;
  reason?: string;
} => {
  const plugins: ParserPlugin[] = ["jsx"];
  if (language === "TypeScript" || language === "TSX") {
    plugins.push([
      "typescript",
      {
        dts:
          path.endsWith(".d.ts") ||
          path.endsWith(".d.mts") ||
          path.endsWith(".d.cts"),
      },
    ]);
  }

  try {
    const ast = parse(source, {
      sourceType: "unambiguous",
      allowImportExportEverywhere: false,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins,
    });
    return { ast, parseState: "parsed" };
  } catch (error) {
    return {
      ast: undefined,
      parseState: "unknown",
      reason: error instanceof Error ? error.message : "Parse failed",
    };
  }
};

/** Parse ESM/CommonJS imports and dynamic imports from source bytes. */
export const parseReferenceSourceImports = (
  path: string,
  bytes: Uint8Array,
  language: string | null,
): ReferenceSourceImportParseResult => {
  if (language !== null && !codeSourceLanguages.has(language))
    return { relationships: [], parse_failures: [] };

  const source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const { ast, parseState, reason } = parseWithBabel(path, source, language);

  if (ast === undefined || parseState === "unknown") {
    return {
      relationships: [],
      parse_failures: [
        {
          path,
          parser: "babel",
          reason: truncateReason(reason ?? "Unknown parse failure"),
        },
      ],
    };
  }

  const relationships: ReferenceSourceImportRelationship[] = [];
  extractImportDeclarations(ast.program.body, path, relationships);
  extractRequireAndDynamicImports(ast.program.body, path, relationships);

  return {
    relationships,
    parse_failures: [],
  };
};
