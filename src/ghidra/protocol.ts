import { GhidraAdmissionError } from "./GhidraAdmissionError.js";
import { z } from "zod";

import { ownedJsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonLineBridgeEnvelope } from "../process/JsonLineBridgeReader.js";

const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.int().positive(),
    ok: z.literal(true),
    result: ownedJsonValueSchema,
  }),
  z.strictObject({
    // Id 0 is BRIDGE_CONNECTION_FAILURE_ID: the bridge could not parse the
    // request, so it cannot name the request id it rejects.
    id: z.int().nonnegative(),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        /** Every matching candidate address, sent for an ambiguous selector only. */
        candidates: z.array(z.string().min(1)).min(2).exactOptional(),
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
    /** Every matching candidate address of an ambiguous selector. */
    readonly candidates?: readonly string[],
  ) {
    super(message);
    this.name = "GhidraRemoteError";
  }
}

/** The remote failure one rejected request carries. */
export const ghidraRemoteError = (
  error: Extract<GhidraBridgeResponse, { ok: false }>["error"],
): GhidraRemoteError =>
  new GhidraRemoteError(error.code, error.message, error.candidates);

/** Parse one complete Java-bridge response without accepting extra fields. */
const parseGhidraResponseLine = (
  line: string,
): Result<GhidraBridgeResponse, Error> => {
  try {
    const parsed: unknown = JSON.parse(line);
    const response = responseSchema.safeParse(parsed);
    return response.success
      ? ok(response.data)
      : err(new GhidraAdmissionError("response_shape"));
  } catch (cause: unknown) {
    return err(new GhidraAdmissionError("response_json", undefined, { cause }));
  }
};

/** Ghidra's `ok`-discriminated envelope for the shared JSON-line reader. */
export const ghidraReplyEnvelope: JsonLineBridgeEnvelope<
  GhidraBridgeResponse,
  GhidraRemoteError
> = {
  parse: parseGhidraResponseLine,
  id: (response) => response.id,
  remoteFailure: (response) =>
    response.ok ? undefined : ghidraRemoteError(response.error),
};
