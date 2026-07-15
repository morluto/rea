import type {
  JavaScriptAnalysisAccumulator,
  JavaScriptFindingContext,
  JavaScriptModuleRange,
  LocatedJavaScriptFinding,
  LocatedJavaScriptFindingInput,
} from "./javascriptStaticAnalysisState.js";

/** Add one module-attributable finding under the shared global finding bound. */
export const addLocatedFinding = <
  Value extends { readonly module_key: string | null },
>(
  context: JavaScriptFindingContext,
  input: LocatedJavaScriptFindingInput<Value>,
): void =>
  addBoundedFinding(
    context.accumulator,
    `${input.key}\0${String(input.node.start)}`,
    context.maximum,
    () =>
      input.collection.push({
        offset: input.node.start ?? -1,
        value: input.value,
      }),
  );

/** Reserve one deterministic finding key before mutating an accumulator. */
export const addBoundedFinding = (
  accumulator: JavaScriptAnalysisAccumulator,
  key: string,
  maximum: number,
  add: () => void,
): void => {
  if (accumulator.seen.has(key)) return;
  if (accumulatedFindingCount(accumulator) >= maximum) {
    accumulator.droppedFindings += 1;
    return;
  }
  accumulator.seen.add(key);
  add();
};

/** Attach recovered bundle-module ownership to findings after traversal. */
export const finalizeLocatedFindings = <
  Value extends { readonly module_key: string | null },
>(
  values: readonly LocatedJavaScriptFinding<Value>[],
  modules: readonly JavaScriptModuleRange[],
): Value[] =>
  values.map(({ offset, value }) => ({
    ...value,
    module_key: moduleAtOffset(offset, modules)?.key ?? null,
  }));

/** Locate the recovered bundle factory containing one exact source offset. */
export const moduleAtOffset = (
  offset: number | null | undefined,
  modules: readonly JavaScriptModuleRange[],
): JavaScriptModuleRange | undefined => {
  if (offset === null || offset === undefined) return undefined;
  return modules.find(({ start, end }) => offset >= start && offset <= end);
};

const accumulatedFindingCount = (
  accumulator: JavaScriptAnalysisAccumulator,
): number =>
  accumulator.references.length +
  accumulator.endpoints.length +
  accumulator.storage.length +
  accumulator.roles.length +
  accumulator.sourceMaps.length +
  accumulator.registrations.length +
  accumulator.browserWindows.length +
  accumulator.contextBridgeApis.length +
  accumulator.ipc.length +
  accumulator.senderValidations.length +
  accumulator.utilityProcesses.length +
  accumulator.nativeAddonBindings.length;
