import * as t from "@babel/types";
import { posix } from "node:path";

import {
  semanticMemberChain,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascript/javascriptAstValues.js";
import { isUnmodifiedGlobalReference } from "./javascript/javascriptSemanticAmbientWrites.js";
import {
  indexJavaScriptBindingsWithReceiversSteps,
  type JavaScriptReceiverIndex,
} from "./javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticAnalysisState } from "./javascript/javascriptSemanticState.js";
import { semanticEffectPathMatches } from "./javascript/javascriptSemanticEffectPathIndex.js";
import { semanticDefiniteEffectPrecedesReference } from "./javascript/javascriptSemanticMutationInitializers.js";
import {
  assignmentValueSources,
  semanticRequireCallAt,
  semanticRequireLoaderAt,
  semanticSelectedMemberMayHaveChanged,
  type JavaScriptRequireCallFact,
} from "./javascript/javascriptSemanticRequireOrigin.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascript/javascriptSemanticTraversal.js";
import {
  javaScriptRuntimeContext,
  type ParsedJavaScriptSource,
} from "./javascript/javascriptSourceParser.js";

export type ReferenceSourceRequireResolutionBase =
  | "source-file"
  | { readonly kind: "source-relative-file"; readonly path: string }
  | "unknown";

export interface ReferenceSourceRequireCall {
  readonly arguments: JavaScriptRequireCallFact["arguments"];
  readonly resolutionBase: ReferenceSourceRequireResolutionBase;
  readonly limitation?: string;
}

export type ReferenceSourceRequireInvocation =
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression;

/** Identify exact calls through a source-owned Node loader and their resolver base. */
export const referenceSourceRequireCalls = (
  file: Pick<ParsedJavaScriptSource, "program">,
  path: string,
): ReadonlyMap<
  ReferenceSourceRequireInvocation,
  ReferenceSourceRequireCall
> => {
  // Unmarked paths depend on package scope or compiler options. Preserve their
  // candidate CommonJS edges; explicit module paths have no wrapper loader.
  const runtimeContext = javaScriptRuntimeContext(file.program);
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      file.program,
      runtimeContext === "module" ? undefined : "commonjs-wrapper",
    ),
  );
  const factoryBindings: ReadonlySet<string> = new Set();
  const candidates: {
    readonly call: ReferenceSourceRequireInvocation;
    readonly arguments: JavaScriptRequireCallFact["arguments"];
    readonly resolutionBase: ReferenceSourceRequireResolutionBase;
    readonly limitation?: string;
  }[] = [];
  traverseJavaScriptAst(file.program, {
    enter: (node) => {
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isNewExpression(node)
      )
        return;
      const callee = unwrapJavaScriptExpression(node.callee).node;
      if (
        !t.isCallExpression(callee) &&
        !t.isOptionalCallExpression(callee) &&
        !hasIdentifierReceiver(callee)
      )
        return;
      let fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      let callFact = semanticRequireCallAt(
        node,
        index.bindings,
        factoryBindings,
        index,
      );
      const refreshIndexedFacts = (): void => {
        // Definitions identify a possible factory. Its mutable member reads
        // need the shared write index before they can prove an association.
        completeSemanticSteps(index.indexMemberMutationFactsSteps());
        fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
        callFact = semanticRequireCallAt(
          node,
          index.bindings,
          factoryBindings,
          index,
        );
      };
      if (
        fact === "create-require" ||
        ((t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
          ["call", "apply", "resolve"].includes(
            semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
          ))
      )
        refreshIndexedFacts();
      if (t.isCallExpression(callee) || t.isOptionalCallExpression(callee)) {
        // Index before trusting a returned member. A definite assignment that
        // precedes the call replaces the original initializer; an unchanged
        // member keeps the classification made before that index, because the
        // call itself is recorded as an escape of the value it invokes.
        completeSemanticSteps(index.indexMemberMutationFactsSteps());
        if (callReturnsReassignedMember(index, node)) refreshIndexedFacts();
      }
      if (callFact === undefined || callFact.loader === "local") return;
      if (
        fact !== "create-require" &&
        fact !== "commonjs-loader" &&
        callFact.loader !== "create-require" &&
        callFact.loader !== "commonjs-loader"
      )
        return;
      const sourceRelativePath = callFact.sourceRelativePath;
      const normalizedSourceRelativePath =
        sourceRelativePath === undefined
          ? undefined
          : posix.normalize(
              posix.join(posix.dirname(path), sourceRelativePath),
            );
      const base: ReferenceSourceRequireResolutionBase =
        runtimeContext === "unknown"
          ? "unknown"
          : callFact.loader === "create-require"
            ? sourceRelativePath === undefined
              ? callFact.sourceRelative === true
                ? "source-file"
                : "unknown"
              : normalizedSourceRelativePath === undefined ||
                  normalizedSourceRelativePath === ".." ||
                  normalizedSourceRelativePath.startsWith("../")
                ? "unknown"
                : normalizedSourceRelativePath === path
                  ? "source-file"
                  : {
                      kind: "source-relative-file",
                      path: normalizedSourceRelativePath,
                    }
            : callFact.loader === "commonjs-loader" &&
                runtimeContext === "commonjs"
              ? "source-file"
              : "unknown";
      const searchBase = requireResolveSearchBase(
        callFact.operation,
        callFact.arguments,
        index.bindings,
        base,
        runtimeContext === "commonjs",
      );
      candidates.push({
        call: node,
        arguments: callFact.arguments,
        resolutionBase: searchBase,
        ...(runtimeContext === "unknown"
          ? {
              limitation: `Module context is unknown in ${path}; the requested dependency was retained without a proven loader base.`,
            }
          : {}),
      });
    },
  });
  if (candidates.some(({ call }) => hasMemberCallee(call)))
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return new Map(
    candidates.map(
      ({ call, arguments: callArguments, resolutionBase, limitation }) =>
        [
          call,
          {
            arguments: callArguments,
            ...(limitation === undefined ? {} : { limitation }),
            resolutionBase:
              hasMemberCallee(call) && hasPriorMemberMutation(index, call)
                ? "unknown"
                : resolutionBase,
          },
        ] as const,
    ),
  );
};

/** `require.resolve` options replace the default search paths unless exact current-directory paths are supplied. */
const requireResolveSearchBase = (
  operation: JavaScriptRequireCallFact["operation"],
  callArguments: JavaScriptRequireCallFact["arguments"],
  bindings: JavaScriptSemanticAnalysisState,
  loaderBase: ReferenceSourceRequireResolutionBase,
  hasCommonJsWrapper: boolean,
): ReferenceSourceRequireResolutionBase => {
  const arguments_ = callArguments ?? [];
  if (operation !== "resolve" || arguments_.length < 2) return loaderBase;
  if (arguments_.length !== 2) return "unknown";
  const options = t.isExpression(arguments_[1]) ? arguments_[1] : undefined;
  if (options === undefined || !t.isObjectExpression(options)) return "unknown";
  if (options.properties.length === 0) return loaderBase;
  if (options.properties.length !== 1) return "unknown";
  const property = options.properties[0];
  if (!t.isObjectProperty(property)) return "unknown";
  if (semanticStaticPropertyKey(property.key, property.computed) !== "paths")
    return "unknown";
  const value = t.isExpression(property.value) ? property.value : undefined;
  if (!t.isArrayExpression(value) || value.elements.length !== 1)
    return "unknown";
  const directory = value.elements[0];
  return hasCommonJsWrapper &&
    t.isIdentifier(directory, { name: "__dirname" }) &&
    isUnmodifiedGlobalReference(directory, bindings, "__dirname")
    ? "source-file"
    : "unknown";
};

const hasPriorMemberMutation = (
  index: JavaScriptReceiverIndex,
  site: ReferenceSourceRequireInvocation,
): boolean => {
  const callee = unwrapJavaScriptExpression(site.callee).node;
  return (
    semanticMemberChain(callee) === undefined ||
    semanticSelectedMemberMayHaveChanged(index, site, callee)
  );
};

const callReturnsReassignedMember = (
  index: JavaScriptReceiverIndex,
  site: ReferenceSourceRequireInvocation,
): boolean => {
  return returnedMemberExpressions(site.callee).some((member) => {
    const chain = semanticMemberChain(member);
    if (chain === undefined || !t.isIdentifier(chain.root)) return false;
    const binding = index.bindingForReferenceAt(member);
    if (binding === undefined) return false;
    return binding.memberWrites.some(
      (write) =>
        write.receiverIdentity === "definite" &&
        write.node !== undefined &&
        t.isAssignmentExpression(write.node, { operator: "=" }) &&
        semanticEffectPathMatches(write.path, chain.members) &&
        semanticDefiniteEffectPrecedesReference(
          write.node,
          site,
          index.bindings.parentsByNode,
        ),
    );
  });
};

const returnedMemberExpressions = (
  callee: t.Node,
): readonly (t.MemberExpression | t.OptionalMemberExpression)[] => {
  const invoked = unwrapJavaScriptExpression(callee).node;
  if (!t.isCallExpression(invoked) && !t.isOptionalCallExpression(invoked))
    return [];
  const owner = unwrapJavaScriptExpression(invoked.callee).node;
  if (!t.isFunction(owner) || owner.async || owner.generator) return [];
  const returned = t.isBlockStatement(owner.body)
    ? singleReturnedExpression(owner.body)
    : owner.body;
  return returned === undefined ? [] : memberLeaves(returned);
};

const memberLeaves = (
  node: t.Node,
): readonly (t.MemberExpression | t.OptionalMemberExpression)[] => {
  const value = unwrapJavaScriptExpression(node).node;
  if (t.isMemberExpression(value) || t.isOptionalMemberExpression(value))
    return [value];
  if (t.isSequenceExpression(value)) {
    const last = value.expressions.at(-1);
    return last === undefined ? [] : memberLeaves(last);
  }
  if (t.isConditionalExpression(value))
    return [
      ...memberLeaves(value.consequent),
      ...memberLeaves(value.alternate),
    ];
  if (t.isLogicalExpression(value))
    return [...memberLeaves(value.left), ...memberLeaves(value.right)];
  if (t.isAssignmentExpression(value))
    return assignmentValueSources(value).flatMap((source) =>
      memberLeaves(source),
    );
  return [];
};

const singleReturnedExpression = (
  body: t.BlockStatement,
): t.Expression | undefined => {
  const [statement] = body.body;
  if (body.body.length !== 1 || !t.isReturnStatement(statement))
    return undefined;
  return statement.argument ?? undefined;
};

const hasMemberCallee = (call: ReferenceSourceRequireInvocation): boolean => {
  const callee = unwrapJavaScriptExpression(call.callee).node;
  return t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee);
};

const hasIdentifierReceiver = (callee: t.Node): boolean => {
  let expression = callee;
  while (
    t.isMemberExpression(expression) ||
    t.isOptionalMemberExpression(expression)
  )
    expression = unwrapJavaScriptExpression(expression.object).node;
  return t.isIdentifier(expression);
};
