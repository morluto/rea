import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";
import {
  solidityMetadataSchema,
  type SolidityMetadata,
} from "./solidityMetadata.js";

/** The per-call budgets of `verify_solidity_metadata`. */
const BINDING_BUDGETS = {
  max_file_bytes: {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default_value: 4 * 1024 * 1024,
    unit: "bytes",
  },
  max_metadata_bytes: {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default_value: 16 * 1024 * 1024,
    unit: "bytes",
  },
} as const satisfies Record<string, ParameterBudget>;
export type SolidityMetadataBudget = keyof typeof BINDING_BUDGETS;

/** The per-call budget that stopped a metadata verification. */
export const solidityMetadataBudgetLimit =
  parameterBudgetLimitFor(BINDING_BUDGETS);

export const verifySolidityMetadataInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to caller-selected local bytecode carrier",
  ),
  encoding: z
    .enum(["raw", "hex"])
    .describe(
      "Raw bytes or UTF-8 hex with optional 0x prefix and outer ASCII whitespace",
    ),
  metadata_path: absoluteLocalPathStringSchema.describe(
    "Absolute path to the caller-selected metadata JSON file, byte for byte as the compiler emitted it",
  ),
  max_file_bytes: parameterBudgetSchema(
    BINDING_BUDGETS.max_file_bytes,
  ).describe("Maximum bytecode carrier bytes to read (default 4 MiB)"),
  max_metadata_bytes: parameterBudgetSchema(
    BINDING_BUDGETS.max_metadata_bytes,
  ).describe("Maximum metadata file bytes to read (default 16 MiB)"),
});
export type VerifySolidityMetadataInput = z.output<
  typeof verifySolidityMetadataInputSchema
>;

const SCHEMES = ["ipfs", "bzzr0", "bzzr1"] as const;
const hex = z.string().regex(/^(?:[a-f0-9]{2})*$/);

const bindingSchema = z.strictObject({
  status: z.enum(["match", "mismatch", "unverified"]),
  reason: z
    .enum([
      "no_decoded_trailer",
      "no_commitment",
      "multiple_commitments",
      "unsupported_scheme",
      "unrecognized_commitment",
      "metadata_exceeds_admitted_size",
    ])
    .nullable(),
  scheme: z.enum(SCHEMES).nullable(),
  recorded: hex.nullable(),
  computed: hex.nullable(),
});
export type SolidityMetadataBinding = z.output<typeof bindingSchema>;

/**
 * Compare the one commitment a decoded trailer records with the supplied
 * file's hash. Anything that cannot be compared stays unverified.
 */
export const bindMetadataCommitment = (
  trailer: SolidityMetadata,
  ipfsMultihash: () => Uint8Array | undefined,
): SolidityMetadataBinding => {
  const unverified = (
    reason: NonNullable<SolidityMetadataBinding["reason"]>,
    scheme: SolidityMetadataBinding["scheme"] = null,
    recorded: string | null = null,
  ): SolidityMetadataBinding => ({
    status: "unverified",
    reason,
    scheme,
    recorded,
    computed: null,
  });
  if (trailer.status !== "decoded" && trailer.status !== "partial")
    return unverified("no_decoded_trailer");
  const commitments = trailer.entries.flatMap(({ key, value }) => {
    const scheme = SCHEMES.find(
      (name) => key.kind === "text" && key.value === name,
    );
    return scheme === undefined ? [] : [{ scheme, value }];
  });
  const [commitment, ...others] = commitments;
  if (commitment === undefined) return unverified("no_commitment");
  if (others.length > 0) return unverified("multiple_commitments");
  const { scheme, value } = commitment;
  const recorded = value.kind === "bytes" ? value.value : null;
  if (scheme !== "ipfs")
    return unverified("unsupported_scheme", scheme, recorded);
  // A sha2-256 multihash: code 0x12, length 32, digest.
  if (recorded === null || !/^1220[a-f0-9]{64}$/u.test(recorded))
    return unverified("unrecognized_commitment", scheme, recorded);
  const hash = ipfsMultihash();
  if (hash === undefined)
    return unverified("metadata_exceeds_admitted_size", scheme, recorded);
  const computed = Buffer.from(hash).toString("hex");
  return {
    status: computed === recorded ? "match" : "mismatch",
    reason: null,
    scheme,
    recorded,
    computed,
  };
};

const byteCount = z.int().nonnegative();
const fileShape = {
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: byteCount,
};

export const solidityMetadataVerificationSchema = z.strictObject({
  artifact: z.strictObject({
    ...fileShape,
    encoding: z.enum(["raw", "hex"]),
  }),
  bytecode: z.strictObject({ sha256: fileShape.sha256, bytes: byteCount }),
  metadata_file: z.strictObject(fileShape),
  trailer: solidityMetadataSchema,
  binding: bindingSchema,
  limitations: z.array(z.string()),
});
export type SolidityMetadataVerification = z.output<
  typeof solidityMetadataVerificationSchema
>;

/** Files fully read before a later read or decode failed; no binding claim. */
export interface SolidityMetadataPartialObservation {
  readonly kind: "solidity-metadata-files";
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
}
