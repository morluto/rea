import { z } from "zod";

const workerOutcomeSchema = z
  .object({
    case_id: z.string(),
    outcome: z.enum(["return", "exception", "serialization_error", "denied"]),
    value: z.json().optional(),
    exception: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().nullable(),
      })
      .strict()
      .optional(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    output_sha256: z.null(),
    truncated: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "return" && value.value === undefined)
      context.addIssue({ code: "custom", message: "Return value is missing" });
    if (value.outcome !== "return" && value.exception === undefined)
      context.addIssue({ code: "custom", message: "Exception is missing" });
    if (value.outcome === "return" && value.exception !== undefined)
      context.addIssue({ code: "custom", message: "Return has an exception" });
  });

const workerResponseSchema = z
  .object({
    schema_version: z.literal(1),
    left: z.array(workerOutcomeSchema),
    right: z.array(workerOutcomeSchema).optional(),
  })
  .strict();

export type WorkerProtocolOutcome = z.infer<typeof workerOutcomeSchema>;
export type WorkerProtocolResponse = z.infer<typeof workerResponseSchema>;

interface ExpectedCase {
  readonly case_id: string;
  readonly sha256: string;
}

/** Strictly authenticate case ordering and commitments in worker output. */
export const parseReplayWorkerResponse = (
  rawResponse: unknown,
  cases: readonly ExpectedCase[],
  differential: boolean,
): WorkerProtocolResponse => {
  const response = workerResponseSchema.parse(rawResponse);
  if ((response.right !== undefined) !== differential)
    throw new TypeError("Replay worker differential response is incomplete");
  validateOutcomeSequence(response.left, cases);
  if (response.right !== undefined)
    validateOutcomeSequence(response.right, cases);
  return response;
};

const validateOutcomeSequence = (
  outcomes: readonly WorkerProtocolOutcome[],
  cases: readonly ExpectedCase[],
): void => {
  if (outcomes.length !== cases.length)
    throw new TypeError("Replay worker response case count changed");
  outcomes.forEach((outcome, index) => {
    const expected = cases[index];
    if (
      expected === undefined ||
      outcome.case_id !== expected.case_id ||
      outcome.input_sha256 !== expected.sha256
    )
      throw new TypeError("Replay worker response case identity changed");
  });
};
