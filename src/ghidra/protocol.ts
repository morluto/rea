import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.number().int().positive(),
    ok: z.literal(true),
    result: jsonValueSchema,
  }),
  z.strictObject({
    id: z.number().int().positive(),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(4_096),
      })
      .strict(),
  }),
]);

/** Validated response emitted by REA's packaged Ghidra script. */
export type GhidraBridgeResponse = z.infer<typeof responseSchema>;

/** Expected operation failure returned by the authenticated Java bridge. */
export class GhidraRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GhidraRemoteError";
  }
}

/** Parse one complete Java-bridge response without accepting extra fields. */
export const parseGhidraResponseLine = (
  line: string,
): Result<GhidraBridgeResponse, Error> => {
  try {
    const parsed: unknown = JSON.parse(line);
    const response = responseSchema.safeParse(parsed);
    return response.success
      ? ok(response.data)
      : err(new Error("Ghidra bridge response has an invalid shape"));
  } catch (cause: unknown) {
    return err(
      new Error("Ghidra bridge response is not valid JSON", { cause }),
    );
  }
};

/** Project one validated response into its result or remote failure. */
export const ghidraResponseResult = (
  response: GhidraBridgeResponse,
): Result<JsonValue, GhidraRemoteError> =>
  response.ok
    ? ok(response.result)
    : err(new GhidraRemoteError(response.error.code, response.error.message));
