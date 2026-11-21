import { z } from "zod";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { err, ok, type Result } from "../result.js";
import { AnalysisInputError } from "../analysisErrorCore.js";
import {
  analysisInputErrorFromIssues,
  projectInputIssues,
} from "../inputIssueProjection.js";

export const MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS = 1024;
export const DEFAULT_LIBRARY_FUNCTION_BUDGET = 10_000;
export const DEFAULT_LIBRARY_FUNCTION_BYTES_BUDGET = 4_096;
export const DEFAULT_LIBRARY_SIGNATURE_SET_BUDGET = 10_000;
export const DEFAULT_LIBRARY_MATCHES_BUDGET = 10_000;
export const DEFAULT_LIBRARY_COMPARISON_WORK_BUDGET = 100_000_000;

const OPERATION = "identify_library_functions";

const outOfRangeError = (
  maximum: number,
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [], reason: "out_of_range", maximum, message },
  ]);

const invalidValueError = (
  path: readonly (string | number)[],
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [...path], reason: "invalid_value", message },
  ]);

const toInputError = (
  error: z.ZodError,
  rawInput: unknown,
  basePath: readonly (string | number)[],
): AnalysisInputError =>
  new AnalysisInputError(
    OPERATION,
    { cause: error },
    projectInputIssues(error.issues, rawInput).map((issue) => ({
      ...issue,
      path: [...basePath, ...issue.path],
    })),
  );

const signatureToken = /^(?:[0-9A-Fa-f]{2}|\?\?)$/u;

export const libraryFunctionSignatureSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  library: z.string().min(1),
  library_version: z.string().min(1).nullable().default(null),
  pattern: z.string().trim().min(1),
});

export const libraryFunctionBytesSchema = z.array(
  z.number().int().min(0).max(255),
);

const libraryFunctionIdSchema = z.string().min(1);

export const libraryFunctionInputSchema = z.strictObject({
  function_id: libraryFunctionIdSchema,
  bytes: libraryFunctionBytesSchema,
});

const libraryFunctionInputEnvelopeSchema = z.strictObject({
  function_id: libraryFunctionIdSchema,
  bytes: z.unknown(),
});

export const libraryFunctionBudgetsSchema = z.strictObject({
  max_functions: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_FUNCTION_BUDGET),
  max_function_bytes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_FUNCTION_BYTES_BUDGET),
  max_signatures: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_SIGNATURE_SET_BUDGET),
  max_matches: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_MATCHES_BUDGET),
  max_comparison_work: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_COMPARISON_WORK_BUDGET),
});

export const libraryFunctionMatchSchema = z.strictObject({
  signature_id: z.string().min(1),
  name: z.string().min(1),
  library: z.string().min(1),
  library_version: z.string().min(1).nullable(),
  pattern_length: z.number().int().positive(),
  wildcard_count: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  confidence: z.enum(["exact", "pattern"]),
});

export const libraryFunctionIdentificationSchema = z.strictObject({
  identified: z.array(
    z.strictObject({
      function_id: z.string().min(1),
      matches: z.array(libraryFunctionMatchSchema),
    }),
  ),
  unknowns: z.array(
    z.strictObject({
      function_id: z.string().min(1),
      reason: z.enum([
        "function_budget_exceeded",
        "function_bytes_budget_exceeded",
      ]),
    }),
  ),
});

export type LibraryFunctionSignature = z.output<
  typeof libraryFunctionSignatureSchema
>;
export type LibraryFunctionInput = z.output<typeof libraryFunctionInputSchema>;
export type LibraryFunctionBudgets = z.output<
  typeof libraryFunctionBudgetsSchema
>;
export type LibraryFunctionMatch = z.output<typeof libraryFunctionMatchSchema>;
export type LibraryFunctionIdentification = z.output<
  typeof libraryFunctionIdentificationSchema
>;

type CompiledSignature = LibraryFunctionSignature & {
  readonly bytes: readonly (number | null)[];
  readonly wildcard_count: number;
  readonly concrete_count: number;
};

const parseSignature = (
  raw: LibraryFunctionSignature,
  signatureIndex: number,
): Result<CompiledSignature, AnalysisInputError> => {
  const invalidPattern = (): Result<never, AnalysisInputError> =>
    err(
      invalidValueError(
        [signatureIndex, "pattern"],
        `Pattern must contain at most ${MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS} hexadecimal or ?? tokens`,
      ),
    );
  // Reject excess or malformed tokens while scanning, before constructing an
  // array proportional to an untrusted pattern's full length.
  const bytes: (number | null)[] = [];
  let offset = 0;
  while (offset < raw.pattern.length) {
    while (offset < raw.pattern.length && /\s/u.test(raw.pattern[offset]!))
      offset++;
    if (offset === raw.pattern.length) break;
    if (bytes.length === MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS)
      return invalidPattern();
    const start = offset;
    while (offset < raw.pattern.length && !/\s/u.test(raw.pattern[offset]!)) {
      offset++;
      if (offset - start > 2) return invalidPattern();
    }
    const token = raw.pattern.slice(start, offset);
    if (!signatureToken.test(token)) return invalidPattern();
    bytes.push(token === "??" ? null : Number.parseInt(token, 16));
  }
  const wildcard_count = bytes.filter((byte) => byte === null).length;
  const concrete_count = bytes.length - wildcard_count;
  if (concrete_count === 0)
    return err(
      invalidValueError(
        [signatureIndex, "pattern"],
        "Pattern must contain at least one concrete byte",
      ),
    );
  return ok({ ...raw, bytes, wildcard_count, concrete_count });
};

const compileSignatures = (
  rawSignatures: readonly unknown[],
  maxSignatures: number,
): Result<readonly CompiledSignature[], AnalysisInputError> => {
  if (rawSignatures.length > maxSignatures)
    return err(
      outOfRangeError(
        maxSignatures,
        `Signature set exceeds the maximum of ${maxSignatures} signatures`,
      ),
    );
  const seen = new Set<string>();
  const compiled: CompiledSignature[] = [];
  for (let index = 0; index < rawSignatures.length; index++) {
    const rawSignature = rawSignatures[index];
    const parsedSignature =
      libraryFunctionSignatureSchema.safeParse(rawSignature);
    if (!parsedSignature.success)
      return err(toInputError(parsedSignature.error, rawSignature, [index]));
    const signature = parsedSignature.data;
    if (seen.has(signature.id))
      return err(
        invalidValueError(
          [index, "id"],
          `Duplicate signature id: ${signature.id}`,
        ),
      );
    seen.add(signature.id);
    const parsed = parseSignature(signature, index);
    if (!parsed.ok) return parsed;
    compiled.push(parsed.value);
  }
  return ok(compiled);
};

const rankMatches = (
  signatures: readonly CompiledSignature[],
): LibraryFunctionMatch[] =>
  signatures
    .map((signature) => ({
      signature_id: signature.id,
      name: signature.name,
      library: signature.library,
      library_version: signature.library_version,
      pattern_length: signature.bytes.length,
      wildcard_count: signature.wildcard_count,
      score: signature.concrete_count / signature.bytes.length,
      confidence:
        signature.wildcard_count === 0
          ? ("exact" as const)
          : ("pattern" as const),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.pattern_length - left.pattern_length ||
        compareUnicodeCodePoints(left.signature_id, right.signature_id),
    );

const parseFunctionIdWithoutBytes = (
  rawInput: unknown,
  functionIndex: number,
): Result<string, AnalysisInputError> => {
  const isPlainEnvelope =
    typeof rawInput === "object" &&
    rawInput !== null &&
    !Array.isArray(rawInput) &&
    Object.keys(rawInput).length === 2 &&
    "function_id" in rawInput &&
    "bytes" in rawInput;
  if (!isPlainEnvelope) {
    const parsed = libraryFunctionInputEnvelopeSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(toInputError(parsed.error, rawInput, [functionIndex]));
    return ok(parsed.data.function_id);
  }

  const parsedId = libraryFunctionIdSchema.safeParse(
    (rawInput as { readonly function_id: unknown }).function_id,
  );
  if (!parsedId.success)
    return err(
      toInputError(parsedId.error, rawInput, [functionIndex, "function_id"]),
    );
  return ok(parsedId.data);
};

const parseBudgets = (
  rawBudgets: unknown,
): Result<LibraryFunctionBudgets, AnalysisInputError> => {
  const budgetInput = rawBudgets === undefined ? {} : rawBudgets;
  const budgetsParsed = libraryFunctionBudgetsSchema.safeParse(budgetInput);
  if (!budgetsParsed.success)
    return err(
      analysisInputErrorFromIssues(
        OPERATION,
        budgetsParsed.error.issues,
        budgetInput,
        { cause: budgetsParsed.error },
      ),
    );
  return ok(budgetsParsed.data);
};

const validateArrayInput = (
  input: unknown,
): Result<readonly unknown[], AnalysisInputError> => {
  if (Array.isArray(input)) return ok(input);
  const parsed = z.array(z.unknown()).safeParse(input);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(OPERATION, parsed.error.issues, input, {
        cause: parsed.error,
      }),
    );
  return ok(parsed.data);
};

type FunctionProcessingOutcome =
  | {
      readonly kind: "identified";
      readonly function_id: string;
      readonly matches: readonly LibraryFunctionMatch[];
    }
  | {
      readonly kind: "unknown";
      readonly function_id: string;
      readonly reason:
        | "function_budget_exceeded"
        | "function_bytes_budget_exceeded";
    };

type FunctionProcessingContext = {
  readonly budgets: LibraryFunctionBudgets;
  readonly signatures: readonly CompiledSignature[];
  readonly matchCache: Map<string, readonly LibraryFunctionMatch[]>;
  totalMatches: number;
  comparisonWork: number;
};

const checkSignatureMatch = (
  bytes: readonly number[],
  signature: CompiledSignature,
  context: FunctionProcessingContext,
): Result<boolean, AnalysisInputError> => {
  if (bytes.length < signature.bytes.length) {
    return ok(false);
  }
  for (let i = 0; i < signature.bytes.length; i++) {
    context.comparisonWork++;
    if (context.comparisonWork > context.budgets.max_comparison_work) {
      return err(
        outOfRangeError(
          context.budgets.max_comparison_work,
          `Comparison work exceeds the maximum of ${context.budgets.max_comparison_work} comparisons`,
        ),
      );
    }
    const expected = signature.bytes[i];
    if (expected !== null && expected !== bytes[i]) {
      return ok(false);
    }
  }
  return ok(true);
};

const getCandidateMatches = (
  bytes: readonly number[],
  context: FunctionProcessingContext,
): Result<readonly LibraryFunctionMatch[], AnalysisInputError> => {
  const prefix = bytes.slice(0, MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS);
  const cacheKey = prefix.join(",");
  const cached = context.matchCache.get(cacheKey);
  if (cached !== undefined) {
    if (context.totalMatches + cached.length > context.budgets.max_matches) {
      return err(
        outOfRangeError(
          context.budgets.max_matches,
          `Total matches exceed the maximum of ${context.budgets.max_matches} matches`,
        ),
      );
    }
    context.totalMatches += cached.length;
    return ok(cached);
  }

  const matchedSignatures: CompiledSignature[] = [];
  for (let s = 0; s < context.signatures.length; s++) {
    const signature = context.signatures[s]!;
    const matchResult = checkSignatureMatch(bytes, signature, context);
    if (!matchResult.ok) return matchResult;
    if (matchResult.value) {
      if (
        context.totalMatches + matchedSignatures.length + 1 >
        context.budgets.max_matches
      ) {
        return err(
          outOfRangeError(
            context.budgets.max_matches,
            `Total matches exceed the maximum of ${context.budgets.max_matches} matches`,
          ),
        );
      }
      matchedSignatures.push(signature);
    }
  }

  const result = rankMatches(matchedSignatures);
  context.matchCache.set(cacheKey, result);
  context.totalMatches += result.length;
  return ok(result);
};

const processFunctionInput = (
  rawInput: unknown,
  index: number,
  context: FunctionProcessingContext,
): Result<FunctionProcessingOutcome, AnalysisInputError> => {
  const { budgets } = context;
  if (index >= budgets.max_functions) {
    const parsedId = parseFunctionIdWithoutBytes(rawInput, index);
    if (!parsedId.ok) return parsedId;
    return ok({
      kind: "unknown",
      function_id: parsedId.value,
      reason: "function_budget_exceeded",
    });
  }
  const envelope = libraryFunctionInputEnvelopeSchema.safeParse(rawInput);
  if (!envelope.success)
    return err(toInputError(envelope.error, rawInput, [index]));
  const rawBytes = envelope.data.bytes;
  if (Array.isArray(rawBytes) && rawBytes.length > budgets.max_function_bytes)
    return ok({
      kind: "unknown",
      function_id: envelope.data.function_id,
      reason: "function_bytes_budget_exceeded",
    });
  const input = libraryFunctionInputSchema.safeParse(rawInput);
  if (!input.success) return err(toInputError(input.error, rawInput, [index]));
  if (input.data.bytes.length > budgets.max_function_bytes)
    return ok({
      kind: "unknown",
      function_id: input.data.function_id,
      reason: "function_bytes_budget_exceeded",
    });

  const matchesResult = getCandidateMatches(input.data.bytes, context);
  if (!matchesResult.ok) return matchesResult;

  return ok({
    kind: "identified",
    function_id: input.data.function_id,
    matches: matchesResult.value,
  });
};

export const identifyLibraryFunctions = (
  rawFunctions: readonly unknown[],
  rawSignatures: readonly unknown[],
  rawBudgets: unknown = {},
): Result<LibraryFunctionIdentification, AnalysisInputError> => {
  const budgetsResult = parseBudgets(rawBudgets);
  if (!budgetsResult.ok) return budgetsResult;
  const budgets = budgetsResult.value;

  const functionsResult = validateArrayInput(rawFunctions);
  if (!functionsResult.ok) return functionsResult;

  const signaturesInputResult = validateArrayInput(rawSignatures);
  if (!signaturesInputResult.ok) return signaturesInputResult;

  const maxInputFunctions = budgets.max_functions * 2;
  if (rawFunctions.length > maxInputFunctions) {
    return err(
      outOfRangeError(
        maxInputFunctions,
        `Function batch exceeds the maximum of ${maxInputFunctions} functions`,
      ),
    );
  }

  const signaturesResult = compileSignatures(
    signaturesInputResult.value,
    budgets.max_signatures,
  );
  if (!signaturesResult.ok) return signaturesResult;
  const signatures = signaturesResult.value;

  const identified: LibraryFunctionIdentification["identified"] = [];
  const unknowns: LibraryFunctionIdentification["unknowns"] = [];
  const matchCache = new Map<string, readonly LibraryFunctionMatch[]>();
  const context: FunctionProcessingContext = {
    budgets,
    signatures,
    matchCache,
    totalMatches: 0,
    comparisonWork: 0,
  };

  for (let index = 0; index < rawFunctions.length; index++) {
    const outcome = processFunctionInput(rawFunctions[index], index, context);
    if (!outcome.ok) return outcome;
    if (outcome.value.kind === "unknown") {
      unknowns.push({
        function_id: outcome.value.function_id,
        reason: outcome.value.reason,
      });
    } else {
      identified.push({
        function_id: outcome.value.function_id,
        matches: [...outcome.value.matches],
      });
    }
  }

  return ok(
    libraryFunctionIdentificationSchema.parse({ identified, unknowns }),
  );
};
