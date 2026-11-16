import { nativeAddressInputSchema } from "../domain/native/nativeAddress.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

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

/**
 * How two spellings of one selector agree: `text` only when identical,
 * `native` also when both are the same native address.
 */
export type CliSelectorKind = "text" | "native";

/**
 * Select the value of a selector the caller may give positionally or
 * through its named option, preserving the named spelling. Equal values
 * agree; different values, or neither when `required`, are refused.
 */
export const selectCliAnalysisSelector = (
  positional: string | undefined,
  named: string | undefined,
  selector: {
    readonly option: string;
    readonly operation: string;
    readonly kind: CliSelectorKind;
    readonly required: boolean;
  },
): Result<string | undefined, AnalysisInputError> => {
  const { option, operation, kind, required } = selector;
  const equivalent = (): boolean => {
    if (positional === named) return true;
    if (kind !== "native") return false;
    const left = nativeAddressInputSchema.safeParse(positional);
    const right = nativeAddressInputSchema.safeParse(named);
    return left.success && right.success && left.data === right.data;
  };
  if (positional !== undefined && named !== undefined && !equivalent())
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: [option],
          reason: "invalid_value",
          message: `The positional selector and --${option} select different objects; supply one selector.`,
        },
      ]),
    );
  const selected = named ?? positional;
  if (selected === undefined && required)
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: [option],
          reason: "missing_argument",
          message: `Supply a positional selector or --${option}=<value>. Use the named option for values beginning with a dash.`,
          expected: "string",
        },
      ]),
    );
  return ok(selected);
};

/** Preserve a CLI selector supplied positionally or through its named option. */
export const resolveCliAnalysisSelector = (
  positional: string | undefined,
  named: string | undefined,
  option: string,
  operation: string,
  kind: CliSelectorKind = "text",
): string => {
  const selected = selectCliAnalysisSelector(positional, named, {
    option,
    operation,
    kind,
    required: true,
  });
  if (!selected.ok) throw selected.error;
  return selected.value!;
};
