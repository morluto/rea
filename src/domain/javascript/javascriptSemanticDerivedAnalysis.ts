import type * as t from "@babel/types";

import { collectJavaScriptSemanticAsyncEffects } from "./javascriptSemanticAsyncEffects.js";
import { collectJavaScriptSemanticCalls } from "./javascriptSemanticCalls.js";
import { collectJavaScriptSemanticChildProcesses } from "./javascriptSemanticChildProcesses.js";
import { collectJavaScriptSemanticFingerprints } from "./javascriptSemanticFingerprints.js";
import { collectJavaScriptSemanticDataEffects } from "./javascriptSemanticDataEffects.js";
import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticIr,
} from "./javascriptSemanticIr.js";
import { collectJavaScriptSemanticPromises } from "./javascriptSemanticPromises.js";
import { collectJavaScriptSemanticObjects } from "./javascriptSemanticObjects.js";
import { collectJavaScriptSemanticResources } from "./javascriptSemanticResources.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

type DerivedSemanticAnalysis = Pick<
  JavaScriptSemanticIr,
  | "argumentFlows"
  | "callResultFlows"
  | "callReturnFlows"
  | "callSites"
  | "boundaryOperations"
  | "childProcessInteractions"
  | "childProcessSpawns"
  | "closureCaptures"
  | "configurationOperations"
  | "eventOperations"
  | "frontiers"
  | "functionFingerprints"
  | "objectOperations"
  | "promiseOperations"
  | "requestOperations"
  | "resourceOperations"
  | "timerOperations"
>;

/** Compose bounded semantic passes after lexical definitions are available. */
/**
 * Collect derived semantics with a yield between collectors. Each collector
 * completes before the next starts, so results equal the synchronous form.
 */
export function* collectJavaScriptDerivedSemanticsSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
  parserPartial: boolean,
): Generator<void, DerivedSemanticAnalysis> {
  const calls = collectJavaScriptSemanticCalls(program, state, callables);
  yield;
  const promiseOperations = collectJavaScriptSemanticPromises(
    program,
    state,
    callables,
  );
  yield;
  const asyncEffects = collectJavaScriptSemanticAsyncEffects(
    program,
    state,
    callables,
  );
  yield;
  const childProcesses = collectJavaScriptSemanticChildProcesses(
    program,
    state,
    callables,
  );
  yield;
  const dataEffects = collectJavaScriptSemanticDataEffects(
    program,
    state,
    callables,
  );
  yield;
  const resourceOperations = collectJavaScriptSemanticResources(
    program,
    state,
    callables,
  );
  yield;
  const objectOperations = collectJavaScriptSemanticObjects(
    program,
    state,
    callables,
  );
  yield;
  const functionFingerprints = collectJavaScriptSemanticFingerprints({
    state,
    callables,
    calls,
    promises: promiseOperations,
    events: asyncEffects.eventOperations,
    timers: asyncEffects.timerOperations,
    childProcessSpawns: childProcesses.childProcessSpawns,
    childProcessInteractions: childProcesses.childProcessInteractions,
    requestOperations: dataEffects.requestOperations,
    resourceOperations,
    parserPartial,
  });
  return {
    ...calls,
    promiseOperations,
    ...asyncEffects,
    ...childProcesses,
    ...dataEffects,
    resourceOperations,
    objectOperations,
    functionFingerprints,
  };
}
