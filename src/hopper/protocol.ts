import { z } from "zod";

import {
  HOPPER_DIAGNOSTIC_TYPES,
  HopperProtocolError,
  HopperRemoteError,
  type HopperSelectorResolution,
} from "./HopperErrors.js";
import { ownedJsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import type { JsonLineBridgeEnvelope } from "../process/JsonLineBridgeReader.js";

const hopperAddressSchema = z.string().regex(/^0x[0-9a-f]+$/u);

/** How the bridge resolved a selector that named no procedure. */
const selectorResolutionSchema = z.discriminatedUnion("source", [
  z.object({ value: z.string(), source: z.literal("unresolved") }).strict(),
  z
    .object({
      value: z.string(),
      source: z.enum(["symbol", "address"]),
      address: hopperAddressSchema,
    })
    .strict(),
  z
    .object({
      value: z.null(),
      source: z.literal("cursor"),
      address: hopperAddressSchema,
    })
    .strict(),
]) satisfies z.ZodType<HopperSelectorResolution>;

const remoteErrorSchema = z
  .object({
    code: z.int(),
    message: z.string(),
    type: z.enum(HOPPER_DIAGNOSTIC_TYPES).default("remote"),
    selector: selectorResolutionSchema.optional(),
  })
  .strict();

const responseSchema = z.union([
  z
    .object({
      id: z.int().nonnegative(),
      result: ownedJsonValueSchema,
    })
    .strict(),
  z
    .object({
      id: z.int().nonnegative(),
      error: remoteErrorSchema,
    })
    .strict(),
]);

const eventSchema = z
  .object({
    id: z.int().nonnegative(),
    event: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("progress"),
          phase: z.string().min(1),
          completed: z.number().nonnegative().finite(),
          total: z.number().nonnegative().finite().nullable(),
          message: z.string().min(1),
          terminal: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("diagnostic"),
          error: remoteErrorSchema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.event.type === "progress" &&
      message.event.total !== null &&
      message.event.completed > message.event.total
    ) {
      context.addIssue({
        code: "custom",
        message: "Progress total cannot be less than completed",
        path: ["event", "total"],
      });
    }
  });

const messageSchema = z.union([responseSchema, eventSchema]);

export type HopperResponse = z.infer<typeof responseSchema>;
export type HopperBridgeEvent = z.infer<typeof eventSchema>;
export type HopperBridgeMessage = z.infer<typeof messageSchema>;

/** Parse one complete Hopper NDJSON response or event line. */
const parseBridgeMessageLine = (
  line: string,
): Result<HopperBridgeMessage, HopperProtocolError> => {
  const decodedResult = safeParseJson(line);
  if (!decodedResult.ok)
    return err(
      new HopperProtocolError("Hopper returned malformed JSON", {
        cause: decodedResult.cause,
      }),
    );
  const decoded: unknown = decodedResult.value;

  const parsed = messageSchema.safeParse(decoded);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new HopperProtocolError(
          "Hopper returned a message outside the bridge contract",
          { cause: parsed.error },
        ),
      );
};

const hopperRemoteError = (
  error: z.infer<typeof remoteErrorSchema>,
): HopperRemoteError =>
  new HopperRemoteError(error.code, error.message, {
    diagnosticType: error.type,
    ...(error.selector === undefined ? {} : { selector: error.selector }),
  });

/** Project a parsed response into its result or expected remote failure. */
export const responseResult = (
  response: HopperResponse,
): Result<JsonValue, HopperRemoteError> =>
  "error" in response
    ? err(hopperRemoteError(response.error))
    : ok(response.result);

/** Hopper's `result | error` plus events envelope for the shared JSON-line reader. */
export const hopperReplyEnvelope: JsonLineBridgeEnvelope<
  HopperBridgeMessage,
  HopperRemoteError
> = {
  parse: parseBridgeMessageLine,
  id: (message) => message.id,
  remoteFailure: (message) =>
    "error" in message ? hopperRemoteError(message.error) : undefined,
};
