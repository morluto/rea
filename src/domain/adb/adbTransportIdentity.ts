import { z } from "zod";

const MAX_TRANSPORT_ID = "18446744073709551615";

/** Canonical positive uint64 identity; independent of JSON number precision. */
export const adbTransportIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .refine(
    (value) =>
      value.length < MAX_TRANSPORT_ID.length ||
      (value.length === MAX_TRANSPORT_ID.length && value <= MAX_TRANSPORT_ID),
    "Transport ID exceeds the unsigned 64-bit range",
  )
  .brand<"AdbTransportId">();

export const adbTransportIdentitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reported"),
    decimal: adbTransportIdSchema,
    source_token: z.string(),
    source_line: z.string(),
  }),
  z.strictObject({
    status: z.literal("not_reported"),
    source_token: z.null(),
    source_line: z.string(),
  }),
  z.strictObject({
    status: z.literal("invalid"),
    source_token: z.string(),
    source_line: z.string(),
    reason: z.enum(["invalid_decimal", "reserved_zero", "outside_uint64"]),
  }),
]);
export type AdbTransportIdentity = z.output<typeof adbTransportIdentitySchema>;

/** Admit source decimal text once; never round a transport identity through Number. */
export const parseAdbTransportIdentity = (
  source_token: string | null,
  source_line: string,
): AdbTransportIdentity => {
  if (source_token === null)
    return { status: "not_reported", source_token, source_line };
  if (!/^\d+$/u.test(source_token))
    return {
      status: "invalid",
      source_token,
      source_line,
      reason: "invalid_decimal",
    };
  const decimal = source_token.replace(/^0+(?=\d)/u, "");
  if (decimal === "0")
    return {
      status: "invalid",
      source_token,
      source_line,
      reason: "reserved_zero",
    };
  const admitted = adbTransportIdSchema.safeParse(decimal);
  return admitted.success
    ? { status: "reported", decimal: admitted.data, source_token, source_line }
    : {
        status: "invalid",
        source_token,
        source_line,
        reason: "outside_uint64",
      };
};
