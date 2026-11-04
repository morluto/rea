import * as t from "@babel/types";

import {
  semanticObjectPatternKeys,
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

import { semanticCopiedReferencePath } from "./javascriptSemanticCopiedReferencePaths.js";
import { childNodes } from "./javascriptSemanticTraversal.js";
import type {
  IterationSourceValue,
  SemanticIterationSource,
} from "./javascriptSemanticIterationFacts.js";

export type {
  IterationSourceValue,
  SemanticIterationSource,
} from "./javascriptSemanticIterationFacts.js";

/** A property value obtained by destructuring or an own-enumerable copy. */
export interface SemanticPropertyReadSource
  extends IterationSourceValue, SourceGuards {
  readonly mutation: t.Node;
  readonly lookup: "prototype" | "own";
}

interface PatternSource extends IterationSourceValue {
  // A rest binding is a fresh array whose children retain their source indices.
  readonly restStartIndex?: number;
}

/** Select an assigned slot while retaining fresh rest-copy identity and offsets. */
export const semanticStoredSourceSelection = (
  source: SemanticIterationSource,
  selected: JavaScriptSemanticPropertyPath,
): {
  readonly projection: JavaScriptSemanticPropertyPath;
  readonly capturedSelectionDepth?: number;
  readonly ownEnumerable?: true;
} | null => {
  const copy = source.projection.at(-1);
  if (copy === null || typeof copy !== "object")
    return { projection: [...source.projection, ...selected] };
  const projection = semanticCopiedReferencePath(
    {
      projection: source.projection,
      copyProjectionOffset: source.projection.length - 1,
      copyKind: copy.startIndex === undefined ? "object-rest" : "array-rest",
      copyExcludedKeys: copy.excludedKeys,
      ...(copy.startIndex === undefined
        ? {}
        : { copyStartIndex: copy.startIndex }),
    },
    selected,
    "identity",
  );
  return projection === null
    ? null
    : {
        projection,
        capturedSelectionDepth: source.projection.length,
        ...(copy.startIndex === undefined
          ? { ownEnumerable: true as const }
          : {}),
      };
};

interface SourceGuards {
  readonly iterationSources?: readonly IterationSourceValue[];
  readonly fallbackSources?: readonly IterationSourceValue[];
  readonly requiredSources?: readonly IterationSourceValue[];
}

const add = (
  sources: SemanticIterationSource[],
  source: IterationSourceValue,
  mutation: t.Node,
  guards: SourceGuards,
  kind: SemanticIterationSource["kind"] = "iteration",
  target?: t.MemberExpression,
): void => {
  sources.push({
    kind,
    node: source.node,
    projection: source.projection,
    mutation,
    ...guards,
    ...(target === undefined ? {} : { target }),
  });
};
const project = (
  source: PatternSource | undefined,
  key: string | number | null,
): PatternSource | undefined => {
  if (source === undefined) return undefined;
  const index = key === null ? null : semanticArrayIndex(key);
  return {
    node: source.node,
    projection: [
      ...source.projection,
      source.restStartIndex !== undefined && index !== null
        ? source.restStartIndex + index
        : key,
    ],
  };
};
interface PatternCollection {
  readonly sources: SemanticIterationSource[];
  readonly mutation: t.Node;
  readonly propertyReads: SemanticPropertyReadSource[];
}

const visit = (
  context: PatternCollection,
  pattern: t.Node,
  source: PatternSource | undefined,
  guards: SourceGuards = {},
): void => {
  pattern = unwrapJavaScriptExpression(pattern).node;
  const { sources, mutation } = context;
  if (t.isMemberExpression(pattern)) {
    // Property stores have no lexical alias binding. Preserve the selected
    // reference's escape rather than claiming later writes cannot reach it.
    if (source !== undefined)
      add(
        sources,
        source.restStartIndex === undefined
          ? source
          : {
              node: source.node,
              projection: [
                ...source.projection,
                { excludedKeys: [], startIndex: source.restStartIndex },
              ],
            },
        mutation,
        guards,
        "reference-store",
        pattern,
      );
    return;
  }
  if (t.isTSParameterProperty(pattern)) {
    visit(context, pattern.parameter, source, guards);
    return;
  }
  if (t.isAssignmentPattern(pattern)) {
    visit(context, pattern.left, source, {
      ...guards,
      requiredSources: [
        ...(guards.requiredSources ?? []),
        ...(source === undefined
          ? []
          : [
              {
                ...source,
                ...(guards.iterationSources === undefined
                  ? {}
                  : { iterationSources: guards.iterationSources }),
              },
            ]),
      ],
    });
    visit(
      context,
      pattern.left,
      { node: pattern.right, projection: [] },
      {
        ...guards,
        fallbackSources: [
          ...(guards.fallbackSources ?? []),
          ...(source === undefined
            ? []
            : [
                {
                  ...source,
                  ...(guards.iterationSources === undefined
                    ? {}
                    : { iterationSources: guards.iterationSources }),
                },
              ]),
        ],
      },
    );
    return;
  }
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        const rest =
          source === undefined
            ? undefined
            : {
                node: source.node,
                projection: [
                  ...source.projection,
                  {
                    excludedKeys: [
                      ...new Set(semanticObjectPatternKeys(pattern)),
                    ].sort(compareUnicodeCodePoints),
                  },
                ],
              };
        if (rest !== undefined)
          context.propertyReads.push({
            ...rest,
            ...guards,
            mutation,
            lookup: "own",
          });
        // A rest copy owns its scalar slots; only selected child references
        // escape when that fresh copy is stored through a member target.
        visit(context, property.argument, rest, guards);
        continue;
      }
      const selected = project(
        source,
        semanticStaticPropertyKey(property.key, property.computed),
      );
      if (selected !== undefined)
        context.propertyReads.push({
          ...selected,
          ...guards,
          mutation,
          lookup: "prototype",
        });
      visit(context, property.value, selected, guards);
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    if (source !== undefined && source.restStartIndex === undefined)
      add(sources, source, mutation, guards);
    const selectedGuards = {
      ...guards,
      iterationSources: [
        ...(guards.iterationSources ?? []),
        ...(source === undefined ? [] : [source]),
      ],
    };
    pattern.elements.forEach((element, index) => {
      if (element === null) return;
      if (t.isRestElement(element))
        visit(
          context,
          element.argument,
          source === undefined
            ? undefined
            : {
                node: source.node,
                projection: source.projection,
                restStartIndex: (source.restStartIndex ?? 0) + index,
              },
          selectedGuards,
        );
      else visit(context, element, project(source, index), selectedGuards);
    });
    return;
  }
  if (t.isRestElement(pattern))
    visit(context, pattern.argument, undefined, guards);
};

interface SemanticSourceFacts {
  readonly iterations: readonly SemanticIterationSource[];
  readonly propertyReads: readonly SemanticPropertyReadSource[];
}
const emptySourceFacts: SemanticSourceFacts = {
  iterations: [],
  propertyReads: [],
};
// Immutable AST subtree summaries are reused by enclosing and nested catches.
// Property reads can invoke getters; tags and coercions can execute user code.
const guardedExecutions = new WeakMap<t.Node, boolean>();
const guardedBodyMayCall = (body: t.BlockStatement): boolean => {
  const pending = [{ node: body as t.Node, finish: false }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined || guardedExecutions.has(frame.node)) continue;
    const node = frame.node;
    if (t.isFunction(node)) {
      guardedExecutions.set(node, false);
      continue;
    }
    if (!frame.finish) {
      pending.push({ node, finish: true });
      for (const child of childNodes(node))
        pending.push({ node: child, finish: false });
    } else {
      const direct =
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node) ||
        t.isTaggedTemplateExpression(node) ||
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node) ||
        t.isBinaryExpression(node) ||
        t.isUnaryExpression(node) ||
        t.isUpdateExpression(node) ||
        t.isSpreadElement(node) ||
        t.isForOfStatement(node) ||
        t.isAwaitExpression(node);
      guardedExecutions.set(
        node,
        direct ||
          [...childNodes(node)].some(
            (child) => guardedExecutions.get(child) === true,
          ),
      );
    }
  }
  return guardedExecutions.get(body) === true;
};
const sourceFacts = new WeakMap<
  t.Node,
  { readonly parent: t.Node | null; readonly facts: SemanticSourceFacts }
>();

/** One owner for pattern projections, guards, iteration and copy-read sources. */
const semanticSourceFacts = (
  node: t.Node,
  parent: t.Node | null,
): SemanticSourceFacts => {
  if (
    !(
      t.isVariableDeclarator(node) ||
      t.isAssignmentExpression(node) ||
      t.isForOfStatement(node) ||
      t.isSpreadElement(node) ||
      t.isYieldExpression(node) ||
      t.isCatchClause(node) ||
      t.isFunction(node)
    )
  )
    return emptySourceFacts;
  const cached = sourceFacts.get(node);
  if (cached?.parent === parent) return cached.facts;
  const sources: SemanticIterationSource[] = [];
  const propertyReads: SemanticPropertyReadSource[] = [];
  const context = { sources, propertyReads, mutation: node };
  if (t.isVariableDeclarator(node) && node.init != null)
    visit(context, node.id, { node: node.init, projection: [] });
  else if (
    t.isAssignmentExpression(node) &&
    ["=", "||=", "&&=", "??="].includes(node.operator)
  )
    visit(context, node.left, { node: node.right, projection: [] });
  else if (t.isForOfStatement(node)) {
    add(sources, { node: node.right, projection: [] }, node, {});
    const source = { node: node.right, projection: [null] };
    if (t.isVariableDeclaration(node.left)) {
      for (const declaration of node.left.declarations)
        visit(context, declaration.id, source);
    } else visit(context, node.left, source);
  } else if (t.isSpreadElement(node)) {
    if (t.isArrayExpression(parent))
      add(sources, { node: node.argument, projection: [] }, node, {});
    else if (t.isObjectExpression(parent))
      propertyReads.push({
        node: node.argument,
        projection: [{ excludedKeys: [] }],
        mutation: node,
        lookup: "own",
      });
  } else if (
    t.isYieldExpression(node) &&
    node.delegate &&
    node.argument != null
  )
    add(sources, { node: node.argument, projection: [] }, node, {});
  else if (
    t.isCatchClause(node) &&
    node.param != null &&
    t.isTryStatement(parent) &&
    guardedBodyMayCall(parent.block)
  )
    visit(context, node.param, { node: node.param, projection: [null] });
  else if (t.isFunction(node))
    for (const parameter of runtimeFunctionParameters(node))
      // A caller-supplied value is unknown, not an absent property-read source.
      // Retain the owning pattern as an unresolved source, including alongside
      // default-value projections, instead of dropping its property lookups.
      visit(context, parameter, { node: parameter, projection: [] });
  const facts = { iterations: sources, propertyReads };
  sourceFacts.set(node, { parent, facts });
  return facts;
};

export const semanticIterationSources = (
  node: t.Node,
  parent: t.Node | null,
): readonly SemanticIterationSource[] =>
  semanticSourceFacts(node, parent).iterations;

/** Pattern reads from an explicitly retained source, including thrown values. */
export const semanticPatternPropertyReadSources = (
  pattern: t.Node,
  source: IterationSourceValue,
  mutation: t.Node,
): readonly SemanticPropertyReadSource[] => {
  const propertyReads: SemanticPropertyReadSource[] = [];
  visit({ sources: [], propertyReads, mutation }, pattern, source);
  return propertyReads;
};

export const semanticPropertyReadSources = (
  node: t.Node,
  parent: t.Node | null,
  supplemental?: {
    readonly implicitPropertyReads: WeakMap<
      t.Node,
      readonly SemanticPropertyReadSource[]
    >;
  },
): readonly SemanticPropertyReadSource[] => {
  const ordinary = semanticSourceFacts(node, parent).propertyReads;
  const implicit = supplemental?.implicitPropertyReads.get(node);
  return implicit === undefined ? ordinary : [...ordinary, ...implicit];
};
