import * as t from "@babel/types";

import {
  semanticObjectPatternKeys,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

interface IterationSourceValue {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

/** An iterator receiver or property reference store, with default guards. */
export interface SemanticIterationSource extends IterationSourceValue {
  readonly kind: "iteration" | "reference-store";
  readonly mutation: t.Node;
  readonly fallbackSources?: readonly IterationSourceValue[];
  readonly requiredSources?: readonly IterationSourceValue[];
}

interface PatternSource extends IterationSourceValue {
  // A rest binding is a fresh array whose children retain their source indices.
  readonly restStartIndex?: number;
}

interface SourceGuards {
  readonly fallbackSources?: readonly IterationSourceValue[];
  readonly requiredSources?: readonly IterationSourceValue[];
}

const add = (
  sources: SemanticIterationSource[],
  source: IterationSourceValue,
  mutation: t.Node,
  guards: SourceGuards,
  kind: SemanticIterationSource["kind"] = "iteration",
): void => {
  sources.push({
    kind,
    node: source.node,
    projection: source.projection,
    mutation,
    ...guards,
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
}

const visit = (
  context: PatternCollection,
  pattern: t.Node,
  source: PatternSource | undefined,
  guards: SourceGuards = {},
): void => {
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
        ...(source === undefined ? [] : [source]),
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
          ...(source === undefined ? [] : [source]),
        ],
      },
    );
    return;
  }
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        // A rest copy owns its scalar slots; only selected child references
        // escape when that fresh copy is stored through a member target.
        visit(
          context,
          property.argument,
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
              },
          guards,
        );
        continue;
      }
      visit(
        context,
        property.value,
        project(
          source,
          semanticStaticPropertyKey(property.key, property.computed),
        ),
        guards,
      );
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    if (source !== undefined && source.restStartIndex === undefined)
      add(sources, source, mutation, guards);
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
          guards,
        );
      else visit(context, element, project(source, index), guards);
    });
    return;
  }
  if (t.isRestElement(pattern))
    visit(context, pattern.argument, undefined, guards);
};

/** Describe iterator receivers and property reference stores without evaluation. */
export const semanticIterationSources = (
  node: t.Node,
  parent: t.Node | null,
): readonly SemanticIterationSource[] => {
  const sources: SemanticIterationSource[] = [];
  const context = { sources, mutation: node };
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
  } else if (t.isSpreadElement(node) && t.isArrayExpression(parent))
    add(sources, { node: node.argument, projection: [] }, node, {});
  else if (t.isYieldExpression(node) && node.delegate && node.argument != null)
    add(sources, { node: node.argument, projection: [] }, node, {});
  else if (t.isFunction(node))
    for (const parameter of node.params) visit(context, parameter, undefined);

  return sources;
};
