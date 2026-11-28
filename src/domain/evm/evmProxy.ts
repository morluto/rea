import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

/** The per-call budgets of `inspect_evm_proxy`. */
const EVM_PROXY_BUDGETS = {
  max_file_bytes: {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default_value: 4 * 1024 * 1024,
    unit: "bytes",
  },
} as const satisfies Record<string, ParameterBudget>;

/** The per-call budget that stopped a proxy inspection. */
export const evmProxyBudgetLimit = parameterBudgetLimitFor(EVM_PROXY_BUDGETS);

/** ERC-1967 storage positions: keccak256("eip1967.proxy.<name>") - 1. */
const ERC1967_SLOTS = {
  implementation:
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;

const suppliedAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const suppliedWord = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);

/** Storage words the caller recorded; REA neither fetches nor verifies them. */
export const evmProxySnapshotSchema = z.strictObject({
  chain_id: z.int().positive().describe("Chain the values were recorded on"),
  block: z.int().nonnegative().describe("Block number of the recorded values"),
  account: suppliedAddress.describe("Account whose storage was recorded"),
  slots: z
    .strictObject({
      implementation: suppliedWord.optional(),
      admin: suppliedWord.optional(),
      beacon: suppliedWord.optional(),
    })
    .describe(
      "32-byte ERC-1967 words. Omit a slot that was not recorded; omission means unavailable, not zero.",
    ),
});
export type EvmProxySnapshot = z.output<typeof evmProxySnapshotSchema>;

export const inspectEvmProxyInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to caller-selected local bytecode carrier",
  ),
  encoding: z
    .enum(["raw", "hex"])
    .describe(
      "Raw bytes or UTF-8 hex with optional 0x prefix and outer ASCII whitespace",
    ),
  max_file_bytes: parameterBudgetSchema(
    EVM_PROXY_BUDGETS.max_file_bytes,
  ).describe("Maximum stable carrier bytes to read (default 4 MiB)"),
  snapshot: evmProxySnapshotSchema
    .optional()
    .describe(
      "Optional recorded ERC-1967 slot values with their chain, block and account",
    ),
});
export type InspectEvmProxyInput = z.output<typeof inspectEvmProxyInputSchema>;

const byteCount = z.int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const proxyPatternSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("erc1167"),
    implementation: z.string().regex(/^0x[0-9a-f]{40}$/),
    implementation_byte_range: z.strictObject({
      start: byteCount,
      end: byteCount,
    }),
  }),
  z.strictObject({ kind: z.literal("none_recognized") }),
]);
export type EvmProxyPattern = z.output<typeof proxyPatternSchema>;

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const word = z.string().regex(/^0x[0-9a-f]{64}$/);
const proxySlotSchema = z.discriminatedUnion("status", [
  z.strictObject({ slot: word, status: z.literal("unavailable") }),
  z.strictObject({ slot: word, status: z.literal("zero"), value: word }),
  z.strictObject({
    slot: word,
    status: z.literal("address"),
    value: word,
    address,
  }),
  z.strictObject({
    slot: word,
    status: z.literal("not_an_address"),
    value: word,
  }),
]);
export type EvmProxySlot = z.output<typeof proxySlotSchema>;

/** An inferred relationship; `from` is null when no account is established. */
const proxyEdgeSchema = z.strictObject({
  relation: z.enum(["implementation", "beacon"]),
  evidence: z.enum([
    "erc1167_bytecode",
    "erc1967_implementation_slot",
    "erc1967_beacon_slot",
  ]),
  from: address.nullable(),
  to: address,
});
export type EvmProxyEdge = z.output<typeof proxyEdgeSchema>;

const proxyFactShape = {
  pattern: proxyPatternSchema,
  snapshot: z
    .strictObject({ chain_id: z.int(), block: z.int(), account: address })
    .nullable(),
  slots: z.strictObject({
    implementation: proxySlotSchema,
    admin: proxySlotSchema,
    beacon: proxySlotSchema,
  }),
  edges: z.array(proxyEdgeSchema),
};

export const evmProxySchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: byteCount,
    encoding: z.enum(["raw", "hex"]),
  }),
  bytecode: z.strictObject({ sha256, bytes: byteCount }),
  ...proxyFactShape,
  limitations: z.array(z.string()),
});
export type EvmProxy = z.output<typeof evmProxySchema>;

/** ERC-1167 runtime: fixed prefix, 20-byte target, fixed suffix. */
const ERC1167_PREFIX = Buffer.from("363d3d373d3d3d363d73", "hex");
const ERC1167_SUFFIX = Buffer.from("5af43d82803e903d91602b57fd5bf3", "hex");
const ADDRESS_BYTES = 20;

/** Match only the exact 45-byte standard clone; variants stay unrecognized. */
export const matchErc1167Clone = (code: Uint8Array): EvmProxyPattern => {
  const start = ERC1167_PREFIX.length;
  const end = start + ADDRESS_BYTES;
  // Rule out by length first so large inputs are not copied.
  if (code.length !== end + ERC1167_SUFFIX.length)
    return { kind: "none_recognized" };
  const bytes = Buffer.from(code);
  if (
    !bytes.subarray(0, start).equals(ERC1167_PREFIX) ||
    !bytes.subarray(end).equals(ERC1167_SUFFIX)
  )
    return { kind: "none_recognized" };
  return {
    kind: "erc1167",
    implementation: `0x${bytes.subarray(start, end).toString("hex")}`,
    implementation_byte_range: { start, end },
  };
};

const readSlot = (slot: string, supplied: string | undefined): EvmProxySlot => {
  if (supplied === undefined) return { slot, status: "unavailable" };
  const value = supplied.toLowerCase();
  const digits = value.slice(2);
  if (/^0+$/u.test(digits)) return { slot, status: "zero", value };
  const addressStart = digits.length - ADDRESS_BYTES * 2;
  if (!/^0+$/u.test(digits.slice(0, addressStart)))
    return { slot, status: "not_an_address", value };
  return {
    slot,
    status: "address",
    value,
    address: `0x${digits.slice(addressStart)}`,
  };
};

/**
 * Facts for one account's bytecode and recorded slots. The admin is reported
 * but is no delegation edge. A bytecode match is not bound to the account.
 */
export const deriveProxyFacts = (
  code: Uint8Array,
  snapshot: EvmProxySnapshot | undefined,
) => {
  const pattern = matchErc1167Clone(code);
  const account = snapshot?.account.toLowerCase();
  const slots = {
    implementation: readSlot(
      ERC1967_SLOTS.implementation,
      snapshot?.slots.implementation,
    ),
    admin: readSlot(ERC1967_SLOTS.admin, snapshot?.slots.admin),
    beacon: readSlot(ERC1967_SLOTS.beacon, snapshot?.slots.beacon),
  };
  const edges: EvmProxyEdge[] = [];
  if (pattern.kind === "erc1167")
    edges.push({
      relation: "implementation",
      evidence: "erc1167_bytecode",
      from: null,
      to: pattern.implementation,
    });
  for (const relation of ["implementation", "beacon"] as const) {
    const slot = slots[relation];
    if (account !== undefined && slot.status === "address")
      edges.push({
        relation,
        evidence: `erc1967_${relation}_slot`,
        from: account,
        to: slot.address,
      });
  }
  return {
    pattern,
    snapshot:
      snapshot === undefined || account === undefined
        ? null
        : { chain_id: snapshot.chain_id, block: snapshot.block, account },
    slots,
    edges,
  };
};
