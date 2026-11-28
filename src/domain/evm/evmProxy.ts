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

const carrierShape = {
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to caller-selected local bytecode carrier",
  ),
  encoding: z
    .enum(["raw", "hex"])
    .describe(
      "Raw bytes or UTF-8 hex with optional 0x prefix and outer ASCII whitespace",
    ),
};

/** Another account's bytecode and recorded slots, claimed by the caller. */
const relatedAccountSchema = z.strictObject({
  ...carrierShape,
  snapshot: evmProxySnapshotSchema,
});

const snapshotKey = ({ chain_id, block, account }: EvmProxySnapshot) =>
  `${String(chain_id)}:${String(block)}:${account.toLowerCase()}`;

export const inspectEvmProxyInputSchema = z
  .strictObject({
    ...carrierShape,
    max_file_bytes: parameterBudgetSchema(
      EVM_PROXY_BUDGETS.max_file_bytes,
    ).describe("Maximum stable bytes read from each carrier (default 4 MiB)"),
    snapshot: evmProxySnapshotSchema
      .optional()
      .describe(
        "Optional recorded ERC-1967 slot values with their chain, block and account",
      ),
    related: z
      .array(relatedAccountSchema)
      .optional()
      .describe(
        "Bytecode and snapshots of other accounts, used to follow inferred edges. Requires snapshot. Only entries with its chain_id and block are followed.",
      ),
  })
  .superRefine(({ snapshot, related }, context) => {
    if (related === undefined) return;
    if (snapshot === undefined) {
      context.addIssue({
        code: "custom",
        path: ["related"],
        message:
          "related requires snapshot, which names the root account, chain and block",
      });
      return;
    }
    const seen = new Set([snapshotKey(snapshot)]);
    for (const [index, entry] of related.entries()) {
      const key = snapshotKey(entry.snapshot);
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["related", index, "snapshot", "account"],
          message:
            "Each account may be supplied once per chain_id and block, including the root",
        });
      seen.add(key);
    }
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

const accountReportShape = {
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: byteCount,
    encoding: z.enum(["raw", "hex"]),
  }),
  bytecode: z.strictObject({ sha256, bytes: byteCount }),
  ...proxyFactShape,
};

/** One edge met while following supplied accounts from the root. */
const chainStepSchema = proxyEdgeSchema.omit({ from: true }).extend({
  source: address,
  status: z.enum(["supplied", "not_supplied", "snapshot_mismatch", "cycle"]),
});
export type EvmProxyChainStep = z.output<typeof chainStepSchema>;

export const evmProxySchema = z.strictObject({
  ...accountReportShape,
  related: z.array(
    z.strictObject({ ...accountReportShape, reached: z.boolean() }),
  ),
  chain: z.array(chainStepSchema),
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

type ProxyFacts = ReturnType<typeof deriveProxyFacts>;
type SnapshotFacts = NonNullable<ProxyFacts["snapshot"]>;

const sameMoment = (left: SnapshotFacts, right: SnapshotFacts) =>
  left.chain_id === right.chain_id && left.block === right.block;

/**
 * Follow inferred edges depth first through supplied accounts of the root's
 * chain and block. Each account is expanded once; an edge back to an account
 * on the current path is a cycle. Iterative, so chain length is unbounded.
 */
export const followProxyChain = (
  root: ProxyFacts,
  related: readonly ProxyFacts[],
) => {
  const chain: EvmProxyChainStep[] = [];
  const reached = related.map(() => false);
  const origin = root.snapshot;
  if (origin === null) return { chain, reached };
  const usable = new Map<string, number>();
  const known = new Set([origin.account]);
  for (const [index, { snapshot }] of related.entries()) {
    if (snapshot === null) continue;
    known.add(snapshot.account);
    if (sameMoment(origin, snapshot)) usable.set(snapshot.account, index);
  }
  const open = new Set([origin.account]);
  const expanded = new Set([origin.account]);
  const stack = [{ account: origin.account, edges: root.edges, next: 0 }];
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    const edge = frame.edges[frame.next++];
    if (edge === undefined) {
      open.delete(frame.account);
      stack.pop();
      continue;
    }
    const { relation, evidence, to } = edge;
    const step = { source: frame.account, relation, evidence, to };
    const index = usable.get(to);
    if (open.has(to)) chain.push({ ...step, status: "cycle" });
    else if (index === undefined && to !== origin.account)
      chain.push({
        ...step,
        status: known.has(to) ? "snapshot_mismatch" : "not_supplied",
      });
    else {
      chain.push({ ...step, status: "supplied" });
      const target = index === undefined ? undefined : related[index];
      if (index === undefined || target === undefined || expanded.has(to))
        continue;
      reached[index] = true;
      expanded.add(to);
      open.add(to);
      stack.push({ account: to, edges: target.edges, next: 0 });
    }
  }
  return { chain, reached };
};
