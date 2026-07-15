import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

const responseSchema = z
  .object({
    id: z.number().int().positive(),
    ok: z.boolean(),
    result: jsonValueSchema.optional(),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(4_096),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && value.result === undefined)
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Successful Ghidra response requires a result",
      });
    if (!value.ok && value.error === undefined)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed Ghidra response requires an error",
      });
    if (!value.ok && value.result !== undefined)
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Failed Ghidra response cannot include a result",
      });
    if (value.ok && value.error !== undefined)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Successful Ghidra response cannot include an error",
      });
  });

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
    ? ok(response.result ?? null)
    : err(
        new GhidraRemoteError(
          response.error?.code ?? "bridge_error",
          response.error?.message ?? "Ghidra bridge request failed",
        ),
      );
