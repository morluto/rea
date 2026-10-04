import { z } from "zod";

import { evidenceSchema } from "./evidence.js";

const addressSchema = z
  .string()
  .regex(/^(?:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+:)?0x(?:0|[1-9a-f][0-9a-f]*)$/u);
const inputAddressSchema = z
  .string()
  .regex(/^(?:(?:[A-Za-z0-9._~-]|%[0-9a-fA-F]{2})+:)?0[xX][0-9a-fA-F]+$/u)
  .transform((address) => {
    const separator = address.lastIndexOf(":") + 1;
    const space = address
      .slice(0, separator)
      .replace(/%[0-9a-fA-F]{2}/gu, (escape) => escape.toUpperCase());
    return `${space}0x${BigInt(address.slice(separator)).toString(16)}`;
  });
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);

/** Normalize a hexadecimal offset while preserving its optional address space. */
export const parseCallPathAddress = (input: unknown): string =>
  inputAddressSchema.parse(input);

/** Strict input for explicit call-path reconstruction from complete dossiers. */
export const callPathInputSchema = z.object({
  functions: z.array(evidenceSchema).min(1),
  start: z.object({ address: inputAddressSchema }).strict(),
  goal: z.object({ address: inputAddressSchema }).strict(),
});

const citedNodeSchema = z.object({
  address: addressSchema,
  name: z.string().nullable(),
  evidence_links: z.array(evidenceIdSchema).min(1),
});
const citedEdgeSchema = z.object({
  source: addressSchema,
  target: addressSchema,
  evidence_links: z.array(evidenceIdSchema).min(1),
});
const pathSchema = z
  .object({
    hops: z.number().int().min(0),
    nodes: z.array(citedNodeSchema).min(1),
    edges: z.array(citedEdgeSchema),
    evidence_links: z.array(evidenceIdSchema).min(1),
  })
  .superRefine((path, context) => {
    const edgesConnectNodes = path.edges.every(
      (edge, index) =>
        edge.source === path.nodes[index]?.address &&
        edge.target === path.nodes[index + 1]?.address,
    );
    if (
      path.hops !== path.edges.length ||
      path.nodes.length !== path.edges.length + 1 ||
      !edgesConnectNodes
    )
      context.addIssue({
        code: "custom",
        message: "Path hops and edges must connect the ordered nodes",
      });
  });
const resultContextShape = {
  start: addressSchema,
  goal: addressSchema,
  explored: z.object({
    nodes: z.number().int().min(0),
    edges: z.number().int().min(0),
    depth_reached: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1),
  limitations: z.array(z.string()),
};

/** Evidence-cited directed call-path result containing every shortest path. */
export const callPathResultSchema = z.union([
  z.object({
    ...resultContextShape,
    status: z.literal("found"),
    shortest_hops: z.number().int().min(0),
    search_scope: z.object({ exhaustive: z.boolean() }),
    paths: z.array(pathSchema).min(1),
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("not_found"),
    shortest_hops: z.null(),
    search_scope: z.object({ exhaustive: z.literal(true) }),
    paths: z.tuple([]),
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("unknown"),
    shortest_hops: z.null(),
    search_scope: z.object({ exhaustive: z.literal(false) }),
    paths: z.tuple([]),
  }),
]);

export type CallPathInput = z.infer<typeof callPathInputSchema>;
export type CallPathResult = z.infer<typeof callPathResultSchema>;
export type OutputCallPath = z.infer<typeof pathSchema>;
