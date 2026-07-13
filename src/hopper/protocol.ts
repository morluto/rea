import { z } from "zod";

import { HopperProtocolError, HopperRemoteError } from "../domain/errors.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

const responseSchema = z.union([
  z.object({
    id: z.number().int().nonnegative(),
    result: jsonValueSchema,
  }),
  z.object({
    id: z.number().int().nonnegative(),
    error: z.object({
      code: z.number().int(),
      message: z.string(),
      type: z
        .enum([
          "remote",
          "authorization",
          "invalid_request",
          "bridge_exception",
        ])
        .default("remote"),
    }),
  }),
]);

export type HopperResponse = z.infer<typeof responseSchema>;

/** Parse one complete Hopper NDJSON response line. */
export const parseResponseLine = (
  line: string,
): Result<HopperResponse, HopperProtocolError> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (cause: unknown) {
    return err(
      new HopperProtocolError("Hopper returned malformed JSON", { cause }),
    );
  }

  const parsed = responseSchema.safeParse(decoded);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new HopperProtocolError(
          "Hopper returned a response outside the bridge contract",
          { cause: parsed.error },
        ),
      );
};

/** Project a parsed response into its result or expected remote failure. */
export const responseResult = (
  response: HopperResponse,
): Result<JsonValue, HopperRemoteError> =>
  "error" in response
    ? err(
        new HopperRemoteError(
          response.error.code,
          response.error.message,
          response.error.type,
        ),
      )
    : ok(response.result);
