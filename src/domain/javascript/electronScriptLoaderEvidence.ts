import * as t from "@babel/types";

import { ipcDescriptor } from "./electronStaticAnalysisIpc.js";
import { electronCalleePath } from "./electronStaticAnalysisValues.js";
import { contextBridgeExposureArguments } from "./javascriptContextBridgeExposure.js";
import { ELECTRON_MODULE } from "./javascriptElectronMemberWrites.js";
import {
  indexJavaScriptBindingsWithReceiversSteps,
  indexJavaScriptElectronIdentitySteps,
} from "./javascriptSemanticAnalysis.js";
import { hasPossibleCommonJsDelegateWrite } from "./javascriptSemanticRequireOrigin.js";
import {
  traverseJavaScriptAst,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";

/**
 * Whether a script owes its module context only to a `"type": "module"`
 * package scope and requires an Electron module. Electron's preload loader
 * ignores that package type and gives a .js preload `require`; ESM preloads
 * need the .mjs suffix ("ES Modules (ESM) in Electron"). The call alone is not
 * evidence of that loader: Node's ESM loader, which the main process uses,
 * has no `require`, so the same call there throws. Module syntax would make
 * the source a module under every loader, so only scripts qualify. The
 * source must also name `contextBridge` or `ipcRenderer`: Electron identity
 * reaches a member only through an identifier, string, or template key, so a
 * source naming neither can yield renderer evidence.
 */
export const mayRunUnderElectronScriptLoader = (
  program: t.Program,
): boolean => {
  if (
    javaScriptRuntimeContext(program) !== "module" ||
    program.sourceType !== "script"
  )
    return false;
  let requiresElectron = false;
  let namesRendererModule = false;
  traverseJavaScriptAst(program, {
    skip: () => requiresElectron && namesRendererModule,
    enter: (node) => {
      requiresElectron ||=
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "require" }) &&
        ELECTRON_MODULE.test(stringValue(node.arguments[0]) ?? "");
      namesRendererModule ||=
        (t.isIdentifier(node) && rendererModules.has(node.name)) ||
        (t.isStringLiteral(node) && rendererModules.has(node.value)) ||
        (t.isTemplateElement(node) &&
          rendererModules.has(node.value.cooked ?? ""));
    },
  });
  return requiresElectron && namesRendererModule;
};

const rendererModules: ReadonlySet<string> = new Set([
  "contextBridge",
  "ipcRenderer",
]);

/**
 * Whether the static pass could directly observe a `contextBridge` exposure
 * or a renderer IPC operation in this source. Both are renderer-process
 * Electron modules that the main process cannot obtain. This screen runs the
 * pass's binding and Electron identity preamble, source traversal and
 * exposure and IPC descriptors, but not its bundler recognition. It therefore
 * also counts factory defaults that the bundler convention never runs, which
 * only that pass excludes: a false result rules evidence out, and a true one
 * still needs the pass's own `observedElectronRendererCall`.
 */
export function* mayHaveElectronRendererEvidenceSteps(
  program: t.Program,
): Generator<void, boolean> {
  const index = yield* indexJavaScriptBindingsWithReceiversSteps(program);
  yield* index.indexAmbientWritesSteps();
  if (hasPossibleCommonJsDelegateWrite(index.bindings))
    yield* index.indexMemberMutationFactsSteps();
  const identity = yield* indexJavaScriptElectronIdentitySteps(
    program,
    index.bindings,
  );
  const context = { electronBindings: identity.bindings };
  let found = false;
  yield* traverseJavaScriptAstSteps(program, {
    skip: () => found,
    enter: (node) => {
      if (
        index.bindings.erasedSyntaxNodes.has(node) ||
        (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
      )
        return;
      const path = electronCalleePath(node.callee, context);
      found ||=
        (path?.length === 2 &&
          path[0] === "contextBridge" &&
          contextBridgeExposureArguments(path[1] ?? "", node.arguments) !==
            undefined) ||
        ipcDescriptor(path)?.side === "renderer";
    },
  });
  return found;
}
