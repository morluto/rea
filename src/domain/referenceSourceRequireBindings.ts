import * as t from "@babel/types";
import { posix } from "node:path";

import {
  semanticMemberChain,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascript/javascriptAstValues.js";
import {
  indexJavaScriptBindingsWithReceiversSteps,
  type JavaScriptReceiverIndex,
} from "./javascript/javascriptSemanticAnalysis.js";
import {
  requireResolveSearchBase,
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
      if (t.isCallExpression(callee) || t.isOptionalCallExpression(callee))
        completeSemanticSteps(index.indexMemberMutationFactsSteps());
      let fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      if (
        fact === "create-require" ||
        ((t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
          ["call", "apply", "resolve"].includes(
            semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
          ))
      ) {
        completeSemanticSteps(index.indexMemberMutationFactsSteps());
        fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      }
      const callFact = semanticRequireCallAt(
        node,
        index.bindings,
        factoryBindings,
        index,
      );
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
      const searchBase = requireResolveSearchBase(callFact, index.bindings);
      candidates.push({
        call: node,
        arguments: callFact.arguments,
        resolutionBase: searchBase === "loader" ? base : searchBase,
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
