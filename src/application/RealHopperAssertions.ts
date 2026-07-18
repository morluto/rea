import { z } from "zod";

const addressSchema = z.string().regex(/^0x[0-9a-f]+$/iu);
const identitySchema = z.object({ address: addressSchema, name: z.string() });
const collectionSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().min(0).nullable(),
  returned: z.number().int().min(0),
  truncated: z.boolean(),
  next_offset: z.number().int().min(0).nullable(),
});

/** Extract a real address from the provider's exact procedure page. */
export const firstProcedureAddress = (input: unknown): string => {
  const page = z
    .object({
      items: z.array(z.object({ address: addressSchema })).min(1),
      offset: z.number().int().min(0),
      limit: z.number().int().min(1),
      total: z.number().int().min(1),
      next_offset: z.number().int().min(0).nullable(),
      has_more: z.boolean(),
    })
    .parse(input);
  const first = page.items[0];
  if (first === undefined) throw new TypeError("Procedure page was empty");
  return first.address;
};

/** Reject two target paths that resolve to the same binary content. */
export const requireDistinctTargetHashes = (
  firstHash: unknown,
  secondHash: unknown,
): void => {
  if (
    typeof firstHash !== "string" ||
    typeof secondHash !== "string" ||
    firstHash.length === 0 ||
    secondHash.length === 0
  ) {
    throw new TypeError("Target hashes must be non-empty strings");
  }
  if (firstHash === secondHash)
    throw new TypeError("Real-Hopper verification requires distinct binaries");
};

/** Reject empty and success-shaped embedded decompilation failures. */
export const requirePseudocode = (
  input: unknown,
  operation: string,
): string => {
  if (typeof input !== "string" || input.trim().length === 0)
    throw new TypeError(`${operation} returned empty pseudocode`);
  if (input === "No output" || input.startsWith("Error:"))
    throw new TypeError(`${operation} returned an embedded failure: ${input}`);
  return input;
};

/** Validate an exact bounded Hopper function dossier semantically. */
export const requireFunctionDossier = (
  input: unknown,
  expectedAddress: string,
): Record<string, unknown> => {
  const value = objectValue(
    input,
    "analyze_function returned no function dossier",
  );
  const procedure = identitySchema.parse(value.procedure);
  if (procedure.address !== expectedAddress)
    throw new TypeError("analyze_function returned the wrong procedure");
  if (procedure.name.trim().length === 0)
    throw new TypeError("analyze_function omitted the procedure name");
  validatePseudocodeBounds(value.pseudocode);
  for (const field of COLLECTION_FIELDS)
    validateCollection(value[field], field);
  for (const field of ["callers", "callees"] as const)
    z.array(identitySchema).parse(collectionSchema.parse(value[field]).items);
  validateBlocks(collectionSchema.parse(value.basic_blocks).items);
  validateInstructionScan(value.instruction_scan);
  return value;
};

/** Positive semantic facts required from one source-owned Hopper fixture. */
export interface FunctionDossierOracle {
  readonly procedure_address: string;
  readonly callee_address?: string;
  readonly caller_address?: string;
  readonly referenced_string?: string;
  readonly referenced_name?: string;
  readonly comment?: string;
  readonly require_cfg_successor?: boolean;
  readonly require_assembly?: boolean;
}

/** Reject a structurally valid dossier that omits fixture-proven semantics. */
export const requireFunctionDossierOracle = (
  input: unknown,
  oracle: FunctionDossierOracle,
): Record<string, unknown> => {
  const value = requireFunctionDossier(input, oracle.procedure_address);
  if (oracle.callee_address !== undefined) {
    const callees = z
      .array(identitySchema)
      .parse(collectionSchema.parse(value.callees).items);
    if (!callees.some(({ address }) => address === oracle.callee_address))
      throw new TypeError(
        "analyze_function omitted the expected fixture callee",
      );

    const references = z
      .array(
        z.object({
          source_address: addressSchema,
          target_address: addressSchema,
        }),
      )
      .parse(collectionSchema.parse(value.outgoing_references).items);
    if (
      !references.some(
        ({ target_address }) => target_address === oracle.callee_address,
      )
    )
      throw new TypeError(
        "analyze_function omitted the expected fixture reference",
      );
  }

  if (oracle.caller_address !== undefined) {
    const callers = z
      .array(identitySchema)
      .parse(collectionSchema.parse(value.callers).items);
    if (!callers.some(({ address }) => address === oracle.caller_address))
      throw new TypeError(
        "analyze_function omitted the expected fixture caller",
      );
  }

  if (oracle.referenced_string !== undefined)
    requireReferencedValue(
      value,
      "referenced_strings",
      oracle.referenced_string,
      (candidate) => candidate,
    );

  if (oracle.referenced_name !== undefined)
    requireReferencedValue(
      value,
      "referenced_names",
      oracle.referenced_name,
      (candidate) => candidate.replace(/^_+/u, ""),
    );

  if (oracle.comment !== undefined) {
    const comments = z
      .array(
        z.object({
          address: addressSchema,
          kind: z.enum(["comment", "inline"]),
          text: z.string(),
        }),
      )
      .parse(collectionSchema.parse(value.comments).items);
    if (
      !comments.some(
        ({ address, kind, text }) =>
          address === oracle.procedure_address &&
          kind === "comment" &&
          text === oracle.comment,
      )
    )
      throw new TypeError("analyze_function omitted the verifier comment");
  }

  if (
    oracle.require_assembly === true &&
    collectionSchema.parse(value.assembly).items.length === 0
  )
    throw new TypeError("analyze_function omitted fixture assembly");

  if (oracle.require_cfg_successor) {
    const blocks = z
      .array(z.object({ successors: z.array(addressSchema) }))
      .parse(collectionSchema.parse(value.basic_blocks).items);
    if (!blocks.some(({ successors }) => successors.length > 0))
      throw new TypeError("analyze_function omitted a real CFG successor");
  }
  return value;
};

const referencedValueSchema = z.object({
  address: addressSchema,
  value: z.string(),
  source_address: addressSchema,
});

const referenceEdgeSchema = z.object({
  source_address: addressSchema,
  target_address: addressSchema,
});

const requireReferencedValue = (
  dossier: Record<string, unknown>,
  field: "referenced_strings" | "referenced_names",
  expected: string,
  normalize: (value: string) => string,
): void => {
  const values = z
    .array(referencedValueSchema)
    .parse(collectionSchema.parse(dossier[field]).items);
  const references = z
    .array(referenceEdgeSchema)
    .parse(collectionSchema.parse(dossier.outgoing_references).items);
  const found = values.some(
    ({ address, value, source_address: sourceAddress }) =>
      normalize(value) === expected &&
      references.some(
        ({ source_address, target_address }) =>
          source_address === sourceAddress && target_address === address,
      ),
  );
  if (!found)
    throw new TypeError(
      `analyze_function omitted the expected fixture ${field === "referenced_strings" ? "string" : "name"}`,
    );
};

/** Require every relationship to be an actual hexadecimal address. */
export const requireAddressArray = (
  input: unknown,
  operation: string,
): string[] => {
  const parsed = z.array(addressSchema).parse(input);
  if (parsed.some((address) => address.length === 0))
    throw new TypeError(`${operation} returned an invalid address list`);
  return parsed;
};

const COLLECTION_FIELDS = [
  "assembly",
  "comments",
  "callers",
  "callees",
  "incoming_references",
  "outgoing_references",
  "referenced_strings",
  "referenced_names",
  "basic_blocks",
] as const;

const validatePseudocodeBounds = (input: unknown): void => {
  const pseudocode = z
    .object({
      text: z.string(),
      returned_chars: z.number().int().min(0),
      total_chars: z.number().int().min(0),
    })
    .parse(input);
  const text = requirePseudocode(pseudocode.text, "analyze_function");
  if (
    pseudocode.returned_chars !== [...text].length ||
    pseudocode.total_chars < pseudocode.returned_chars
  )
    throw new TypeError(
      "analyze_function returned inconsistent pseudocode bounds",
    );
};

const validateCollection = (input: unknown, field: string): void => {
  const collection = collectionSchema.parse(input);
  if (collection.returned !== collection.items.length)
    throw new TypeError(`analyze_function returned an invalid ${field} result`);
};

const validateBlocks = (items: readonly unknown[]): void => {
  for (const block of items)
    if (!Array.isArray(objectValue(block, "Invalid basic block").successors))
      throw new TypeError("analyze_function omitted CFG successor evidence");
};

const validateInstructionScan = (input: unknown): void => {
  const scan = z
    .object({ scanned: z.number().int().min(0), truncated: z.boolean() })
    .parse(input);
  if (scan.scanned === 0 && !scan.truncated)
    throw new TypeError(
      "analyze_function omitted instruction scan limitations",
    );
};

const objectValue = (
  input: unknown,
  message: string,
): Record<string, unknown> => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(input);
  if (!parsed.success) throw new TypeError(message);
  return parsed.data;
};
