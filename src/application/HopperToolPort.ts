import type { HopperError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { JsonValue } from "../hopper/protocol.js";

/** Application-owned capability for invoking one official Hopper tool. */
export interface HopperToolPort {
  callTool(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<JsonValue, HopperError>>;
}
