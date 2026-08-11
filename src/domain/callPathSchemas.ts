import { z } from "zod";

import { evidenceSchema } from "./evidence.js";

const addressSchema = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/u);
const inputAddressSchema = z
  .string()
  .regex(/^0[xX][0-9a-fA-F]+$/u)
  .transform((address) => `0x${BigInt(address).toString(16)}`);

/** Parse a caller-supplied hexadecimal address into canonical form. */
export const parseCallPathAddress = (input: unknown): string =>
  inputAddressSchema.parse(input);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const evidenceGroupSchema = z.union([
  evidenceSchema,
  z.array(evidenceSchema).min(1).max(100),
]);

/** Strict, bounded input for explicit call-path reconstruction. */
export const callPathInputSchema = z
  .object({
    functions: z.array(evidenceGroupSchema).min(1).max(500),
    start: z.object({ address: inputAddressSchema }).strict(),
    goal: z.object({ address: inputAddressSchema }).strict(),
    max_depth: z.number().int().min(0).max(32).default(8),
    max_paths: z.number().int().min(1).max(100).default(10),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(100),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine(({ functions }, context) => {
    const pages = functions.reduce(
      (total, group) => total + (Array.isArray(group) ? group.length : 1),
      0,
    );
    if (pages > 2_000)
      context.addIssue({
        code: "custom",
        message: "Call-path Evidence exceeds 2000 pages",
        path: ["functions"],
      });
  });

const citedNodeSchema = z.object({
  address: addressSchema,
  name: z.string().nullable(),
  evidence_links: z.array(evidenceIdSchema).min(1).max(100),
});
const citedEdgeSchema = z.object({
  source: addressSchema,
  target: addressSchema,
  evidence_links: z.array(evidenceIdSchema).min(1).max(100),
});
const pathSchema = z
  .object({
    hops: z.number().int().min(0),
    nodes: z.array(citedNodeSchema).min(1).max(33),
    edges: z.array(citedEdgeSchema).max(32),
    evidence_links: z.array(evidenceIdSchema).min(1).max(3_300),
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
const searchScopeShape = {
  max_depth: z.number().int().min(0).max(32),
  max_paths: z.number().int().min(1).max(100),
};
const pathPageShape = {
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
};
const pageContextShape = {
  ...pathPageShape,
  items: z.array(pathSchema).max(100),
  returned: z.number().int().min(0).max(100),
  next_offset: z.number().int().min(0).nullable(),
};
const completePathPageSchema = z
  .object({
    ...pageContextShape,
    total: z.number().int().min(1),
    truncated: z.literal(false),
    lower_bound: z.number().int().min(1),
  })
  .superRefine((page, context) => {
    const expectedNext =
      page.offset + page.items.length < page.total
        ? page.offset + page.items.length
        : null;
    if (
      page.returned !== page.items.length ||
      page.lower_bound !== page.total ||
      page.next_offset !== expectedNext
    )
      context.addIssue({
        code: "custom",
        message: "Complete path page counters are inconsistent",
      });
  });
const emptyPathPageSchema = z.object({
  ...pathPageShape,
  items: z.tuple([]),
  total: z.literal(0),
  returned: z.literal(0),
  truncated: z.literal(false),
  lower_bound: z.literal(0),
  next_offset: z.null(),
});
const truncatedPathPageSchema = z
  .object({
    ...pageContextShape,
    total: z.null(),
    truncated: z.literal(true),
    lower_bound: z.number().int().min(0),
  })
  .superRefine((page, context) => {
    if (page.returned !== page.items.length)
      context.addIssue({
        code: "custom",
        message: "Returned path count must equal retained items",
        path: ["returned"],
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
  evidence_links: z.array(evidenceIdSchema).min(1).max(50_000),
  limitations: z.array(z.string()),
};

/** Evidence-cited, bounded directed call-path result. */
export const callPathResultSchema = z.union([
  z.object({
    ...resultContextShape,
    status: z.literal("found"),
    shortest_hops: z.number().int().min(0),
    search_scope: z.object({ ...searchScopeShape, exhaustive: z.boolean() }),
    paths: completePathPageSchema,
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("not_found"),
    shortest_hops: z.null(),
    search_scope: z.object({
      ...searchScopeShape,
      exhaustive: z.literal(true),
    }),
    paths: emptyPathPageSchema,
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("unknown"),
    shortest_hops: z.null(),
    search_scope: z.object({
      ...searchScopeShape,
      exhaustive: z.literal(false),
    }),
    paths: emptyPathPageSchema,
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("truncated"),
    shortest_hops: z.number().int().min(0).nullable(),
    search_scope: z.object({
      ...searchScopeShape,
      exhaustive: z.literal(false),
    }),
    paths: truncatedPathPageSchema,
  }),
]);

export type CallPathEvidenceGroup = z.infer<typeof evidenceGroupSchema>;
export type CallPathInput = z.infer<typeof callPathInputSchema>;
export type CallPathResult = z.infer<typeof callPathResultSchema>;
export type OutputCallPath = z.infer<typeof pathSchema>;
