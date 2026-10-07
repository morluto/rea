import type {
  JavaScriptAnalysisAccumulator,
  JavaScriptFindingContext,
  JavaScriptModuleRange,
  LocatedJavaScriptFinding,
  LocatedJavaScriptFindingInput,
} from "./javascriptStaticAnalysisState.js";

/** Add one module-attributable finding once per source location. */
export const addLocatedFinding = <
  Value extends { readonly module_key: string | null },
>(
  context: JavaScriptFindingContext,
  input: LocatedJavaScriptFindingInput<Value>,
): void =>
  addFindingOnce(
    context.accumulator,
    `${input.key}\0${String(input.node.start)}`,
    () =>
      input.collection.push({
        offset: input.node.start ?? -1,
        value: input.value,
      }),
  );

/** Reserve one deterministic finding key before mutating an accumulator. */
export const addFindingOnce = (
  accumulator: JavaScriptAnalysisAccumulator,
  key: string,
  add: () => void,
): void => {
  if (accumulator.seen.has(key)) return;
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
