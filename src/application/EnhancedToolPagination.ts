import type { AnalysisOperation } from "./AnalysisProvider.js";
import { AnalysisOutputError, type AnalysisError } from "../domain/errors.js";
import { parseAddressedPage } from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

type PageCall = (
  name: AnalysisOperation,
  arguments_: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
) => Promise<Result<JsonValue, AnalysisError>>;

/** Read all addressed entries while enforcing advancing provider pagination. */
export const readAllAddressed = async (input: {
  readonly call: PageCall;
  readonly tool: "list_names" | "list_procedures";
  readonly signal?: AbortSignal;
}) => {
  const entries: Array<{ address: string; name: string }> = [];
  let offset = 0;
  while (true) {
    const result = await input.call(
      input.tool,
      { offset, limit: 500 },
      input.signal,
    );
    if (!result.ok) return result;
    const page = parseAddressedPage(result.value);
    if (!page.ok) return page;
    entries.push(...page.value.items);
    if (!page.value.hasMore || page.value.nextOffset === null)
      return ok(entries);
    if (page.value.nextOffset <= offset)
      return err(
        new AnalysisOutputError(
          input.tool,
          "provider returned a non-advancing pagination offset",
        ),
      );
    offset = page.value.nextOffset;
  }
};
