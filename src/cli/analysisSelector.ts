import { nativeAddressInputSchema } from "../domain/native/nativeAddress.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

/** Each separately emitted args/options schema must expose the selector choice. */
export const requiredSelectorGuidance = (alternatives: string): string =>
  `Supply at least one of ${alternatives}.`;

export const addressOrProcedureGuidance = requiredSelectorGuidance(
  "the positional address or --procedure",
);

/** Agreement details belong on the command, rather than every schema field. */
export const equalSelectorGuidance =
  "Equal values are accepted; conflicts fail.";

/** Data type selectors stay optional in the options schema; exactly one is required. */
export const dataTypeSelectorGuidance =
  "Supply exactly one of --type or --address.";

/** Preserve a CLI selector supplied positionally or through its named option. */
export const resolveCliAnalysisSelector = (
  positional: string | undefined,
  named: string | undefined,
  option: string,
  operation: string,
  kind: "text" | "native" = "text",
): string => {
  const equivalent = (): boolean => {
    if (positional === named) return true;
    if (kind !== "native") return false;
    const left = nativeAddressInputSchema.safeParse(positional);
    const right = nativeAddressInputSchema.safeParse(named);
    return left.success && right.success && left.data === right.data;
  };
  if (positional !== undefined && named !== undefined && !equivalent())
    throw new AnalysisInputError(operation, undefined, [
      {
        path: [option],
        reason: "invalid_value",
        message: `The positional selector and --${option} select different objects; supply one selector.`,
      },
    ]);
  const selected = named ?? positional;
  if (selected === undefined)
    throw new AnalysisInputError(operation, undefined, [
      {
        path: [option],
        reason: "missing_argument",
        message: `Supply a positional selector or --${option}=<value>. Use the named option for values beginning with a dash.`,
        expected: "string",
      },
    ]);
  return selected;
};
