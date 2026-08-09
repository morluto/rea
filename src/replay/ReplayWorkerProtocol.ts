import { z } from "zod";

const workerOutcomeFacts = {
  case_id: z.string(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  output_sha256: z.null(),
  truncated: z.literal(false),
} as const;

const exceptionSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
  })
  .strict();

const workerOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    ...workerOutcomeFacts,
    outcome: z.literal("return"),
    value: z.json(),
  }),
  z.strictObject({
    ...workerOutcomeFacts,
    outcome: z.enum(["exception", "serialization_error", "denied"]),
    exception: z.object(exceptionSchema.shape).strict(),
  }),
]);

const singleWorkerResponseSchema = z
  .object({
    schema_version: z.literal(1),
    left: z.array(workerOutcomeSchema),
  })
  .strict();

const differentialWorkerResponseSchema = z
  .object({
    schema_version: z.literal(1),
    left: z.array(workerOutcomeSchema),
    right: z.array(workerOutcomeSchema),
  })
  .strict();

export type WorkerProtocolOutcome = z.infer<typeof workerOutcomeSchema>;
export type WorkerProtocolResponse =
  | (z.infer<typeof singleWorkerResponseSchema> & { readonly right?: never })
  | z.infer<typeof differentialWorkerResponseSchema>;

export type ReplayWorkerResponseMode = "single" | "differential";

interface ExpectedCase {
  readonly case_id: string;
  readonly sha256: string;
}

/** Strictly authenticate case ordering and commitments in worker output. */
export const parseReplayWorkerResponse = (
  rawResponse: unknown,
  cases: readonly ExpectedCase[],
  mode: ReplayWorkerResponseMode,
): WorkerProtocolResponse => {
  const response =
    mode === "single"
      ? singleWorkerResponseSchema.parse(rawResponse)
      : differentialWorkerResponseSchema.parse(rawResponse);
  validateOutcomeSequence(response.left, cases);
  if (mode === "differential")
    validateOutcomeSequence(
      differentialWorkerResponseSchema.parse(response).right,
      cases,
    );
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
