import { addressedValue } from "../contracts/toolOutputSchemaPrimitives.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisOperationPort } from "./AnalysisProvider.js";
import { resolveProcedureAddress } from "./ProcedureAddressResolution.js";

/** Resolve a CLI symbol selector without changing existing address spellings. */
export const resolveXrefsAddress = async (
  analysis: AnalysisOperationPort,
  selector: string,
  signal: AbortSignal,
): Promise<Result<string, AnalysisError>> => {
  if (
    selector.length === 0 ||
    /^[0-9a-f]+$/iu.test(selector) ||
    /^0x/iu.test(selector) ||
    /:0x/iu.test(selector)
  )
    return ok(selector);

  const inventory = await analysis.execute("list_names", {}, { signal });
  if (!inventory.ok) {
    if (
      inventory.error instanceof AnalysisCapabilityUnavailableError &&
      inventory.error.operation === "list_names" &&
      !inventory.error.cleanupIncomplete
    )
      return resolveProcedureAddress(
        async (operation, parameters, signal) => {
          const result = await analysis.execute(
            operation,
            parameters,
            signal === undefined ? {} : { signal },
          );
          return result.ok ? ok(result.value.result) : result;
        },
        selector,
        signal,
      );
    return inventory;
  }
  if (!Array.isArray(inventory.value.result))
    return err(
      new AnalysisOutputError(
        "list_names",
        "Expected a symbol inventory array",
      ),
    );

  const addresses = new Set<string>();
  for (const [index, item] of inventory.value.result.entries()) {
    const parsed = addressedValue.safeParse(item);
    if (!parsed.success || parsed.data.address.length === 0)
      return err(
        new AnalysisOutputError(
          "list_names",
          `Invalid symbol inventory entry at index ${index}`,
        ),
      );
    if (parsed.data.value === selector) addresses.add(parsed.data.address);
  }
  const [address] = addresses;
  if (addresses.size === 1 && address !== undefined) return ok(address);
  return err(
    new AnalysisInputError("xrefs", undefined, [
      {
        path: ["address"],
        reason: "invalid_value",
        message:
          addresses.size === 0
            ? `Unknown analyzed symbol name ${JSON.stringify(selector)}. Use an exact analyzed name or a hexadecimal address.`
            : `Analyzed symbol name ${JSON.stringify(selector)} is ambiguous at ${[...addresses].join(", ")}. Select an exact address.`,
      },
    ]),
  );
};
